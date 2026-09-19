/**
 * lib/inventory/units.ts — see prior turns for full header/rationale.
 * This revision: tx typed as TenantTransactionClient; toDisplayUnits()
 * serializes priceWholesale/priceRetail to string consistently;
 * validatePackagingUnits()'s duplicate-base-unit check now fires inside
 * the loop (was dead code, shadowed by the general duplicate-factor
 * check that ran first).
 */

import Decimal from "decimal.js";
import type { ProductUnit } from "@prisma/client";
import type { TenantTransactionClient, TxOrClient } from "@/lib/db/tenant-scope";

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

export interface DisplayUnit {
    id: string;
    unitName: string;
    conversionFactor: string;
    isActive: boolean;
    pricingCurrency: "SYP" | "USD";
    priceWholesale: string;
    priceRetail: string | null;
    barcode: string | null;
    barcodeSource: "GS1" | "INTERNAL" | null;
    imageUrl: string | null;
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

export function toDisplayUnits(units: ProductUnit[]): DisplayUnit[] {
    return units.map((u) => ({
        id: u.id,
        unitName: u.unitName,
        conversionFactor: u.conversionFactor.toString(),
        isActive: u.isActive,
        pricingCurrency: u.pricingCurrency,
        priceWholesale: u.priceWholesale.toString(),
        priceRetail: u.priceRetail !== null ? u.priceRetail.toString() : null,
        barcode: u.barcode,
        barcodeSource: u.barcodeSource,
        imageUrl: u.imageUrl,
    }));
}

export interface OfflineCacheUnit {
    id: string;
    unitName: string;
    conversionFactor: string;
    priceWholesale: string;
    priceRetail: string | null;
    pricingCurrency: "SYP" | "USD";
    barcode: string | null;
    barcodeSource: "GS1" | "INTERNAL" | null;
    isActive: boolean;
}

export function toOfflineCacheUnits(units: ProductUnit[]): OfflineCacheUnit[] {
    return units.map((u) => ({
        id: u.id,
        unitName: u.unitName,
        conversionFactor: u.conversionFactor.toString(),
        priceWholesale: u.priceWholesale.toString(),
        priceRetail: u.priceRetail ? u.priceRetail.toString() : null,
        pricingCurrency: u.pricingCurrency,
        barcode: u.barcode,
        barcodeSource: u.barcodeSource,
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
    priceRetail?: Numeric | null;
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