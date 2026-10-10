import { z } from "zod";
import Decimal from "decimal.js";
import { requireBaseUnit, UnitNotBelongingToProductError } from "./base-unit";
import {
    costFromTotal,
    getUnitConversionFactor,
    toBaseUnit,
    InvalidCostInputError,
    // [Batch cost entry] The ONE shared 8dp pattern — see its own note in
    // units.ts. Imported rather than re-declared here so the creation helper,
    // the correction route and the correction form cannot drift.
    COST_PER_BASE_UNIT_REGEX,
    AMOUNT_REGEX,
    MAX_COST_PER_BASE_UNIT,
} from "./units";
import { constructBatchNumber, parseBatchNumber } from "./batch-number";
import { isRealCalendarDate } from "./date-utils";
import { findProductUnitById } from "@/lib/data/products";
import { multiplyMoney, serializeMoney } from "@/lib/utils/money";
import type { TxOrClient } from "@/lib/db/tenant-scope";

// [FIX — one class, not two] UnitNotBelongingToProductError lives ONLY in
// base-unit.ts; this re-export keeps every existing import from
// "@/lib/inventory/batch-creation" working unchanged.
export { UnitNotBelongingToProductError };

// [FIX] isRealCalendarDate now lives in date-utils.ts so batch-number.ts can
// use it without a circular import. Re-exported so existing imports keep working.
export { isRealCalendarDate };

export class InactiveEntryUnitError extends Error {
    readonly code = "ENTRY_UNIT_INACTIVE";
    constructor(unitId: string) {
        super(`الوحدة المحددة (${unitId}) متوقفة ولا يمكن الاستلام بها.`);
        this.name = "InactiveEntryUnitError";
    }
}

export class InvalidBatchNumberError extends Error {
    readonly code = "INVALID_BATCH_NUMBER";
    constructor(message: string) {
        super(message);
        this.name = "InvalidBatchNumberError";
    }
}

export class InvalidExpiryDateError extends Error {
    readonly code = "INVALID_EXPIRY_DATE";
    constructor(message = "تاريخ الانتهاء غير صالح.") {
        super(message);
        this.name = "InvalidExpiryDateError";
    }
}

// ---------------------------------------------------------------------------
// Shared input rules — every batch-creating route imports these instead of
// re-declaring its own copy, so the rules cannot drift between screens.
// ---------------------------------------------------------------------------

export const expiryDateSchema = z
    .string()
    .optional()
    .nullable()
    .refine((val) => !val || /^\d{4}-\d{2}-\d{2}$/.test(val), {
        message: "تاريخ الانتهاء يجب أن يكون بالصيغة YYYY-MM-DD (مثال: 2026-12-31).",
    })
    .refine((val) => !val || isRealCalendarDate(val), {
        message: "تاريخ الانتهاء غير صالح.",
    });

export const BATCH_NUMBER_SUFFIX_MAX_LENGTH = 50;

// Non-empty, bounded, and free of control characters (newlines would also
// break parseBatchNumber(), whose `.` does not match them).
export const batchNumberSuffixSchema = z
    .string()
    .trim()
    .min(1, "الجزء الخاص برقم الدفعة مطلوب ولا يمكن أن يكون فارغاً.")
    .max(
        BATCH_NUMBER_SUFFIX_MAX_LENGTH,
        `الجزء الخاص برقم الدفعة طويل جداً (الحد الأقصى ${BATCH_NUMBER_SUFFIX_MAX_LENGTH} حرفاً).`
    )
    .regex(/^[^\u0000-\u001f\u007f]+$/, "رقم الدفعة لا يمكن أن يحتوي على أسطر جديدة أو رموز تحكم.");

// ---------------------------------------------------------------------------
// Numeric guards — the DB columns are Decimal(18,4) for quantity and
// Decimal(18,8) for cost per base unit. Both cost paths go through these.
// ---------------------------------------------------------------------------

