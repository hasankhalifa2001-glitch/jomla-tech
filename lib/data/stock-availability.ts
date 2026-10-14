/**
 * lib/data/stock-availability.ts
 *
 * T5b — shared "sum of positive batch quantities per product" read.
 *
 * Extracted from lib/data/store.ts's private loadAvailableBaseQuantities()
 * (T5a) so the admin orders queue/detail (lib/data/orders.ts) can reuse the
 * exact same query without duplicating it — a static test forbids a second
 * copy of the stock-availability query.
 *
 * Semantics (D2, same as the storefront): SUM of ProductBatch.quantity over
 * the product's batches WHERE quantity > 0 (positives only — negatives count
 * as 0), with NO expiry filter (expired batches still count). ONE grouped
 * query via the shared callGroupBy helper for all requested ids — no N+1.
 *
 * Returns a productId → base-unit quantity (decimal string) map. A product
 * appears in the map IF AND ONLY IF it has positive stock; absence means "0".
 * No cost field, no batch id/number, no baseUnitId anywhere near this read.
 */

import type { TxOrClient } from "@/lib/db/tenant-scope";
import { callGroupBy } from "@/lib/db/call-group-by";

export async function loadAvailableBaseQuantities(
    db: TxOrClient,
    tenantId: string,
    productIds: readonly string[]
): Promise<Map<string, string>> {
    const byId = new Map<string, string>();
    if (productIds.length === 0) return byId;

    type StockGroupRow = { productId: string; _sum: { quantity: unknown } | null };
    const rows = (await callGroupBy(db.productBatch.groupBy, {
        by: ["productId"],
        where: { tenantId, productId: { in: [...productIds] }, quantity: { gt: 0 } },
        _sum: { quantity: true },
    })) as StockGroupRow[];

    for (const row of rows) {
        const sum = row._sum?.quantity;
        if (sum == null) continue;
        byId.set(row.productId, String(sum));
    }
    return byId;
}
