/**
 * Storefront Publishing Gate Validation
 *
 * Rules:
 * 1. Product must be active (isActive === true).
 * 2. At least one unit must be active (isActive !== false).
 * 3. At least one active unit must have a valid imageUrl (non-empty string).
 * 4. At least one active unit must have a retail price greater than 0 (priceRetail > 0).
 */

export function isUnitPublishable(unit: {
  isActive?: boolean;
  imageUrl?: string | null;
  priceRetail?: number | { toNumber?: () => number } | null;
}): boolean {
  if (unit.isActive === false) return false;
  if (!unit.imageUrl || !unit.imageUrl.trim()) return false;
  if (unit.priceRetail === null || unit.priceRetail === undefined) return false;
  const price =
    typeof unit.priceRetail === "object" && unit.priceRetail !== null && "toNumber" in unit.priceRetail
      ? (unit.priceRetail as { toNumber: () => number }).toNumber()
      : Number(unit.priceRetail);
  return !Number.isNaN(price) && price > 0;
}

export function checkProductPublishable<
  T extends {
    isActive?: boolean;
    imageUrl?: string | null;
    priceRetail?: number | { toNumber?: () => number } | null;
  }
>(product: {
  isActive: boolean;
  units: T[];
}): { publishable: boolean; reason?: string; eligibleUnit?: T } {
  if (!product.isActive) {
    return { publishable: false, reason: "لا يمكن نشر منتج موقوف في المتجر." };
  }

  const eligibleUnit = (product.units || []).find(isUnitPublishable);
  if (!eligibleUnit) {
    return {
      publishable: false,
      reason:
        "لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة وسعر مفرق أكبر من صفر على وحدة نشطة واحدة على الأقل.",
    };
  }

  return { publishable: true, eligibleUnit };
}