// AMOUNT_REGEX (Decimal(18,4)), COST_PER_BASE_UNIT_REGEX (Decimal(18,8)) and
// MAX_COST_PER_BASE_UNIT all live in units.ts and are imported above — one
// definition each, so no two files can drift.
const MAX_BASE_QUANTITY = new Decimal("99999999999999.9999");
// [v4.7, overflow guard] ProductBatch.totalCostSYP is Decimal(18,4) too. The
// interactive path can never exceed this (its typed total is already bounded
// by AMOUNT_REGEX), but the CSV path MULTIPLIES two independently-bounded
// values (costPrice up to 18,8 x baseQuantity up to 18,4) and the product can
// reach 24 integer digits — a raw Postgres overflow (500) without this check.
const MAX_TOTAL_COST_SYP = new Decimal("99999999999999.9999");

function requirePositiveAmount(value: string, message: string): string {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!AMOUNT_REGEX.test(trimmed) || !new Decimal(trimmed).gt(0)) {
        throw new InvalidCostInputError(message);
    }
    return trimmed;
}

function requireCostPerBaseUnit(value: string): string {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!COST_PER_BASE_UNIT_REGEX.test(trimmed) || !new Decimal(trimmed).gt(0)) {
        throw new InvalidCostInputError(
            "سعر الوحدة الأساسية يجب أن يكون رقماً موجباً (حتى 8 خانات عشرية)."
        );
    }
    // Kept verbatim (not re-formatted): CSV behaviour is byte-identical to
    // what it was before total-cost entry existed.
    return trimmed;
}

function assertBaseQuantityInRange(baseQuantity: string): void {
    if (new Decimal(baseQuantity).gt(MAX_BASE_QUANTITY)) {
        throw new InvalidCostInputError(
            "الكمية بعد التحويل إلى الوحدة الأساسية كبيرة جداً — تحقق من الكمية."
        );
    }
}

// [v4.7, overflow guard] Every decimal column a batch writes is range-checked
// AFTER the interactive/CSV branch, so BOTH paths pass the same three guards
// and a violation is always an InvalidCostInputError with a clear Arabic
// reason — never a raw Postgres numeric-overflow 500. On the CSV path the
// error is caught per-row by commitCsvImport and reported in the import
// report; on the interactive paths the routes map it to a 400.
function assertTotalCostSypInRange(totalCostSYP: string): void {
    if (new Decimal(totalCostSYP).gt(MAX_TOTAL_COST_SYP)) {
        throw new InvalidCostInputError(
            "إجمالي تكلفة السطر كبير جداً (الحد الأقصى 99999999999999.9999 ل.س) — راجع سعر التكلفة والكمية."
        );
    }
}

function assertCostPricePerBaseUnitInRange(perBaseUnit: string): void {
    if (new Decimal(perBaseUnit).gt(MAX_COST_PER_BASE_UNIT)) {
        throw new InvalidCostInputError(
            "سعر تكلفة الوحدة الأساسية كبير جداً (الحد الأقصى 9999999999.99999999) — راجع القيم المدخلة."
        );
    }
}

// Values the server derives itself — a client that sends any of them is
// rejected outright (never silently ignored).
const CLIENT_COMPUTED_BATCH_FIELDS = [
    "costPricePerBaseUnit",
    "conversionFactor",
    "baseQuantity",
    "perBaseUnit",
    // [v4.7] Receipt-history fields — a client may never forge these. The
    // receipt linkage comes from the receiving gateway only, and the two
    // write-once snapshots exist solely to be set at creation time.
    "receiptId",
    "initialQuantity",
    "totalCostSYP",
] as const;

export function findClientComputedBatchField(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    return CLIENT_COMPUTED_BATCH_FIELDS.find((key) => record[key] !== undefined) ?? null;
}

interface CreateBatchRowBase {
    tenantId: string;
    /**
     * [v4.7] REQUIRED — the ProductReceipt this batch belongs to.
     * createBatchRow NEVER creates a receipt itself: only the receiving
     * gateway (lib/inventory/receiving.ts's createReceiptWithBatches()) does.
     * Every caller obtains this id from that gateway inside the same
     * transaction (the gateway creates the receipt first, unless the caller
     * passed existingReceiptId — the CSV import's one-receipt-per-file case).
     */
    receiptId: string;
    productId: string;
    /** The purchase unit the ADMIN typed quantity (and total cost) in. */
    entryUnitId: string;
    /** Decimal STRING, in `entryUnitId`. */
    quantityInEntryUnit: string;
    expiryDate?: string | Date | null;
}

