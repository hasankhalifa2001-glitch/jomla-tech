/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * lib/data/__tests__/v47-receipts-history.test.ts — [v4.7, Round B]
 * The READ side of the goods-receiving history: lib/data/receipt-history.ts
 * exercised as written (REAL data layer, fake Prisma boundary — the same
 * posture t4c2-sales-log takes).
 *
 * Pins:
 *  1. Cursor pagination encodes ALL THREE sort keys — several receipts
 *     sharing BOTH purchaseDate and createdAt are walked page by page with
 *     every id seen exactly once (no skips, no duplicates).
 *  2. from/to filter on purchaseDate (business dates); supplierName is a
 *     case-insensitive contains-match; both compose with the cursor.
 *  3. Totals/counts come from ONE groupBy per table per page (no N+1) and
 *     count LIVE lines only; deleted lines are counted separately.
 *  4. Detail: live lines (four figures + breakdown + costAdjusted) and
 *     deleted lines (shown, EXCLUDED from the receipt total). A receipt
 *     whose lines are ALL deleted still returns with an empty live list.
 *  5. Reconciliation identity: remaining = initial − netSold + adjustments,
 *     exact decimal equality, netSold via the SOLD unit's factor (a factor
 *     of 24 — using the base unit's 1 would fail the identity), voids
 *     netting out, and corruption flipping reconciles to false.
 *  6. netSoldInBaseUnit unit tests (voids net out, fractional exact, a
 *     missing factor throws instead of silently assuming 1).
 *  7. Static scans: no writes at all in this file's subject, no conversion
 *     arithmetic outside lib/inventory/units.ts, no USD anywhere in the
 *     receipts read path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";

import {
  listReceiptsForTenant,
  getReceiptDetail,
  encodeReceiptCursor,
  InvalidReceiptCursorError,
} from "@/lib/data/receipt-history";
import {
  netSoldInBaseUnit,
  reconciliationIdentityHolds,
  toBaseUnit,
} from "@/lib/inventory/units";

const TENANT_ID = "tenant-1";

// ---------------------------------------------------------------------------
// Fake Prisma boundary. Decimal columns are decimal.js instances (the data
// layer only ever calls .toString() on them — exactly like Prisma.Decimal).
// ---------------------------------------------------------------------------

type AnyRec = Record<string, any>;

type DecimalValue = InstanceType<typeof Decimal>;

function d(value: string | number): DecimalValue {
  return new Decimal(value);
}

function date(iso: string): Date {
  return new Date(iso);
}

/** One ProductReceipt-shaped row (@db.Date stored as UTC midnight). */
function receipt(id: string, purchaseDate: string, createdAt: string, supplier: string | null = null): AnyRec {
  return {
    id,
    tenantId: TENANT_ID,
    purchaseDate: date(purchaseDate),
    createdAt: date(createdAt),
    supplierName: supplier,
    createdByUser: { name: "مدير" },
  };
}

