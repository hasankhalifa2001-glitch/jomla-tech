/**
 * lib/inventory/units.ts — see prior turns for full header/rationale.
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
const MAX_COST_PER_BASE_UNIT = new Decimal("9999999999.99999999");

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

    if (!total.gt(0)) throw new InvalidCostInputError("إجمالي تكلفة الشراء يجب أن يكون أكبر من صفر.");
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
 * ADD THIS to lib/inventory/units.ts (it is the only file allowed to name
 * `conversionFactor` in a select). It is NOT a standalone file.
 *
 * [T4h] Batch version of getUnitConversionFactor(): ONE query for any number
 * of sold-unit ids instead of one query per unit. Used by
 * lib/data/products.ts's listUnitConversionFactors() on every /dashboard load.
 *
 * NOTE: written without access to the current units.ts. If
 * getUnitConversionFactor() performs extra validation (e.g. rejects a
 * non-positive factor, or throws on a missing unit), mirror that validation
 * inside the loop below so both readers behave identically. TxOrClient is
 * already imported in units.ts per the existing getUnitConversionFactor()
 * signature.
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