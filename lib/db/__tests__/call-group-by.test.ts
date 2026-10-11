import { describe, it, expect, vi } from "vitest";
import { callGroupBy } from "@/lib/db/call-group-by";

/**
 * T5a - the shared groupBy overload-narrowing helper. Pins the tiny contract
 * that analytics.ts, receipt-history.ts and store.ts all rely on: it forwards
 * args verbatim and resolves with the delegate's return value.
 */
describe("callGroupBy", () => {
  it("invokes the passed delegate with the exact args and resolves its value", async () => {
    const args = { by: ["productId"], where: { tenantId: "t1" } };
    const rows = [{ productId: "p1", _sum: { quantity: 5 } }];
    const groupFn = vi.fn(async (_a: unknown) => rows);

    const result = await callGroupBy(groupFn, args);

    expect(groupFn).toHaveBeenCalledTimes(1);
    expect(groupFn).toHaveBeenCalledWith(args);
    expect(result).toBe(rows);
  });

  it("propagates a rejected delegate", async () => {
    const groupFn = vi.fn(async (_a: unknown) => {
      throw new Error("boom");
    });
    await expect(callGroupBy(groupFn, {})).rejects.toThrow("boom");
  });
});