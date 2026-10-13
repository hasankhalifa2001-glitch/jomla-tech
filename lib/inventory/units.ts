/**
 * lib/inventory/units.ts — unit conversion & cost helpers (the ONLY file allowed to name
 * `conversionFactor` in a select).
 * This revision: tx typed as TenantTransactionClient; toDisplayUnits()
 * serializes priceWholesale to a string consistently;
 * validatePackagingUnits()'s duplicate-base-unit check now fires inside
 * the loop (was dead code, shadowed by the general duplicate-factor
 * check that ran first).
 *
 * [v4.5] ProductUnit.barcode/barcodeSource no longer exist as scalar
 * fields — they moved to the separate ProductUnitBarcode model (see
 * schema.prisma's [v4.5] note and lib/data/products.ts's header). Every
 * function here that used to read those scalars off a raw ProductUnit
 * now expects the caller to have `include`d the `barcodes` relation, and
 * returns a `barcodes: UnitBarcode[]` array instead of the old
 * `barcode`/`barcodeSource` scalar pair. This file does NOT call
 * `tx.productUnitBarcode.*` itself — it only reshapes data callers
 * already fetched, exactly the same posture it already has toward
 * `tx.productUnit.*`.
 *
 * [v4.8] netSoldInBaseUnit() / NetSoldRow were REMOVED. They converted
 * InvoiceItem.quantity (sale unit, rounded for FIFO-split sales) back into
 * base units by multiplying with the unit's conversionFactor — which is
 * exactly the drift bug v4.8 closed (1 carton of 24 split 20 + 4 stored as
 * 0.8333 + 0.1667, then re-multiplied to 19.9992 + 4.0008). The net-sold
 * figure is now SUM(InvoiceItem.baseQuantity), computed by the database, so
 * no conversion is needed anywhere in the reconciliation path.
 */

import Decimal from "decimal.js";
import type { ProductUnit, BarcodeSource } from "@prisma/client";
import type { TxOrClient } from "@/lib/db/tenant-scope";

type DecimalInstance = InstanceType<typeof Decimal>;
type Numeric = string | number | DecimalInstance;

export const BASE_UNIT_CONVERSION_FACTOR = "1";

export function toBaseUnit(
    quantityInSoldUnit: Numeric,
    soldUnitConversionFactor: Numeric
): DecimalInstance {
    return new Decimal(quantityInSoldUnit).times(soldUnitConversionFactor);
}

export function fromBaseUnit(
    quantityInBaseUnit: Numeric,
    targetUnitConversionFactor: Numeric
): DecimalInstance {
    return new Decimal(quantityInBaseUnit).dividedBy(targetUnitConversionFactor);
}

// [v4.5] Plain shape for one barcode row, reused wherever a barcode list
// is displayed or cached. lib/data/products.ts's own `BarcodeView`
// interface is structurally identical to this — kept as two separate
// declarations (rather than one importing the other) to avoid a
// products.ts <-> units.ts circular import, since products.ts already
// imports several things FROM units.ts.
export interface UnitBarcode {
    id: string;
    barcode: string;
    barcodeSource: BarcodeSource | null;
    createdAt: Date;
}

export interface DisplayUnit {
    id: string;
    unitName: string;
    conversionFactor: string;
    isActive: boolean;
    pricingCurrency: "SYP" | "USD";
    priceWholesale: string;
    // [v4.5] REPLACED — was `barcode: string | null; barcodeSource: "GS1" |
    // "INTERNAL" | null;`. A unit may now carry zero, one, or many
    // barcodes, so this is always an array (empty when none).
    barcodes: UnitBarcode[];
}

export interface UnitBreakdownEntry {
    unitId: string;
    unitName: string;
    count: DecimalInstance;
}

export function breakdownForDisplay(
    quantityInBaseUnit: Numeric,
    units: DisplayUnit[]
): UnitBreakdownEntry[] {
    const sorted = [...units].sort((a, b) =>
        new Decimal(b.conversionFactor).comparedTo(new Decimal(a.conversionFactor))
    );

    let remaining = new Decimal(quantityInBaseUnit);
    const result: UnitBreakdownEntry[] = [];

    for (const unit of sorted) {
        const factor = new Decimal(unit.conversionFactor);
        if (factor.lessThanOrEqualTo(0)) continue;
        const count = remaining.dividedBy(factor).floor();
        if (count.greaterThan(0)) {
            result.push({ unitId: unit.id, unitName: unit.unitName, count });
            remaining = remaining.minus(count.times(factor));
        }
    }

    return result;
}

