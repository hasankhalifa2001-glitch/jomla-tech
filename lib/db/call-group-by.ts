/**
 * lib/db/call-group-by.ts
 *
 * [T5a] Extracted from the two module-private copies that lived in
 * lib/data/analytics.ts and lib/data/receipt-history.ts, so T5a's storefront
 * stock aggregation (a productBatch.groupBy) can REUSE the single shared
 * helper instead of a third copy — the spec forbids copying it.
 *
 * WHY THIS EXISTS — lib/db/tenant-scope's client extension types each
 * delegate's `groupBy` as a UNION of generic overloads whose mutual
 * incompatibility makes a direct call fail to compile (TS2349), even though
 * the argument object itself is perfectly valid. Narrowing the method to a
 * single non-generic signature BEFORE invoking it is the standard workaround;
 * the awaited row shape stays pinned by the caller's own row type, so nothing
 * about the runtime query changes.
 */
export function callGroupBy(groupFn: unknown, args: unknown): Promise<unknown> {
  return (groupFn as (a: unknown) => Promise<unknown>)(args);
}