// Exactly one of the two batch-number inputs:
//  - batchNumberSuffix: the helper builds "{server-date}-{suffix}" itself.
//  - batchNumber: an ALREADY constructed value, for a caller that must share
//    one date prefix across several rows (the multi-product receipt builds it
//    once with constructBatchNumber()). Its format is re-verified here, so a
//    blank or malformed value can never be stored.
type BatchNumberInput =
    | { batchNumber: string; batchNumberSuffix?: undefined }
    | { batchNumberSuffix: string; batchNumber?: undefined };

// Exactly one of the two cost inputs:
//  - totalCost: what the merchant paid for the WHOLE received quantity (UI screens).
//  - costPricePerBaseUnit: already per base unit (CSV, product-creation initialBatch).
type CostInput =
    | { totalCost: string; costPricePerBaseUnit?: undefined }
    | { costPricePerBaseUnit: string; totalCost?: undefined };

export type CreateBatchRowInput = CreateBatchRowBase & BatchNumberInput & CostInput;

export interface CreatedBatchRow {
    /** [v4.7] The receipt this batch was written under. */
    receiptId: string;
    batchId: string;
    batchNumber: string;
    resolvedBaseUnitId: string;
    resolvedBaseUnitName: string;
    baseQuantity: string;
    /** Exactly what was stored (scale 8), decimal string. */
    costPricePerBaseUnit: string;
    /**
     * [v4.7] The TOTAL paid for this line, in SYP (Decimal(18,4) string):
     * exactly the merchant-typed total on the interactive paths, or
     * costPricePerBaseUnit x baseQuantity (rounded ONCE to 4 dp) on the CSV
     * path.
     */
    totalCostSYP: string;
    enteredUnitName: string;
}

function resolveBatchNumber(input: {
    batchNumber?: string;
    batchNumberSuffix?: string;
}): string {
    const hasFull = input.batchNumber !== undefined;
    const hasSuffix = input.batchNumberSuffix !== undefined;
    if (hasFull === hasSuffix) {
        throw new Error(
            "createBatchRow: pass exactly one of `batchNumber` (already constructed) or `batchNumberSuffix`."
        );
    }
    if (hasFull) {
        if (!parseBatchNumber(input.batchNumber as string)) {
            throw new InvalidBatchNumberError(
                "رقم الدفعة غير صالح — الصيغة المطلوبة: YYYY-MM-DD-نص."
            );
        }
        return input.batchNumber as string;
    }
    // [FIX] Same rules as the routes (non-empty, max length, no control
    // characters) — enforced here too so CSV / product-creation callers,
    // which do not go through a route schema, cannot bypass them.
    const parsed = batchNumberSuffixSchema.safeParse(input.batchNumberSuffix);
    if (!parsed.success) {
        throw new InvalidBatchNumberError(parsed.error.issues[0]?.message ?? "رقم الدفعة غير صالح.");
    }
    return constructBatchNumber(parsed.data);
}

// [FIX] The helper no longer trusts its caller to have validated the date.
// "2026-02-31" is rejected instead of silently rolling over to 2026-03-03.
function resolveExpiry(expiryDate: string | Date | null | undefined): Date | null {
    if (expiryDate === null || expiryDate === undefined || expiryDate === "") return null;
    if (expiryDate instanceof Date) {
        if (Number.isNaN(expiryDate.getTime())) throw new InvalidExpiryDateError();
        return expiryDate;
    }
    const parsed = expiryDateSchema.safeParse(expiryDate);
    if (!parsed.success) {
        throw new InvalidExpiryDateError(parsed.error.issues[0]?.message);
    }
    return new Date(expiryDate);
}