export async function getUnitConversionFactor(
    tx: TxOrClient,
    tenantId: string,
    unitId: string
): Promise<DecimalInstance> {
    const unit = await tx.productUnit.findUniqueOrThrow({
        where: { id: unitId, tenantId },
        select: { conversionFactor: true },
    });
    return new Decimal(unit.conversionFactor.toString());
}

// [v4.5] Raw ProductUnit rows no longer carry a barcode scalar — a caller
// must fetch each unit's `barcodes` relation and pass rows shaped like
// this. lib/data/products.ts's read functions all now `include: {
// barcodes: {...} }` for exactly this reason.
export type ProductUnitWithBarcodes = ProductUnit & { barcodes: UnitBarcode[] };

export function toDisplayUnits(units: ProductUnitWithBarcodes[]): DisplayUnit[] {
    return units.map((u) => ({
        id: u.id,
        unitName: u.unitName,
        conversionFactor: u.conversionFactor?.toString() ?? "1",
        isActive: u.isActive,
        pricingCurrency: u.pricingCurrency,
        priceWholesale: u.priceWholesale?.toString() ?? "0",
        // [v4.5] `u.barcodes` defaults to [] rather than undefined if a
        // caller somehow forgot to `include` it — fails safe (empty list)
        // rather than throwing mid-map.
        barcodes: u.barcodes ?? [],
    }));
}

export interface OfflineCacheUnit {
    id: string;
    unitName: string;
    conversionFactor: string;
    priceWholesale: string;
    pricingCurrency: "SYP" | "USD";
    // [v4.5] REPLACED — was `barcode: string | null; barcodeSource: "GS1" |
    // "INTERNAL" | null;`. See T4a's Dexie schema note: cachedProducts is
    // expected to gain a matching flat `cachedProductBarcodes` lookup
    // table alongside this, since Dexie cannot efficiently index into a
    // nested array — that is a separate T4a/POS-scan change, not made
    // here.
    barcodes: UnitBarcode[];
    isActive: boolean;
}

export function toOfflineCacheUnits(units: ProductUnitWithBarcodes[]): OfflineCacheUnit[] {
    return units.map((u) => ({
        id: u.id,
        unitName: u.unitName,
        conversionFactor: u.conversionFactor.toString(),
        priceWholesale: u.priceWholesale.toString(),
        pricingCurrency: u.pricingCurrency,
        barcodes: u.barcodes ?? [],
        isActive: u.isActive,
    }));
}

export function assertIsValidBaseUnitFactor(conversionFactor: Numeric): void {
    if (!new Decimal(conversionFactor).equals(1)) {
        throw new Error(
            `A product's base unit must have conversionFactor exactly 1 — ` +
            `received ${conversionFactor.toString()}.`
        );
    }
}

export function isReservedBaseUnitFactor(value: Numeric): boolean {
    return new Decimal(value).equals(1);
}

export function buildConversionFactorField(
    conversionFactor: Numeric
): { conversionFactor: string } {
    return { conversionFactor: new Decimal(conversionFactor).toString() };
}

export interface PackagingUnit {
    id?: string;
    unitName: string;
    conversionFactor: Numeric;
    priceWholesale?: Numeric;
    isActive?: boolean;
}

