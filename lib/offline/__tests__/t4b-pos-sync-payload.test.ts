/**
 * By-amount line round-trip through Dexie.
 *
 * Covers ONLY:
 *   - a by-amount invoice record persists quantity "0.3333" and totalSYP
 *     "5000.0000" as exact decimal strings, with no per-item override field;
 *   - that stored shape passes isTotalWithinTolerance.
 *
 * NOT covered here (needs the sync worker's payload builder): that the
 * /api/sync payload carries these strings verbatim, and the void payload's
 * negative quantities / voidsOfflineInvoiceId / verbatim voidReason.
 */
import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import {
  getOfflineDb,
  resetOfflineDbForTests,
  createOfflineInvoiceRecord,
} from "@/lib/offline/db";
import { isTotalWithinTolerance, multiplyMoney } from "@/lib/utils/money";

const TEST_TENANT_ID = "tenant-sync-payload-test";

describe("Dexie round-trip of a by-amount line", () => {
  beforeEach(async () => {
    await resetOfflineDbForTests();
  });

  it("stores quantity 0.3333 and totalSYP 5000, no override on persisted item", async () => {
    const db = getOfflineDb();
    const record = createOfflineInvoiceRecord({
      tenantId: TEST_TENANT_ID,
      offlineId: "inv-1",
      offlineCustomerId: "cust-1",
      items: [
        {
          productId: "prod-rice",
          unitId: "unit-kg",
          quantity: "0.3333",
          unitPriceSYP: "15000.0000",
        },
      ],
      totalSYP: "5000.0000",
      paidAmountSYP: "5000.0000",
      debtAmountSYP: "0.0000",
      paymentMethod: "CASH",
      requiresExchangeRate: false,
    });
    await db.offlineInvoices.add(record);

    const stored = await db.offlineInvoices.where("offlineId").equals("inv-1").first();
    expect(stored?.items[0].quantity).toBe("0.3333");
    expect(stored?.totalSYP).toBe("5000.0000");
    expect(stored?.items[0]).not.toHaveProperty("lineTotalOverrideSYP");
  });

  it("the stored shape passes isTotalWithinTolerance (4999.5 within 0.75 of 5000)", () => {
    const expected = multiplyMoney("0.3333", "15000");
    expect(isTotalWithinTolerance("5000.0000", expected, ["15000.0000"])).toBe(true);
  });
});