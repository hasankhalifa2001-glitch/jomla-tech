/**
 * Storefront Publishing Gate Validation
 *
 * Rules (the image is a PRODUCT-level concept — see schema.prisma's [v4.6]
 * note near the top of that file):
 * 1. Product must be active (isActive === true).
 * 2. At least one unit must be active (isActive !== false).
 * 3. Product.imageUrl must be present and non-blank (trimmed non-empty).
 *
 * [v4.6] THE IMAGE MOVED FROM THE UNIT TO THE PRODUCT. `ProductUnit.imageUrl`
 * no longer exists. There is NO per-unit image and this gate deliberately
 * implements NO unit-to-product fallback: the one image that matters is the
 * product's own. The old per-unit `isUnitPublishable()` helper and the
 * `eligibleUnit` return value were removed along with it — the gate no longer
 * picks a "publishable unit", it only answers whether the product as a whole
 * qualifies for the storefront. Every caller must therefore pass the PRODUCT's
 * imageUrl (not any unit's).
 *
 * The image is OPTIONAL at creation time: a product may legitimately exist
 * without a photo, and the product forms never block the merchant for lacking
 * one. This gate is the only place the image becomes mandatory, and only while
 * `isPublic` is being requested / is true.
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
 */

/**
 * The only per-unit field the gate cares about now. Unit images are gone, so
 * nothing else about a unit can make a product publishable or unpublishable.
 */
interface GateUnit {
  isActive?: boolean;
}

export function checkProductPublishable(product: {
  isActive: boolean;
  imageUrl?: string | null;
  units: GateUnit[];
}): { publishable: boolean; reason?: string } {
  if (!product.isActive) {
    return { publishable: false, reason: "لا يمكن نشر منتج موقوف في المتجر." };
  }

  // The "at least one active unit" rule is reported SEPARATELY from the image
  // rule, so a merchant is told which of the two is actually missing instead of
  // one vague message. isActive defaults to true at the schema level
  // (ProductUnit.isActive @default(true)) — treat undefined/null as active, so
  // only an explicit `false` disqualifies a unit.
  const hasActiveUnit = (product.units || []).some((u) => u.isActive !== false);
  if (!hasActiveUnit) {
    return {
      publishable: false,
      reason:
        "لا يمكن نشر المنتج في المتجر إلا بعد وجود وحدة قياس نشطة واحدة على الأقل.",
    };
  }

  if (!product.imageUrl || !product.imageUrl.trim()) {
    return {
      publishable: false,
      reason: "لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج.",
    };
  }

  return { publishable: true };
}