export function validatePackagingUnits(units: PackagingUnit[]): {
    valid: boolean;
    error?: string;
} {
    if (!units || units.length === 0) {
        return { valid: false, error: "يجب تحديد وحدة قياس واحدة على الأقل." };
    }

    const factorsSeen = new Map<string, string>();
    let baseUnitCount = 0;

    for (const u of units) {
        if (!u.unitName || !u.unitName.trim()) {
            return { valid: false, error: "اسم الوحدة مطلوب لجميع الوحدات." };
        }

        let factor: DecimalInstance;
        try {
            factor = new Decimal(u.conversionFactor);
        } catch {
            return { valid: false, error: `معامل التحويل للوحدة "${u.unitName}" غير صالح.` };
        }

        if (factor.lte(0)) {
            return {
                valid: false,
                error: `معامل التحويل للوحدة "${u.unitName}" يجب أن يكون رقماً موجباً أكبر من الصفر.`,
            };
        }

        if (factor.equals(1)) {
            baseUnitCount += 1;
            if (baseUnitCount > 1) {
                return {
                    valid: false,
                    error: "لا يمكن تحديد أكثر من وحدة أساسية واحدة بمعامل تحويل يساوي 1.",
                };
            }
        }

        const factorKey = factor.toFixed();
        const existingUnitName = factorsSeen.get(factorKey);
        if (existingUnitName) {
            return {
                valid: false,
                error: `معامل التحويل مكرر: الوحدتان "${existingUnitName}" و"${u.unitName}" لهما نفس معامل التحويل (${factor.toString()}).`,
            };
        }
        factorsSeen.set(factorKey, u.unitName);
    }

    if (baseUnitCount === 0) {
        return {
            valid: false,
            error: "يجب تحديد وحدة أساسية واحدة بمعامل تحويل يساوي 1 (مثلاً: قطعة).",
        };
    }

    return { valid: true };
}

// ---------------------------------------------------------------------------
// Batch purchase cost — merchant enters the TOTAL paid for the received
// quantity (in the purchase unit); cost per base unit is derived here, ONCE.
// ---------------------------------------------------------------------------

export class InvalidCostInputError extends Error {
    readonly code = "INVALID_COST_INPUT";
    constructor(message: string) {
        super(message);
        this.name = "InvalidCostInputError";
    }
}

// [Batch cost entry] THE one pattern for a per-base-unit cost value, shared by
// every surface that validates one: the creation helper
// (lib/inventory/batch-creation.ts), the correction route
// (app/api/inventory/batches/[id]/route.ts) and the correction form
// (components/inventory/EditBatchModal.tsx). 10 integer digits + up to 8
// decimals == exactly what ProductBatch.costPricePerBaseUnit's Decimal(18,8)
// column holds, so no two screens can drift on precision.
export const COST_PER_BASE_UNIT_REGEX = /^\d{1,10}(\.\d{1,8})?$/;
// ProductBatch.costPricePerBaseUnit is Decimal(18,8): max 10 integer digits.
export const MAX_COST_PER_BASE_UNIT = new Decimal("9999999999.99999999");

// [v4.7] THE one pattern for an entered quantity / total cost
// (Decimal(18,4): up to 14 integer digits + up to 4 decimals). Shared by the
// creation helper, the receiving gateway and the CSV commit route.
export const AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;

function toDecimalOrThrow(value: Numeric): DecimalInstance {
    try {
        return new Decimal(value);
    } catch {
        throw new InvalidCostInputError("قيمة رقمية غير صالحة في حساب التكلفة.");
    }
}

export interface CostFromTotalResult {
    /** Quantity in BASE units, scale 4 — exactly what ProductBatch.quantity stores. */
    baseQuantity: string;
    /** Scale 8, ROUND_HALF_UP — exactly what ProductBatch.costPricePerBaseUnit stores. */
    perBaseUnit: string;
}

export function costFromTotal(
    totalCost: Numeric,
    quantityInPurchaseUnit: Numeric,
    purchaseUnitConversionFactor: Numeric
): CostFromTotalResult {
    const total = toDecimalOrThrow(totalCost);
    const qty = toDecimalOrThrow(quantityInPurchaseUnit);
    const factor = toDecimalOrThrow(purchaseUnitConversionFactor);

    if (!total.gt(0)) throw new InvalidCostInputError("لا يمكن قبول سطر بتكلفة صفر — إجمالي تكلفة الشراء يجب أن يكون أكبر من صفر.");
    if (!qty.gt(0)) throw new InvalidCostInputError("الكمية يجب أن تكون أكبر من صفر.");
    if (!factor.gt(0)) throw new InvalidCostInputError("معامل تحويل وحدة الشراء غير صالح.");

    // Rounded to the column's own scale FIRST and used as the divisor, so
    // perBaseUnit x storedQuantity reproduces the typed total.
    const baseQty = toBaseUnit(qty, factor).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    if (!baseQty.gt(0)) throw new InvalidCostInputError("الكمية بعد التحويل إلى الوحدة الأساسية صفر.");

    const perBase = total.dividedBy(baseQty).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
    if (perBase.lte(0)) {
        throw new InvalidCostInputError("سعر الوحدة الأساسية الناتج صفر — تحقق من الإجمالي والكمية.");
    }
    if (perBase.gt(MAX_COST_PER_BASE_UNIT)) {
        throw new InvalidCostInputError("سعر الوحدة الأساسية الناتج كبير جداً — تحقق من الإجمالي والكمية.");
    }

    return { baseQuantity: baseQty.toFixed(4), perBaseUnit: perBase.toFixed(8) };
}