export async function createBatchRow(
    tx: TxOrClient,
    input: CreateBatchRowInput
): Promise<CreatedBatchRow> {
    const { tenantId, productId, entryUnitId } = input;

    // Cheap, DB-free validation first — nothing below touches the database
    // until every input is known to be well-formed.
    const finalBatchNumber = resolveBatchNumber(input);
    if (input.totalCost !== undefined && input.costPricePerBaseUnit !== undefined) {
        throw new InvalidCostInputError(
            "لا يمكن تمرير إجمالي التكلفة وسعر الوحدة الأساسية معاً."
        );
    }
    const expiry = resolveExpiry(input.expiryDate);
    const quantityInEntryUnit = requirePositiveAmount(
        input.quantityInEntryUnit,
        "الكمية يجب أن تكون رقماً موجباً (حتى 4 خانات عشرية)."
    );
    const totalCost =
        input.totalCost !== undefined
            ? requirePositiveAmount(
                input.totalCost,
                "لا يمكن قبول سطر بتكلفة صفر — إجمالي تكلفة الشراء يجب أن يكون رقماً موجباً أكبر من صفر (حتى 4 خانات عشرية)."
            )
            : undefined;
    const costPerBaseInput =
        totalCost === undefined
            ? requireCostPerBaseUnit(input.costPricePerBaseUnit as string)
            : undefined;

    const entryUnit = await findProductUnitById(tx, tenantId, entryUnitId);
    if (!entryUnit || entryUnit.productId !== productId) {
        throw new UnitNotBelongingToProductError(entryUnitId, productId);
    }
    if (!entryUnit.isActive) {
        throw new InactiveEntryUnitError(entryUnitId);
    }

    const baseUnit = await requireBaseUnit(tx, tenantId, productId);

    // The ENTERED unit's own factor, read from the DB — never the base unit's (1).
    const entryUnitFactor = await getUnitConversionFactor(tx, tenantId, entryUnitId);

    let baseQuantity: string;
    let perBaseUnit: string;
    // [v4.7] The line's TOTAL paid, in SYP. Interactive paths store EXACTLY
    // what the merchant typed — never re-derived from the rounded per-unit
    // figure, which cannot change it. The CSV path (costPricePerBaseUnit
    // given) computes it ONCE: price x baseQuantity, one Decimal
    // multiplication rounded once to 4 dp via lib/utils/money.ts.
    let totalCostSYP: string;

    if (totalCost !== undefined) {
        const r = costFromTotal(totalCost, quantityInEntryUnit, entryUnitFactor);
        baseQuantity = r.baseQuantity;
        perBaseUnit = r.perBaseUnit;
        totalCostSYP = serializeMoney(totalCost);
    } else {
        // [FIX] Explicit rounding, identical to costFromTotal's — never
        // dependent on a global Decimal rounding setting.
        baseQuantity = toBaseUnit(quantityInEntryUnit, entryUnitFactor)
            .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
            .toFixed(4);
        perBaseUnit = costPerBaseInput as string;
        totalCostSYP = multiplyMoney(perBaseUnit, baseQuantity);
    }

    // Both paths: quantity x factor can exceed what Decimal(18,4) holds even
    // when the typed quantity itself passed its own 14-digit limit. The same
    // three column guards then cover totalCostSYP and costPricePerBaseUnit —
    // on the interactive path they are belt-and-braces (the typed inputs are
    // already regex-bounded), on the CSV path totalCostSYP is the guard that
    // stops a multiplication product wider than Decimal(18,4).
    assertBaseQuantityInRange(baseQuantity);
    assertTotalCostSypInRange(totalCostSYP);
    assertCostPricePerBaseUnitInRange(perBaseUnit);
    if (!new Decimal(baseQuantity).gt(0)) {
        throw new InvalidCostInputError("الكمية بعد التحويل إلى الوحدة الأساسية صفر.");
    }

    const batch = await tx.productBatch.create({
        data: {
            tenantId,
            // [v4.7] Required — supplied by the receiving gateway, never by a
            // client (routes reject a body carrying receiptId outright).
            receiptId: input.receiptId,
            productId,
            unitId: baseUnit.id,
            batchNumber: finalBatchNumber,
            quantity: baseQuantity,
            // [v4.7] Write-once snapshot of what was received — nothing ever
            // updates it after creation (enforced by a static source scan).
            initialQuantity: baseQuantity,
            costPricePerBaseUnit: perBaseUnit,
            // [v4.7] Write-once total paid — see the note above.
            totalCostSYP,
            expiryDate: expiry,
        },
    });
    return {
        receiptId: input.receiptId,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        resolvedBaseUnitId: baseUnit.id,
        resolvedBaseUnitName: baseUnit.unitName,
        baseQuantity,
        costPricePerBaseUnit: perBaseUnit,
        totalCostSYP,
        enteredUnitName: entryUnit.unitName,
    };
}