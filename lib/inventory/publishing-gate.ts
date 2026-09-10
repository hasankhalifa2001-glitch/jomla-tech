/**
 * Storefront Publishing Gate Validation
 *
 * Rules:
 * 1. Product must be active (isActive === true).
 * 2. At least one unit must be active (isActive !== false).
 * 3. At least one active unit must have a valid imageUrl (non-empty string).
 * 4. At least one active unit must have a retail price greater than 0 (priceRetail > 0).
 *
 * NOTE on deviation from spec wording: the Master Spec (T3a, item 1) says the
 * publishing gate is blocked "unless priceRetail and imageUrl are both
 * present" — it does not literally say priceRetail must be > 0. We deliberately
 * require priceRetail > 0 here as a stricter commercial-sense check (a listed
 * retail price of 0 has no real meaning on a storefront). This is a documented
 * product decision on top of the spec, not a spec requirement itself.
 *
 * IMPORTANT: This module is a pure validation helper. It never mutates
 * `isPublic` itself and must never be called automatically as a side effect
 * of an isActive toggle (see T1's Tenant Lifecycle & Deletion Policy:
 * deactivation/reactivation is a pure visibility toggle, never a
 * data-migration event). It is only used:
 *   (a) at product/unit creation, to validate an explicit isPublic: true request
 *   (b) in the dedicated toggle-public route, to validate an explicit
 *       admin request to set isPublic: true
 * It must NOT be used to silently flip isPublic to false from any
 * isActive-toggle code path.
 *
 * [FIX] priceRetail's accepted type now includes `string`, matching how
 * this module is actually called. products/route.ts validates priceRetail
 * through `nonNegativeDecimalString(...)` (a Zod-checked decimal STRING,
 * per T1's decimal.js-everywhere rule — Decimal(18,4) columns are never
 * passed through a native JS number), so `validation.data.units[i].priceRetail`
 * is typed `string | null | undefined` at the call site in
 * checkProductPublishable({ isActive: true, units }). The previous type
 * signature (`number | { toNumber?: () => number } | null`) did not
 * include `string` at all, so that real call site could not type-check
 * correctly against this function's generic constraint — the runtime
 * logic already handled a string correctly via `Number(unit.priceRetail)`,
 * but the type signature was silently lying about what shapes this
 * function actually accepts and was exercised with in practice. This is
 * also why a second caller — e.g. the toggle-public route, or a future
 * caller reading priceRetail directly off a fetched Prisma.ProductUnit row
 * (a real `Prisma.Decimal` instance, not a string) — is still supported by
 * the `.toNumber()` branch below.
 */

type PriceRetailValue = number | string | { toNumber?: () => number } | null | undefined;

export function isUnitPublishable(unit: {
  isActive?: boolean;
  imageUrl?: string | null;
  priceRetail?: PriceRetailValue;
}): boolean {
  // isActive defaults to true at the schema level (ProductUnit.isActive
  // @default(true)) — treat undefined/null as active, only an explicit
  // `false` disqualifies a unit. This avoids a partial object (missing the
  // field entirely) being wrongly treated as inactive.
  if (unit.isActive === false) return false;
  if (!unit.imageUrl || !unit.imageUrl.trim()) return false;
  if (unit.priceRetail === null || unit.priceRetail === undefined) return false;

  const price =
    typeof unit.priceRetail === "object" &&
      unit.priceRetail !== null &&
      "toNumber" in unit.priceRetail &&
      typeof unit.priceRetail.toNumber === "function"
      ? unit.priceRetail.toNumber()
      : Number(unit.priceRetail);

  return !Number.isNaN(price) && price > 0;
}

export function checkProductPublishable<
  T extends {
    isActive?: boolean;
    imageUrl?: string | null;
    priceRetail?: PriceRetailValue;
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