/** Evaluates the exact (small) where vocabulary listReceiptsForTenant emits. */
function matchesReceiptWhere(row: AnyRec, where: AnyRec): boolean {
  if (where.tenantId && row.tenantId !== where.tenantId) return false;
  if (where.purchaseDate) {
    const { gte, lte } = where.purchaseDate;
    if (gte && row.purchaseDate.getTime() < gte.getTime()) return false;
    if (lte && row.purchaseDate.getTime() > lte.getTime()) return false;
  }
  if (where.supplierName) {
    const needle = String(where.supplierName.contains ?? "").toLowerCase();
    const hay = (row.supplierName ?? "").toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (Array.isArray(where.AND)) {
    for (const clause of where.AND) {
      if (!matchesKeyset(row, clause)) return false;
    }
  }
  return true;
}

/** The keyset predicate: OR of the three (pd, ca, id) DESC steps. */
function matchesKeyset(row: AnyRec, clause: AnyRec): boolean {
  const or: AnyRec[] = clause.OR ?? [];
  for (const branch of or) {
    const pd = branch.purchaseDate;
    if (pd instanceof Date) {
      // Branches 2 and 3 require the SAME purchaseDate as the cursor.
      if (row.purchaseDate.getTime() !== pd.getTime()) continue;
      const ca = branch.createdAt;
      if (ca instanceof Date) {
        // Branch 3: same pd AND same createdAt → strictly smaller id.
        if (
          row.createdAt.getTime() === ca.getTime() &&
          branch.id?.lt !== undefined &&
          row.id < branch.id.lt
        ) {
          return true;
        }
      } else if (ca?.lt instanceof Date) {
        // Branch 2: same pd, strictly older createdAt.
        if (row.createdAt.getTime() < ca.lt.getTime()) return true;
      }
    } else if (pd?.lt instanceof Date) {
      // Branch 1: strictly older purchaseDate.
      if (row.purchaseDate.getTime() < pd.lt.getTime()) return true;
    }
  }
  return false;
}

function byDesc(a: AnyRec, b: AnyRec): number {
  if (a.purchaseDate.getTime() !== b.purchaseDate.getTime()) {
    return b.purchaseDate.getTime() - a.purchaseDate.getTime();
  }
  if (a.createdAt.getTime() !== b.createdAt.getTime()) {
    return b.createdAt.getTime() - a.createdAt.getTime();
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Grouped totals fake: ONE call per table per page, grouped by receiptId. */
function makeListDb(options: {
  batches?: AnyRec[]; // { receiptId, totalCostSYP, tenantId }
  deletions?: AnyRec[]; // { receiptId, tenantId }
} = {}) {
  const batches = options.batches ?? [];
  const deletions = options.deletions ?? [];

  const productBatch = {
    findMany: vi.fn(),
    groupBy: vi.fn(async (args: AnyRec) => {
      const ids: string[] = args.where?.receiptId?.in ?? [];
      const rows = batches.filter(
        (b) => b.tenantId === args.where?.tenantId && ids.includes(b.receiptId)
      );
      const byReceipt = new Map<string, AnyRec[]>();
      for (const row of rows) {
        const list = byReceipt.get(row.receiptId) ?? [];
        list.push(row);
        byReceipt.set(row.receiptId, list);
      }
      return [...byReceipt.entries()].map(([receiptId, group]) => ({
        receiptId,
        _count: group.length,
        _sum: {
          totalCostSYP: group
            .reduce((acc, row) => acc.plus(row.totalCostSYP), new Decimal(0))
            .toString(),
        },
      }));
    }),
  };

  const batchDeletionLog = {
    findMany: vi.fn(),
    groupBy: vi.fn(async (args: AnyRec) => {
      const ids: string[] = args.where?.receiptId?.in ?? [];
      const rows = deletions.filter(
        (row) => row.tenantId === args.where?.tenantId && ids.includes(row.receiptId)
      );
      const byReceipt = new Map<string, number>();
      for (const row of rows) {
        byReceipt.set(row.receiptId, (byReceipt.get(row.receiptId) ?? 0) + 1);
      }
      return [...byReceipt.entries()].map(([receiptId, count]) => ({
        receiptId,
        _count: count,
      }));
    }),
  };

  const productReceipt = {
    findMany: vi.fn(async (args: AnyRec) => {
      const filtered = RECEIPTS_STORE.filter((row) => matchesReceiptWhere(row, args.where ?? {})).sort(
        byDesc
      );
      return filtered.slice(0, args.take);
    }),
    findFirst: vi.fn(),
  };

  return { productReceipt, productBatch, batchDeletionLog };
}

/** The store the list fake reads from — swapped per test. */
let RECEIPTS_STORE: AnyRec[] = [];

beforeEach(() => {
  RECEIPTS_STORE = [];
});

// ---------------------------------------------------------------------------
// 1. Cursor pagination — the three-key tie-break
// ---------------------------------------------------------------------------

describe("listReceiptsForTenant — cursor pagination (all THREE sort keys)", () => {
  it("walks receipts that share BOTH purchaseDate and createdAt exactly once each", async () => {
    // Five receipts, same purchaseDate AND same createdAt — only the id
    // differs. A cursor carrying fewer than all three keys would position
    // the next page ambiguously and skip/duplicate rows here.
    RECEIPTS_STORE = [
      receipt("r-5", "2026-06-01T00:00:00.000Z", "2026-06-02T09:00:00.000Z"),
      receipt("r-4", "2026-06-01T00:00:00.000Z", "2026-06-02T09:00:00.000Z"),
      receipt("r-3", "2026-06-01T00:00:00.000Z", "2026-06-02T09:00:00.000Z"),
      receipt("r-2", "2026-06-01T00:00:00.000Z", "2026-06-02T09:00:00.000Z"),
      receipt("r-1", "2026-06-01T00:00:00.000Z", "2026-06-02T09:00:00.000Z"),
    ];
    const db = makeListDb();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listReceiptsForTenant(db as any, TENANT_ID, { limit: 2, cursor });
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(10); // no infinite loop on a broken cursor
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // Newest-first: r-5 … r-1 under (pd desc, ca desc, id desc).
    expect(seen).toEqual(["r-5", "r-4", "r-3", "r-2", "r-1"]);
  });

  it("keeps ordering correct when dates AND timestamps differ across pages", async () => {
    RECEIPTS_STORE = [
      receipt("a", "2026-06-03T00:00:00.000Z", "2026-06-03T10:00:00.000Z"),
      receipt("b", "2026-06-02T00:00:00.000Z", "2026-06-02T10:00:00.000Z"),
      receipt("c", "2026-06-02T00:00:00.000Z", "2026-06-02T08:00:00.000Z"),
      receipt("d", "2026-06-01T00:00:00.000Z", "2026-06-01T10:00:00.000Z"),
    ];
    const db = makeListDb();

    const first = await listReceiptsForTenant(db as any, TENANT_ID, { limit: 2 });
    expect(first.items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await listReceiptsForTenant(db as any, TENANT_ID, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((r) => r.id)).toEqual(["c", "d"]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor BEFORE touching the store", async () => {
    const db = makeListDb();
    await expect(
      listReceiptsForTenant(db as any, TENANT_ID, { cursor: "not-a-valid-cursor" })
    ).rejects.toBeInstanceOf(InvalidReceiptCursorError);
    expect(db.productReceipt.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Filters — from/to on purchaseDate, supplier contains
// ---------------------------------------------------------------------------

describe("listReceiptsForTenant — filters", () => {
  beforeEach(() => {
    RECEIPTS_STORE = [
      receipt("old", "2026-01-10T00:00:00.000Z", "2026-01-10T08:00:00.000Z", "شركة الأقدم"),
      receipt("mid", "2026-03-05T00:00:00.000Z", "2026-03-05T08:00:00.000Z", "مؤسسة الوسط"),
      receipt("new", "2026-06-20T00:00:00.000Z", "2026-06-20T08:00:00.000Z", "شركة الفجر"),
    ];
  });

  it("filters on purchaseDate with an inclusive [from, to] window", async () => {
    const db = makeListDb();
    const page = await listReceiptsForTenant(db as any, TENANT_ID, {
      from: "2026-03-01",
      to: "2026-06-30",
    });
    expect(page.items.map((r) => r.id)).toEqual(["new", "mid"]);
    // The window is pushed INTO the query (business date → UTC-midnight
    // @db.Date) — never post-filtered in JS, which would break cursors.
    const where = db.productReceipt.findMany.mock.calls[0][0].where;
    expect(where.purchaseDate.gte).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(where.purchaseDate.lte).toEqual(new Date("2026-06-30T00:00:00.000Z"));
  });

  it("a single-day window keeps only that purchaseDate", async () => {
    const db = makeListDb();
    const page = await listReceiptsForTenant(db as any, TENANT_ID, {
      from: "2026-03-05",
      to: "2026-03-05",
    });
    expect(page.items.map((r) => r.id)).toEqual(["mid"]);
  });

  it("omits the purchaseDate clause entirely when no bound is given", async () => {
    const db = makeListDb();
    await listReceiptsForTenant(db as any, TENANT_ID, {});
    const where = db.productReceipt.findMany.mock.calls[0][0].where;
    expect(where.purchaseDate).toBeUndefined();
  });

  it("matches the supplier case-insensitively as a partial match", async () => {
    const db = makeListDb();
    const page = await listReceiptsForTenant(db as any, TENANT_ID, {
      supplierName: "الفجر",
    });
    expect(page.items.map((r) => r.id)).toEqual(["new"]);
    const where = db.productReceipt.findMany.mock.calls[0][0].where;
    expect(where.supplierName).toEqual({ contains: "الفجر", mode: "insensitive" });
  });

  it("composes the date window with the cursor (both applied in the same query)", async () => {
    const db = makeListDb();
    const first = await listReceiptsForTenant(db as any, TENANT_ID, {
      limit: 1,
      from: "2026-03-01",
      to: "2026-06-30",
    });
    expect(first.items.map((r) => r.id)).toEqual(["new"]);

    const second = await listReceiptsForTenant(db as any, TENANT_ID, {
      limit: 1,
      from: "2026-03-01",
      to: "2026-06-30",
      cursor: first.nextCursor!,
    });
    expect(second.items.map((r) => r.id)).toEqual(["mid"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Totals/counts — grouped, LIVE lines only, one groupBy per table
// ---------------------------------------------------------------------------

describe("listReceiptsForTenant — totals & counts (grouped, no N+1)", () => {
  it("computes each row's total and counts from ONE groupBy per table for the whole page", async () => {
    RECEIPTS_STORE = [
      receipt("r1", "2026-06-01T00:00:00.000Z", "2026-06-01T09:00:00.000Z"),
      receipt("r2", "2026-05-01T00:00:00.000Z", "2026-05-01T09:00:00.000Z"),
      receipt("r3", "2026-04-01T00:00:00.000Z", "2026-04-01T09:00:00.000Z"),
    ];
    const db = makeListDb({
      batches: [
        { tenantId: TENANT_ID, receiptId: "r1", totalCostSYP: d("120000") },
        { tenantId: TENANT_ID, receiptId: "r1", totalCostSYP: d("80000") },
        { tenantId: TENANT_ID, receiptId: "r2", totalCostSYP: d("50000") },
        // r3 has no live batches → total 0, lineCount 0 (all deleted).
      ],
      deletions: [
        { tenantId: TENANT_ID, receiptId: "r1" },
        { tenantId: TENANT_ID, receiptId: "r3" },
        { tenantId: TENANT_ID, receiptId: "r3" },
      ],
    });

    const page = await listReceiptsForTenant(db as any, TENANT_ID, { limit: 10 });

    const byId = new Map(page.items.map((row) => [row.id, row]));
    expect(byId.get("r1")).toMatchObject({
      lineCount: 2,
      deletedCount: 1,
      totalCostSYP: "200000",
    });
    expect(byId.get("r2")).toMatchObject({
      lineCount: 1,
      deletedCount: 0,
      totalCostSYP: "50000",
    });
    expect(byId.get("r3")).toMatchObject({
      lineCount: 0,
      deletedCount: 2,
      totalCostSYP: "0", // deleted lines are NEVER counted into the total
    });

    // The no-N+1 contract: exactly ONE grouped query per table for the page,
    // no matter how many receipts it holds.
    expect(db.productBatch.groupBy).toHaveBeenCalledTimes(1);
    expect(db.batchDeletionLog.groupBy).toHaveBeenCalledTimes(1);
    expect(db.productBatch.groupBy.mock.calls[0][0].where.receiptId.in).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });

  it("a receipt whose lines are ALL deleted still appears in the list", async () => {
    RECEIPTS_STORE = [receipt("gone", "2026-06-01T00:00:00.000Z", "2026-06-01T09:00:00.000Z")];
    const db = makeListDb({ deletions: [{ tenantId: TENANT_ID, receiptId: "gone" }] });

    const page = await listReceiptsForTenant(db as any, TENANT_ID, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: "gone", lineCount: 0, deletedCount: 1 });
  });

  it("never reads outside the tenant — every where clause carries tenantId", async () => {
    RECEIPTS_STORE = [receipt("r1", "2026-06-01T00:00:00.000Z", "2026-06-01T09:00:00.000Z")];
    const db = makeListDb({
      batches: [{ tenantId: TENANT_ID, receiptId: "r1", totalCostSYP: d("10") }],
    });

    await listReceiptsForTenant(db as any, TENANT_ID, {});
    expect(db.productReceipt.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
    expect(db.productBatch.groupBy.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
    expect(db.batchDeletionLog.groupBy.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// 4. Detail — live lines, deleted lines, the total, all-deleted receipts
// ---------------------------------------------------------------------------

interface DetailFixture {
  receipt?: AnyRec | null;
  batches?: AnyRec[];
  deletions?: AnyRec[];
  soldGroups?: Array<{ batchId: string; unitId: string; sum: string }>;
  adjustmentGroups?: Array<{ batchId: string; sum: string }>;
  costChangeBatchIds?: string[];
  units?: Array<{ id: string; productId: string; unitName: string; conversionFactor: string }>;
  products?: Array<{ id: string; name: string }>;
}

function detailReceiptRow(id: string): AnyRec {
  return {
    id,
    tenantId: TENANT_ID,
    purchaseDate: date("2026-06-01T00:00:00.000Z"),
    createdAt: date("2026-06-01T09:00:00.000Z"),
    supplierName: "شركة الفجر",
    createdByUser: { id: "admin-1", name: "المدير" },
  };
}

function liveBatch(overrides: AnyRec = {}): AnyRec {
  return {
    id: "batch-1",
    productId: "prod-1",
    unitId: "unit-piece",
    batchNumber: "2026-06-01-INV1",
    expiryDate: null,
    createdAt: date("2026-06-01T09:00:00.000Z"),
    initialQuantity: d("100"),
    quantity: d("100"),
    totalCostSYP: d("100000"),
    costPricePerBaseUnit: d("1000"),
    unit: { unitName: "قطعة" },
    ...overrides,
  };
}

function makeDetailDb(fx: DetailFixture) {
  const batches = fx.batches ?? [];
  const deletions = fx.deletions ?? [];
  const units = fx.units ?? [];
  const products = fx.products ?? [];

  const db: AnyRec = {
    productReceipt: {
      findFirst: vi.fn(async (args: AnyRec) => {
        const row = fx.receipt ?? null;
        return row && row.id === args.where?.id && row.tenantId === args.where?.tenantId
          ? row
          : null;
      }),
      findMany: vi.fn(),
    },
    productBatch: {
      findMany: vi.fn(async () => batches),
      groupBy: vi.fn(),
    },
    batchDeletionLog: {
      findMany: vi.fn(async () => deletions),
      groupBy: vi.fn(),
    },
    invoiceItem: {
      groupBy: vi.fn(async (args: AnyRec) => {
        const ids: string[] = args.where?.batchId?.in ?? [];
        return (fx.soldGroups ?? [])
          .filter((g) => ids.includes(g.batchId))
          .map((g) => ({ batchId: g.batchId, unitId: g.unitId, _sum: { quantity: d(g.sum) } }));
      }),
    },
    stockAdjustment: {
      groupBy: vi.fn(async (args: AnyRec) => {
        const ids: string[] = args.where?.batchId?.in ?? [];
        return (fx.adjustmentGroups ?? [])
          .filter((g) => ids.includes(g.batchId))
          .map((g) => ({ batchId: g.batchId, _sum: { quantityDelta: d(g.sum) } }));
      }),
    },
    costPriceChangeLog: {
      groupBy: vi.fn(async (args: AnyRec) => {
        const ids: string[] = args.where?.batchId?.in ?? [];
        return (fx.costChangeBatchIds ?? [])
          .filter((id) => ids.includes(id))
          .map((batchId) => ({ batchId, _count: 1 }));
      }),
    },
    // ONE model, THREE sanctioned read shapes (factors / names / display
    // units) — exactly how units.ts and products.ts dispatch them.
    productUnit: {
      findMany: vi.fn(async (args: AnyRec) => {
        if (args.select && "conversionFactor" in args.select) {
          const ids: string[] = args.where?.id?.in ?? [];
          return units
            .filter((u) => ids.includes(u.id))
            .map((u) => ({ id: u.id, conversionFactor: u.conversionFactor }));
        }
        if (args.select && "unitName" in args.select) {
          const ids: string[] = args.where?.id?.in ?? [];
          return units.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, unitName: u.unitName }));
        }
        const productIds: string[] = args.where?.productId?.in ?? [];
        return units
          .filter((u) => productIds.includes(u.productId))
          .map((u) => ({ ...u, barcodes: [] }));
      }),
    },
    product: {
      findMany: vi.fn(async (args: AnyRec) => {
        const ids: string[] = args.where?.id?.in ?? [];
        return products.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, name: p.name }));
      }),
    },
  };
  return db;
}

const BASE_UNITS = [
  { id: "unit-piece", productId: "prod-1", unitName: "قطعة", conversionFactor: "1" },
  { id: "unit-carton", productId: "prod-1", unitName: "كرتونة", conversionFactor: "24" },
];

describe("getReceiptDetail — live + deleted lines and the total", () => {
  it("sums ONLY live lines; deleted lines appear with their snapshot, excluded from the total", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("r1"),
      batches: [
        liveBatch({ id: "b1", totalCostSYP: d("100000") }),
        liveBatch({ id: "b2", totalCostSYP: d("50000") }),
      ],
      deletions: [
        {
          batchId: "b-gone",
          productId: "prod-1",
          unitId: "unit-piece",
          batchNumber: "2026-05-30-OLD",
          quantityAtDeletion: d("40"),
          initialQuantityAtDeletion: d("60"),
          totalCostAtDeletion: d("900000"),
          costPriceAtDeletion: d("15000"),
          reason: "انتهت الصلاحية",
          createdAt: date("2026-06-02T08:00:00.000Z"),
          deletedByUser: { name: "المدير" },
        },
      ],
      products: [{ id: "prod-1", name: "زيت دوار الشمس" }],
      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "r1");

    expect(detail).not.toBeNull();
    // 100000 + 50000 — the deleted line's 900000 is EXCLUDED by design.
    // (Compared as a decimal, not a string: sumMoney may render trailing
    // zeros — "150000.0000" — both are the same SYP figure.)
    expect(new Decimal(detail!.totalCostSYP).eq("150000")).toBe(true);
    expect(detail!.liveLineCount).toBe(2);
    expect(detail!.deletedLineCount).toBe(1);

    const deleted = detail!.deletedLines[0];
    expect(deleted).toMatchObject({
      batchId: "b-gone",
      initialQuantityAtDeletion: "60",
      totalCostAtDeletion: "900000",
      reason: "انتهت الصلاحية",
      productName: "زيت دوار الشمس",
    });
    expect(deleted.deletedByName).toBe("المدير");
  });

  it("returns a receipt whose lines are ALL deleted: empty live list, total 0, deletions shown", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("r2"),
      batches: [],
      deletions: [
        {
          batchId: "b-gone",
          productId: "prod-1",
          unitId: "unit-piece",
          batchNumber: "2026-05-30-OLD",
          quantityAtDeletion: d("0"),
          initialQuantityAtDeletion: d("60"),
          totalCostAtDeletion: d("900000"),
          costPriceAtDeletion: d("15000"),
          reason: "إدخال خاطئ",
          createdAt: date("2026-06-02T08:00:00.000Z"),
          deletedByUser: null,
        },
      ],
      products: [{ id: "prod-1", name: "زيت دوار الشمس" }],
      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "r2");

    expect(detail).not.toBeNull();
    expect(detail!.lines).toHaveLength(0);
    expect(detail!.liveLineCount).toBe(0);
    expect(detail!.deletedLineCount).toBe(1);
    expect(detail!.deletedLines).toHaveLength(1);
    expect(detail!.totalCostSYP).toBe("0");
  });

  it("returns null for an unknown/foreign receipt id (the route maps it to 404)", async () => {
    const db = makeDetailDb({ receipt: detailReceiptRow("r1") });
    expect(await getReceiptDetail(db as any, TENANT_ID, "someone-elses-id")).toBeNull();
  });

  it("carries the display breakdown, costAdjusted flag and every figure per live line", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("r3"),
      batches: [liveBatch({ id: "b1", initialQuantity: d("240"), quantity: d("180") })],
      costChangeBatchIds: ["b1"],
      products: [{ id: "prod-1", name: "زيت دوار الشمس" }],
      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "r3");
    const line = detail!.lines[0];

    expect(line).toMatchObject({
      initialQuantity: "240",
      remaining: "180",
      costAdjusted: true, // a CostPriceChangeLog row exists for this batch
      totalCostSYP: "100000",
      productName: "زيت دوار الشمس",
      unitName: "قطعة",
    });
    // 240 base pieces = exactly 10 كرتونة — decomposed by units.ts's
    // breakdownForDisplay(), never recomputed here.
    expect(line.initialQuantityBreakdown).toEqual([
      { unitId: "unit-carton", unitName: "كرتونة", count: "10" },
    ]);
  });

  it("never queries per line — one batch fetch and one groupBy per table regardless of line count", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("r4"),
      batches: [
        liveBatch({ id: "b1" }),
        liveBatch({ id: "b2" }),
        liveBatch({ id: "b3" }),
      ],
      soldGroups: [{ batchId: "b1", unitId: "unit-carton", sum: "1" }],
      products: [{ id: "prod-1", name: "زيت" }],
      units: BASE_UNITS,
    });

    await getReceiptDetail(db as any, TENANT_ID, "r4");

    expect(db.productBatch.findMany).toHaveBeenCalledTimes(1);
    expect(db.invoiceItem.groupBy).toHaveBeenCalledTimes(1);
    expect(db.stockAdjustment.groupBy).toHaveBeenCalledTimes(1);
    expect(db.costPriceChangeLog.groupBy).toHaveBeenCalledTimes(1);
    // Factors + unit-names + display-unit sets: 3 unit reads total, never one
    // per line/unit. product.findMany once for names.
    expect(db.productUnit.findMany).toHaveBeenCalledTimes(3);
    expect(db.product.findMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Reconciliation identity — remaining = initial − netSold + adjustments
// ---------------------------------------------------------------------------

describe("getReceiptDetail — reconciliation identity", () => {
  it("100 received, 3 packs sold, 1 pack voided, −2 adjustment → remaining 50, reconciles true (sold unit's factor ≠ 1)", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("rr"),
      batches: [liveBatch({ id: "b1", initialQuantity: d("100"), quantity: d("50") })],
      // Sold in PACKS (factor 24), stored per (batchId, unitId): 3 packs sold
      // and the void's −1 pack already summed in → net 2 packs = 48 base
      // units. Using the BASE unit's factor (1) here would compute netSold=2
      // and the identity would fail — that is exactly the bug this pins.
      soldGroups: [{ batchId: "b1", unitId: "unit-carton", sum: "2" }],
      adjustmentGroups: [{ batchId: "b1", sum: "-2" }],
      products: [{ id: "prod-1", name: "زيت" }],
      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "rr");
    const line = detail!.lines[0];

    expect(line.netSold).toBe("48"); // 2 packs × 24 — the SOLD unit's factor
    expect(line.adjustments).toBe("-2");
    expect(line.remaining).toBe("50");
    expect(line.initialQuantity).toBe("100");
    // 100 − 48 + (−2) = 50, exact decimal equality (no epsilon).
    expect(line.reconciles).toBe(true);

    // The factor map was read from the units the SALE was made in — the
    // query carries both units' ids, and the pack row's factor is 24.
    const factorCall = db.productUnit.findMany.mock.calls.find(
      (call: AnyRec) => call[0]?.select && "conversionFactor" in call[0].select
    );
    expect(factorCall[0].where.id.in).toEqual(
      expect.arrayContaining(["unit-carton", "unit-piece"])
    );
  });

  it("corrupts the stored quantity → reconciles flips to false (still surfaced, not hidden)", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("rr2"),
      batches: [liveBatch({ id: "b1", initialQuantity: d("100"), quantity: d("51") })],
      soldGroups: [{ batchId: "b1", unitId: "unit-carton", sum: "2" }],
      adjustmentGroups: [{ batchId: "b1", sum: "-2" }],
      products: [{ id: "prod-1", name: "زيت" }],
      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "rr2");
    expect(detail!.lines[0].reconciles).toBe(false);
    // The four figures are still all present so the warning can be shown
    // alongside the numbers it disagrees with.
    expect(detail!.lines[0]).toMatchObject({
      initialQuantity: "100",
      netSold: "48",
      adjustments: "-2",
      remaining: "51",
    });
  });

  it("a VOIDED sale nets out: +3 packs and its −1 mirror row are already one group", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("rr3"),
      // 100 − 48 + 0 = 52 remaining.
      batches: [liveBatch({ id: "b1", initialQuantity: d("100"), quantity: d("52") })],
      soldGroups: [{ batchId: "b1", unitId: "unit-carton", sum: "2" }],
      products: [{ id: "prod-1", name: "زيت" }],
      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "rr3");
    expect(detail!.lines[0].netSold).toBe("48");
    expect(detail!.lines[0].reconciles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. netSoldInBaseUnit — THE conversion site
// ---------------------------------------------------------------------------

describe("netSoldInBaseUnit (lib/inventory/units)", () => {
  const factors = new Map<string, string>([
    ["unit-piece", "1"],
    ["unit-carton", "24"],
    ["unit-box", "3.3"],
  ]);

  it("nets a void out exactly: 3 packs sold − 1 pack voided = 2 packs = 48 base units", () => {
    const net = netSoldInBaseUnit(
      [
        { unitId: "unit-carton", quantity: "3" },
        { unitId: "unit-carton", quantity: "-1" },
      ],
      factors
    );
    expect(net.toString()).toBe("48");
    // Cross-checked against the sanctioned single-row converter — the two
    // paths can never disagree.
    expect(net.toString()).toBe(toBaseUnit("2", "24").toString());
  });

  it("keeps fractional quantities exact: 2.5 × 3.3 = 8.25 (no float drift)", () => {
    const net = netSoldInBaseUnit([{ unitId: "unit-box", quantity: "2.5" }], factors);
    expect(net.toString()).toBe("8.25");
  });

  it("uses each row's OWN unit factor — never the base unit's 1", () => {
    const mixed = netSoldInBaseUnit(
      [
        { unitId: "unit-carton", quantity: "1" },
        { unitId: "unit-piece", quantity: "5" },
      ],
      factors
    );
    expect(mixed.toString()).toBe("29"); // 24 + 5, not 1 + 5
  });

  it("THROWS on a missing factor instead of silently assuming 1", () => {
    expect(() =>
      netSoldInBaseUnit([{ unitId: "unit-ghost", quantity: "3" }], factors)
    ).toThrow(/no conversion factor/);
  });

  it("sums an empty row set to zero", () => {
    expect(netSoldInBaseUnit([], factors).toString()).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// 7. Cursor codec + EXACT equality + static scans
// ---------------------------------------------------------------------------

describe("cursor codec & exact reconciliation equality", () => {
  it("a cursor built by encodeReceiptCursor positions the next page exactly (clients echo it verbatim)", async () => {
    RECEIPTS_STORE = [
      receipt("r-new", "2026-06-02T00:00:00.000Z", "2026-06-02T09:00:00.000Z"),
      receipt("r-old", "2026-05-30T00:00:00.000Z", "2026-05-30T09:00:00.000Z"),
    ];
    const db = makeListDb();

    const page = await listReceiptsForTenant(db as any, TENANT_ID, {
      limit: 5,
      cursor: encodeReceiptCursor({
        purchaseDate: "2026-06-02",
        createdAt: "2026-06-02T09:00:00.000Z",
        id: "r-new",
      }),
    });
    expect(page.items.map((r) => r.id)).toEqual(["r-old"]);
  });

  it("the identity uses EXACT decimal equality — a 0.0001 drift is false, not tolerated away", () => {
    const base = {
      initialQuantity: "100",
      netSold: "48",
      adjustments: "-2",
      remaining: "50",
    };
    expect(reconciliationIdentityHolds(base)).toBe(true);
    expect(reconciliationIdentityHolds({ ...base, remaining: "50.0001" })).toBe(false);
    // Unparseable input is false (render as a warning), never a crash.
    expect(reconciliationIdentityHolds({ ...base, remaining: "not-a-number" })).toBe(false);
  });
});

describe("static scans — [v4.7] Round B invariants", () => {
  const read = (relative: string) =>
    fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
  /**
   * Scans run on CODE, not on comments — several headers deliberately name
   * the very words they forbid ("this file never names conversionFactor"),
   * and stripping comments keeps those explanations honest instead of
   * forcing them to be reworded around the scan.
   */
  const code = (relative: string) =>
    read(relative)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

  const ROUTE_FILES = [
    "app/api/receipts/route.ts",
    "app/api/receipts/[id]/route.ts",
    "app/api/receipts/defaults/route.ts",
  ];
  const READ_PATH_FILES = [...ROUTE_FILES, "lib/data/receipt-history.ts"];

  it("no writes at all in the read gateway; the routes' ONLY write is productReceipt.update", () => {
    const history = code("lib/data/receipt-history.ts");
    // The whole read layer is query-only.
    for (const method of [".create(", ".update(", ".upsert(", ".delete(", ".execute("]) {
      expect(history).not.toContain(method);
    }
    for (const file of ROUTE_FILES) {
      const source = code(file);
      // No create/delete anywhere; [id] holds exactly ONE update and it is
      // the plain top-level productReceipt.update (never a batch write).
      expect(source).not.toContain(".create(");
      expect(source).not.toContain(".delete(");
    }
    const idRoute = code("app/api/receipts/[id]/route.ts");
    expect(idRoute.match(/\.update\(/g) ?? []).toHaveLength(1);
    expect(idRoute).toContain("productReceipt.update");
    expect(idRoute).not.toContain("productBatch.update");
  });

  it("no nested writes: no batch/collection keys inside any payload in the receipts routes", () => {
    for (const file of ROUTE_FILES) {
      const source = code(file);
      expect(source).not.toMatch(/batches\s*:\s*\{/);
      expect(source).not.toMatch(/items\s*:\s*\{\s*create/);
      expect(source).not.toMatch(/data\s*:\s*\{[^\n]*receipt\s*:\s*\{/);
    }
    // PATCH's payload may only ever name the two allowed columns.
    const idRoute = code("app/api/receipts/[id]/route.ts");
    expect(idRoute).not.toContain("initialQuantity");
    expect(idRoute).not.toContain("totalCostSYP");
    expect(idRoute).not.toContain("quantity");
  });

  it("no conversion arithmetic outside lib/inventory/units.ts", () => {
    for (const file of READ_PATH_FILES) {
      const source = code(file);
      // The read path may not name the factor at all — factors are fetched
      // by units.ts's getUnitConversionFactors() and consumed by
      // netSoldInBaseUnit()/breakdownForDisplay() inside units.ts.
      expect(source).not.toContain("conversionFactor");
      expect(source).not.toContain("toBaseUnit(");
      expect(source).not.toContain("fromBaseUnit(");
      expect(source).not.toContain("new Decimal");
    }
    // receipt-history DELEGATES every quantity operation to units.ts.
    const history = read("lib/data/receipt-history.ts");
    expect(history).toContain('from "@/lib/inventory/units"');
    expect(history).toContain("netSoldInBaseUnit");
    expect(history).toContain("reconciliationIdentityHolds");
    expect(history).toContain("breakdownForDisplay");
  });

  it("no USD / exchange-rate field anywhere in the receipts read path (SYP only)", () => {
    for (const file of READ_PATH_FILES) {
      const source = code(file);
      expect(source).not.toMatch(/USD/);
      expect(source).not.toMatch(/exchangeRate/i);
      expect(source).not.toMatch(/dailyExchangeRate/);
    }
  });
});