// ---- Display-only (never written to any table) -----------------------------

export interface CostBreakdownResult {
    quantityInBaseUnits: string;
    pricePerPurchaseUnit: string; // 2 dp, display only
    pricePerBaseUnit: string;     // 2 dp, display only
}

/** Live lines in the batch forms. Built on costFromTotal so what the merchant
 *  sees can never diverge from what the server stores. Null when invalid. */
export function costBreakdownForDisplay(
    totalCost: Numeric,
    quantityInPurchaseUnit: Numeric,
    purchaseUnitConversionFactor: Numeric
): CostBreakdownResult | null {
    try {
        const { baseQuantity, perBaseUnit } = costFromTotal(
            totalCost,
            quantityInPurchaseUnit,
            purchaseUnitConversionFactor
        );
        const perPurchase = new Decimal(totalCost).dividedBy(new Decimal(quantityInPurchaseUnit));
        return {
            quantityInBaseUnits: new Decimal(baseQuantity).toString(),
            pricePerPurchaseUnit: perPurchase.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
            pricePerBaseUnit: new Decimal(perBaseUnit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        };
    } catch {
        return null;
    }
}

export interface BatchCostUnitInput {
    unitName: string;
    conversionFactor: Numeric;
    isBaseUnit?: boolean;
    isActive?: boolean;
}

export interface BatchCostDisplayLine {
    unitName: string;
    price: string; // 2 dp decimal string — format with formatMoney() at the call site
    isBaseUnit: boolean;
}

/** Inventory batch list: purchase price per each active unit, largest unit first
 *  ("9,000 / طرد", "1,500 / قطعة"). Derived from the stored per-base-unit cost. */
export function batchCostDisplayLines(
    costPricePerBaseUnit: Numeric,
    units: BatchCostUnitInput[]
): BatchCostDisplayLine[] {
    try {
        const baseCost = new Decimal(costPricePerBaseUnit);
        if (baseCost.lt(0)) return [];
        const rows = units.flatMap((u) => {
            if (u.isActive === false) return [];
            const factor = new Decimal(u.conversionFactor);
            if (!factor.gt(0)) return [];
            return [{
                factor,
                line: {
                    unitName: u.unitName,
                    price: baseCost.times(factor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
                    isBaseUnit: !!u.isBaseUnit || factor.equals(1),
                },
            }];
        });
        rows.sort((a, b) => b.factor.comparedTo(a.factor));
        return rows.map((r) => r.line);
    } catch {
        return [];
    }
}


/**
 * [T4h] Batch version of getUnitConversionFactor(): ONE query for any number
 * of sold-unit ids instead of one query per unit. Used by
 * lib/data/products.ts's listUnitConversionFactors() on every /dashboard load.
 *
 * NOTE: if getUnitConversionFactor() ever adds validation, mirror it in the
 * loop below so both readers behave identically.
 *
 * A unit id with no row for this tenant simply has no map entry; the caller
 * decides what that means.
 */
export async function getUnitConversionFactors(
    tx: TxOrClient,
    tenantId: string,
    unitIds: readonly string[]
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const unique = [...new Set(unitIds)];
    if (unique.length === 0) return result;

    const rows = await tx.productUnit.findMany({
        where: { tenantId, id: { in: unique } },
        select: { id: true, conversionFactor: true },
    });

    for (const row of rows) {
        result.set(row.id, row.conversionFactor.toString());
    }
    return result;
}

/**
 * [v4.7 — Phase 6, updated v4.8] The reconciliation identity, evaluated with
 * EXACT decimal equality (Decimal.equals — no epsilon, no rounding
 * tolerance):
 *
 *     remaining === initialQuantity − netSold + Σ adjustments
 *
 * where, since v4.8:
 *     netSold = SUM(InvoiceItem.baseQuantity) for the batch
 *               (the quantity actually deducted, already in the base unit;
 *                VOIDED rows are negative so they net out).
 *
 * All four values are decimal STRINGS straight off the storage columns (or
 * the database's own groupBy sums); this function is the only place they are
 * combined, so lib/data/receipt-history.ts itself performs no quantity
 * arithmetic at all. A batch that fails the check indicates a quantity-drift
 * bug (see schema.prisma's [v4.7]/[v4.8] headers), not a display problem to
 * be smoothed over — hence exact equality.
 *
 * Returns false — never throws — on unparseable input: a drifted batch must
 * render as "not reconciled", not crash the screen.
 */
export function reconciliationIdentityHolds(values: {
    initialQuantity: Numeric;
    netSold: Numeric;
    adjustments: Numeric;
    remaining: Numeric;
}): boolean {
    try {
        const expected = new Decimal(values.initialQuantity)
            .minus(new Decimal(values.netSold))
            .plus(new Decimal(values.adjustments));
        return new Decimal(values.remaining).equals(expected);
    } catch {
        return false;
    }
}

/**
 * [v4.8] Display-only: collapses the base-unit quantities of several
 * InvoiceItem rows that belong to ONE sale line (same product, same sold
 * unit, same price — a sale whose FIFO allocation was split across batches)
 * back into a single quantity in the SALE unit.
 *
 * It works from the stored, exact `baseQuantity` of each row (20 + 4 = 24)
 * and divides ONCE by the sold unit's factor (24 → 1 طرد). It never touches
 * the rounded per-row `quantity` (0.8333 + 0.1667), which is what made a
 * 3-way split sum to 0.9999.
 *
 * Voided rows carry negative baseQuantity, so a void line yields a negative
 * sale quantity (receipts render it as "مرتجع: N" with the absolute value).
 * Nothing here is ever written back to a table.
 */
export function saleQuantityFromBase(
    baseQuantities: ReadonlyArray<Numeric>,
    saleUnitFactor: Numeric
): { baseTotal: string; saleQuantity: string } {
    const factor = new Decimal(saleUnitFactor);
    if (!factor.gt(0)) {
        throw new Error(
            `saleQuantityFromBase: invalid sale-unit conversion factor "${factor.toString()}".`
        );
    }
    let total = new Decimal(0);
    for (const q of baseQuantities) total = total.plus(new Decimal(q));
    return {
        baseTotal: total.toString(),
        saleQuantity: fromBaseUnit(total, factor)
            .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
            .toString(),
    };
}

/**
 * APPEND THIS TO lib/inventory/units.ts (it is the only file allowed to do
 * arithmetic on / name `conversionFactor`).
 *
 * Why here: the storefront shows each unit's size ("= 24 قطعة") and wants the
 * units ordered smallest -> largest. Both need the conversion factor, and the
 * project rule is that factor math lives ONLY in this file. lib/data/store-dto.ts
 * calls this instead of touching `.conversionFactor` itself.
 */

export interface StorefrontUnitLabel {
    unitId: string;
    /** "= 24 قطعة" for a packaging unit; null for the base unit (or when the
     *  base unit is not among the given units, e.g. it is inactive). */
    factorText: string | null;
}

/**
 * Display order (smallest unit first) + size captions for a storefront card's
 * ACTIVE units. Display-only — never written to any table.
 */
export function storefrontUnitLabels(units: DisplayUnit[]): StorefrontUnitLabel[] {
    const usable = units.filter((u) => {
        try {
            return new Decimal(u.conversionFactor).gt(0);
        } catch {
            return false;
        }
    });
    const sorted = [...usable].sort((a, b) =>
        new Decimal(a.conversionFactor).comparedTo(new Decimal(b.conversionFactor))
    );
    const base = sorted.find((u) => new Decimal(u.conversionFactor).equals(1));

    return sorted.map((u) => {
        const factor = new Decimal(u.conversionFactor);
        const isBase = factor.equals(1);
        return {
            unitId: u.id,
            factorText:
                isBase || !base
                    ? null
                    : `= ${factor.toDecimalPlaces(4).toString()} ${base.unitName}`,
        };
    });
}