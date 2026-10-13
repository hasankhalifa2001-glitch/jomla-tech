/**
 * Server-safe helper (no "use client"): the key of a cart line / reorder-index
 * entry. The gateway builds HomeData.reorderIndex with it on the server and the
 * client cart uses the very same function.
 */
export const lineKey = (productId: string, unitId: string) => `${productId}:${unitId}`;