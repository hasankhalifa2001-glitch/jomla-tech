/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * lib/data/__tests__/v47-receipts-history.test.ts
 *
 * [v4.8, Round B] Receipt history read-side tests.
 *
 * Tests the REAL data layer with a fake Prisma boundary.
 *
 * Coverage:
 * 1. Three-key cursor pagination: purchaseDate, createdAt, id.
 * 2. Inclusive business-date filters and case-insensitive supplier search.
 * 3. Grouped totals/counts, tenant isolation, no N+1.
 * 4. Live/deleted receipt details and live-only totals.
 * 5. Reconciliation using SUM(InvoiceItem.baseQuantity).
 * 6. Exact decimal reconciliation equality.
 * 7. Static scans for read-only behavior, conversion boundaries and SYP-only
 *    receipt history.
 *
 * v4.8: netSoldInBaseUnit was removed. netSold is now the database sum of
 * InvoiceItem.baseQuantity, already expressed in the product's base unit.
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
  reconciliationIdentityHolds,
} from "@/lib/inventory/units";

const TENANT_ID = "tenant-1";

// ---------------------------------------------------------------------------
// Fake Prisma boundary.
// ---------------------------------------------------------------------------

type AnyRec = Record<string, any>;

type DecimalValue = InstanceType<typeof Decimal>;

function d(value: string | number): DecimalValue {
  return new Decimal(value);
}

function date(iso: string): Date {
  return new Date(iso);
}

/** One ProductReceipt-shaped row (@db.Date stored at UTC midnight). */
function receipt(
  id: string,
  purchaseDate: string,
  createdAt: string,
  supplier: string | null = null
): AnyRec {
  return {
    id,
    tenantId: TENANT_ID,
    purchaseDate: date(purchaseDate),
    createdAt: date(createdAt),
    supplierName: supplier,
    createdByUser: { name: "مدير" },
  };
}

/** Evaluates the where vocabulary emitted by listReceiptsForTenant. */
function matchesReceiptWhere(row: AnyRec, where: AnyRec): boolean {
  if (where.tenantId && row.tenantId !== where.tenantId) {
    return false;
  }

  if (where.purchaseDate) {
    const { gte, lte } = where.purchaseDate;

    if (gte && row.purchaseDate.getTime() < gte.getTime()) {
      return false;
    }

    if (lte && row.purchaseDate.getTime() > lte.getTime()) {
      return false;
    }
  }

  if (where.supplierName) {
    const needle = String(
      where.supplierName.contains ?? ""
    ).toLowerCase();

    const hay = (row.supplierName ?? "").toLowerCase();

    if (!hay.includes(needle)) {
      return false;
    }
  }

  if (Array.isArray(where.AND)) {
    for (const clause of where.AND) {
      if (!matchesKeyset(row, clause)) {
        return false;
      }
    }
  }

  return true;
}

/** The keyset predicate: OR of the three (purchaseDate, createdAt, id) DESC steps. */
function matchesKeyset(row: AnyRec, clause: AnyRec): boolean {
  const or: AnyRec[] = clause.OR ?? [];

  for (const branch of or) {
    const pd = branch.purchaseDate;

    if (pd instanceof Date) {
      if (row.purchaseDate.getTime() !== pd.getTime()) {
        continue;
      }

      const ca = branch.createdAt;

      if (ca instanceof Date) {
        if (
          row.createdAt.getTime() === ca.getTime() &&
          branch.id?.lt !== undefined &&
          row.id < branch.id.lt
        ) {
          return true;
        }
      } else if (ca?.lt instanceof Date) {
        if (row.createdAt.getTime() < ca.lt.getTime()) {
          return true;
        }
      }
    } else if (pd?.lt instanceof Date) {
      if (row.purchaseDate.getTime() < pd.lt.getTime()) {
        return true;
      }
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

/** Grouped totals fake: one groupBy per table per page. */
function makeListDb(
  options: {
    batches?: AnyRec[];
    deletions?: AnyRec[];
  } = {}
) {
  const batches = options.batches ?? [];
  const deletions = options.deletions ?? [];

  const productBatch = {
    findMany: vi.fn(),

    groupBy: vi.fn(async (args: AnyRec) => {
      const ids: string[] = args.where?.receiptId?.in ?? [];

      const rows = batches.filter(
        (b) =>
          b.tenantId === args.where?.tenantId &&
          ids.includes(b.receiptId)
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
            .reduce(
              (acc, row) => acc.plus(row.totalCostSYP),
              new Decimal(0)
            )
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
        (row) =>
          row.tenantId === args.where?.tenantId &&
          ids.includes(row.receiptId)
      );

      const byReceipt = new Map<string, number>();

      for (const row of rows) {
        byReceipt.set(
          row.receiptId,
          (byReceipt.get(row.receiptId) ?? 0) + 1
        );
      }

      return [...byReceipt.entries()].map(([receiptId, count]) => ({
        receiptId,
        _count: count,
      }));
    }),
  };

  const productReceipt = {
    findMany: vi.fn(async (args: AnyRec) => {
      const filtered = RECEIPTS_STORE.filter((row) =>
        matchesReceiptWhere(row, args.where ?? {})
      ).sort(byDesc);

      return filtered.slice(0, args.take);
    }),

    findFirst: vi.fn(),
  };

  return {
    productReceipt,
    productBatch,
    batchDeletionLog,
  };
}

/** The store the list fake reads from. */
let RECEIPTS_STORE: AnyRec[] = [];

beforeEach(() => {
  RECEIPTS_STORE = [];
});

// ---------------------------------------------------------------------------
// 1. Cursor pagination — all three sort keys.
// ---------------------------------------------------------------------------

describe("listReceiptsForTenant — cursor pagination", () => {
  it("walks rows sharing purchaseDate and createdAt exactly once each", async () => {
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
      const page = await listReceiptsForTenant(
        db as any,
        TENANT_ID,
        { limit: 2, cursor }
      );

      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;

      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(["r-5", "r-4", "r-3", "r-2", "r-1"]);
  });

  it("keeps ordering correct when dates and timestamps differ across pages", async () => {
    RECEIPTS_STORE = [
      receipt("a", "2026-06-03T00:00:00.000Z", "2026-06-03T10:00:00.000Z"),
      receipt("b", "2026-06-02T00:00:00.000Z", "2026-06-02T10:00:00.000Z"),
      receipt("c", "2026-06-02T00:00:00.000Z", "2026-06-02T08:00:00.000Z"),
      receipt("d", "2026-06-01T00:00:00.000Z", "2026-06-01T10:00:00.000Z"),
    ];

    const db = makeListDb();

    const first = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      { limit: 2 }
    );

    expect(first.items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      {
        limit: 2,
        cursor: first.nextCursor!,
      }
    );

    expect(second.items.map((r) => r.id)).toEqual(["c", "d"]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor before touching the store", async () => {
    const db = makeListDb();

    await expect(
      listReceiptsForTenant(
        db as any,
        TENANT_ID,
        { cursor: "not-a-valid-cursor" }
      )
    ).rejects.toBeInstanceOf(InvalidReceiptCursorError);

    expect(db.productReceipt.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Filters — purchaseDate and supplierName.
// ---------------------------------------------------------------------------

describe("listReceiptsForTenant — filters", () => {
  beforeEach(() => {
    RECEIPTS_STORE = [
      receipt(
        "old",
        "2026-01-10T00:00:00.000Z",
        "2026-01-10T08:00:00.000Z",
        "شركة الأقدم"
      ),
      receipt(
        "mid",
        "2026-03-05T00:00:00.000Z",
        "2026-03-05T08:00:00.000Z",
        "مؤسسة الوسط"
      ),
      receipt(
        "new",
        "2026-06-20T00:00:00.000Z",
        "2026-06-20T08:00:00.000Z",
        "شركة الفجر"
      ),
    ];
  });

  it("filters on purchaseDate with an inclusive date window", async () => {
    const db = makeListDb();

    const page = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      {
        from: "2026-03-01",
        to: "2026-06-30",
      }
    );

    expect(page.items.map((r) => r.id)).toEqual(["new", "mid"]);

    const where = db.productReceipt.findMany.mock.calls[0][0].where;

    expect(where.purchaseDate.gte).toEqual(
      new Date("2026-03-01T00:00:00.000Z")
    );

    expect(where.purchaseDate.lte).toEqual(
      new Date("2026-06-30T00:00:00.000Z")
    );
  });

  it("a single-day window keeps only that purchaseDate", async () => {
    const db = makeListDb();

    const page = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      {
        from: "2026-03-05",
        to: "2026-03-05",
      }
    );

    expect(page.items.map((r) => r.id)).toEqual(["mid"]);
  });

  it("omits purchaseDate when no date bounds are supplied", async () => {
    const db = makeListDb();

    await listReceiptsForTenant(db as any, TENANT_ID, {});

    const where = db.productReceipt.findMany.mock.calls[0][0].where;

    expect(where.purchaseDate).toBeUndefined();
  });

  it("matches supplierName case-insensitively as a partial match", async () => {
    const db = makeListDb();

    const page = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      { supplierName: "الفجر" }
    );

    expect(page.items.map((r) => r.id)).toEqual(["new"]);

    const where = db.productReceipt.findMany.mock.calls[0][0].where;

    expect(where.supplierName).toEqual({
      contains: "الفجر",
      mode: "insensitive",
    });
  });

  it("composes date bounds and cursor in the same query", async () => {
    const db = makeListDb();

    const first = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      {
        limit: 1,
        from: "2026-03-01",
        to: "2026-06-30",
      }
    );

    expect(first.items.map((r) => r.id)).toEqual(["new"]);

    const second = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      {
        limit: 1,
        from: "2026-03-01",
        to: "2026-06-30",
        cursor: first.nextCursor!,
      }
    );

    expect(second.items.map((r) => r.id)).toEqual(["mid"]);
  });
});

// ---------------------------------------------------------------------------
// 3. List totals/counts — grouped queries and tenant isolation.
// ---------------------------------------------------------------------------

describe("listReceiptsForTenant — totals and counts", () => {
  it("uses one groupBy per table for the page and counts live/deleted lines separately", async () => {
    RECEIPTS_STORE = [
      receipt("r1", "2026-06-01T00:00:00.000Z", "2026-06-01T09:00:00.000Z"),
      receipt("r2", "2026-05-01T00:00:00.000Z", "2026-05-01T09:00:00.000Z"),
      receipt("r3", "2026-04-01T00:00:00.000Z", "2026-04-01T09:00:00.000Z"),
    ];

    const db = makeListDb({
      batches: [
        {
          tenantId: TENANT_ID,
          receiptId: "r1",
          totalCostSYP: d("120000"),
        },
        {
          tenantId: TENANT_ID,
          receiptId: "r1",
          totalCostSYP: d("80000"),
        },
        {
          tenantId: TENANT_ID,
          receiptId: "r2",
          totalCostSYP: d("50000"),
        },
      ],
      deletions: [
        { tenantId: TENANT_ID, receiptId: "r1" },
        { tenantId: TENANT_ID, receiptId: "r3" },
        { tenantId: TENANT_ID, receiptId: "r3" },
      ],
    });

    const page = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      { limit: 10 }
    );

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
      totalCostSYP: "0",
    });

    expect(db.productBatch.groupBy).toHaveBeenCalledTimes(1);
    expect(db.batchDeletionLog.groupBy).toHaveBeenCalledTimes(1);

    expect(
      db.productBatch.groupBy.mock.calls[0][0].where.receiptId.in
    ).toEqual(["r1", "r2", "r3"]);
  });

  it("keeps a receipt visible when all its lines have been deleted", async () => {
    RECEIPTS_STORE = [
      receipt(
        "gone",
        "2026-06-01T00:00:00.000Z",
        "2026-06-01T09:00:00.000Z"
      ),
    ];

    const db = makeListDb({
      deletions: [
        { tenantId: TENANT_ID, receiptId: "gone" },
      ],
    });

    const page = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      {}
    );

    expect(page.items).toHaveLength(1);

    expect(page.items[0]).toMatchObject({
      id: "gone",
      lineCount: 0,
      deletedCount: 1,
      totalCostSYP: "0",
    });
  });

  it("includes tenantId in every grouped/list query", async () => {
    RECEIPTS_STORE = [
      receipt(
        "r1",
        "2026-06-01T00:00:00.000Z",
        "2026-06-01T09:00:00.000Z"
      ),
    ];

    const db = makeListDb({
      batches: [
        {
          tenantId: TENANT_ID,
          receiptId: "r1",
          totalCostSYP: d("10"),
        },
      ],
    });

    await listReceiptsForTenant(db as any, TENANT_ID, {});

    expect(
      db.productReceipt.findMany.mock.calls[0][0].where.tenantId
    ).toBe(TENANT_ID);

    expect(
      db.productBatch.groupBy.mock.calls[0][0].where.tenantId
    ).toBe(TENANT_ID);

    expect(
      db.batchDeletionLog.groupBy.mock.calls[0][0].where.tenantId
    ).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// 4. Detail fixtures — v4.8 sums baseQuantity directly.
// ---------------------------------------------------------------------------

interface DetailFixture {
  receipt?: AnyRec | null;
  batches?: AnyRec[];
  deletions?: AnyRec[];

  /** SUM(InvoiceItem.baseQuantity), already in base units. */
  soldGroups?: Array<{
    batchId: string;
    sum: string;
  }>;

  adjustmentGroups?: Array<{
    batchId: string;
    sum: string;
  }>;

  costChangeBatchIds?: string[];

  units?: Array<{
    id: string;
    productId: string;
    unitName: string;
    conversionFactor: string;
  }>;

  products?: Array<{
    id: string;
    name: string;
  }>;
}

function detailReceiptRow(id: string): AnyRec {
  return {
    id,
    tenantId: TENANT_ID,
    purchaseDate: date("2026-06-01T00:00:00.000Z"),
    createdAt: date("2026-06-01T09:00:00.000Z"),
    supplierName: "شركة الفجر",
    createdByUser: {
      id: "admin-1",
      name: "المدير",
    },
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

        return row &&
          row.id === args.where?.id &&
          row.tenantId === args.where?.tenantId
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
          .filter((group) => ids.includes(group.batchId))
          .map((group) => ({
            batchId: group.batchId,
            _sum: {
              baseQuantity: d(group.sum),
            },
          }));
      }),
    },

    stockAdjustment: {
      groupBy: vi.fn(async (args: AnyRec) => {
        const ids: string[] = args.where?.batchId?.in ?? [];

        return (fx.adjustmentGroups ?? [])
          .filter((group) => ids.includes(group.batchId))
          .map((group) => ({
            batchId: group.batchId,
            _sum: {
              quantityDelta: d(group.sum),
            },
          }));
      }),
    },

    costPriceChangeLog: {
      groupBy: vi.fn(async (args: AnyRec) => {
        const ids: string[] = args.where?.batchId?.in ?? [];

        return (fx.costChangeBatchIds ?? [])
          .filter((id) => ids.includes(id))
          .map((batchId) => ({
            batchId,
            _count: 1,
          }));
      }),
    },

    productUnit: {
      findMany: vi.fn(async (args: AnyRec) => {
        if (args.select && "conversionFactor" in args.select) {
          const ids: string[] = args.where?.id?.in ?? [];

          return units
            .filter((unit) => ids.includes(unit.id))
            .map((unit) => ({
              id: unit.id,
              conversionFactor: unit.conversionFactor,
            }));
        }

        if (args.select && "unitName" in args.select) {
          const ids: string[] = args.where?.id?.in ?? [];

          return units
            .filter((unit) => ids.includes(unit.id))
            .map((unit) => ({
              id: unit.id,
              unitName: unit.unitName,
            }));
        }

        const productIds: string[] =
          args.where?.productId?.in ?? [];

        return units
          .filter((unit) => productIds.includes(unit.productId))
          .map((unit) => ({
            ...unit,
            barcodes: [],
          }));
      }),
    },

    product: {
      findMany: vi.fn(async (args: AnyRec) => {
        const ids: string[] = args.where?.id?.in ?? [];

        return products
          .filter((product) => ids.includes(product.id))
          .map((product) => ({
            id: product.id,
            name: product.name,
          }));
      }),
    },
  };

  return db;
}

const BASE_UNITS = [
  {
    id: "unit-piece",
    productId: "prod-1",
    unitName: "قطعة",
    conversionFactor: "1",
  },
  {
    id: "unit-carton",
    productId: "prod-1",
    unitName: "كرتونة",
    conversionFactor: "24",
  },
];

// ---------------------------------------------------------------------------
// 5. Detail — live/deleted lines, totals, display and query counts.
// ---------------------------------------------------------------------------

describe("getReceiptDetail — live and deleted lines", () => {
  it("sums only live lines and preserves deleted-line snapshots", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("r1"),

      batches: [
        liveBatch({
          id: "b1",
          totalCostSYP: d("100000"),
        }),
        liveBatch({
          id: "b2",
          totalCostSYP: d("50000"),
        }),
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

      products: [
        {
          id: "prod-1",
          name: "زيت دوار الشمس",
        },
      ],

      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "r1");

    expect(detail).not.toBeNull();

    expect(
      new Decimal(detail!.totalCostSYP).eq("150000")
    ).toBe(true);

    expect(detail!.liveLineCount).toBe(2);
    expect(detail!.deletedLineCount).toBe(1);

    expect(detail!.deletedLines[0]).toMatchObject({
      batchId: "b-gone",
      initialQuantityAtDeletion: "60",
      totalCostAtDeletion: "900000",
      reason: "انتهت الصلاحية",
      productName: "زيت دوار الشمس",
    });

    expect(detail!.deletedLines[0].deletedByName).toBe("المدير");
  });

  it("returns a receipt whose lines are all deleted", async () => {
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

      products: [
        {
          id: "prod-1",
          name: "زيت دوار الشمس",
        },
      ],

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

  it("returns null for an unknown or foreign receipt id", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("r1"),
    });

    expect(
      await getReceiptDetail(db as any, TENANT_ID, "someone-elses-id")
    ).toBeNull();
  });

  it("returns display breakdown, costAdjusted and every live-line figure", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("r3"),

      batches: [
        liveBatch({
          id: "b1",
          initialQuantity: d("240"),
          quantity: d("180"),
        }),
      ],

      costChangeBatchIds: ["b1"],

      products: [
        {
          id: "prod-1",
          name: "زيت دوار الشمس",
        },
      ],

      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "r3");
    const line = detail!.lines[0];

    expect(line).toMatchObject({
      initialQuantity: "240",
      remaining: "180",
      costAdjusted: true,
      totalCostSYP: "100000",
      productName: "زيت دوار الشمس",
      unitName: "قطعة",
    });

    expect(line.initialQuantityBreakdown).toEqual([
      {
        unitId: "unit-carton",
        unitName: "كرتونة",
        count: "10",
      },
    ]);
  });

  it("does not query once per live line", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("r4"),

      batches: [
        liveBatch({ id: "b1" }),
        liveBatch({ id: "b2" }),
        liveBatch({ id: "b3" }),
      ],

      soldGroups: [
        {
          batchId: "b1",
          sum: "24",
        },
      ],

      products: [
        {
          id: "prod-1",
          name: "زيت",
        },
      ],

      units: BASE_UNITS,
    });

    await getReceiptDetail(db as any, TENANT_ID, "r4");

    expect(db.productBatch.findMany).toHaveBeenCalledTimes(1);
    expect(db.invoiceItem.groupBy).toHaveBeenCalledTimes(1);
    expect(db.stockAdjustment.groupBy).toHaveBeenCalledTimes(1);
    expect(db.costPriceChangeLog.groupBy).toHaveBeenCalledTimes(1);

    // These counts depend on the current products gateway implementation.
    // The assertion here pins the fixed query count, not a per-line query.
    expect(db.productUnit.findMany.mock.calls.length).toBeLessThanOrEqual(3);
    expect(db.product.findMany).toHaveBeenCalledTimes(1);

    const soldCall = db.invoiceItem.groupBy.mock.calls[0][0];

    expect(soldCall.by).toEqual(["batchId"]);
    expect(soldCall._sum).toEqual({
      baseQuantity: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Reconciliation — v4.8 uses stored baseQuantity, without conversion.
// ---------------------------------------------------------------------------

describe("getReceiptDetail — v4.8 reconciliation identity", () => {
  it("reconciles using the stored base-unit sold quantity and adjustments", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("rr"),

      batches: [
        liveBatch({
          id: "b1",
          initialQuantity: d("100"),
          quantity: d("50"),
        }),
      ],

      // Three packs sold and one pack voided have already netted to
      // 48 base units in InvoiceItem.baseQuantity.
      // No conversion factor is applied in receipt-history.ts.
      soldGroups: [
        {
          batchId: "b1",
          sum: "48",
        },
      ],

      adjustmentGroups: [
        {
          batchId: "b1",
          sum: "-2",
        },
      ],

      products: [
        {
          id: "prod-1",
          name: "زيت",
        },
      ],

      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "rr");
    const line = detail!.lines[0];

    expect(line.netSold).toBe("48");
    expect(line.adjustments).toBe("-2");
    expect(line.remaining).toBe("50");
    expect(line.initialQuantity).toBe("100");
    expect(line.reconciles).toBe(true);

    // v4.8 reads the database's baseQuantity sum directly.
    const soldCall = db.invoiceItem.groupBy.mock.calls[0][0];

    expect(soldCall.by).toEqual(["batchId"]);
    expect(soldCall._sum).toEqual({
      baseQuantity: true,
    });

    expect(soldCall.where).toMatchObject({
      tenantId: TENANT_ID,
      batchId: { in: ["b1"] },
    });
  });

  it("surfaces corrupted stored quantity as a failed reconciliation", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("rr2"),

      batches: [
        liveBatch({
          id: "b1",
          initialQuantity: d("100"),
          quantity: d("51"),
        }),
      ],

      soldGroups: [
        {
          batchId: "b1",
          sum: "48",
        },
      ],

      adjustmentGroups: [
        {
          batchId: "b1",
          sum: "-2",
        },
      ],

      products: [
        {
          id: "prod-1",
          name: "زيت",
        },
      ],

      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "rr2");

    expect(detail!.lines[0].reconciles).toBe(false);

    expect(detail!.lines[0]).toMatchObject({
      initialQuantity: "100",
      netSold: "48",
      adjustments: "-2",
      remaining: "51",
    });
  });

  it("nets voided sales out through their negative baseQuantity", async () => {
    const db = makeDetailDb({
      receipt: detailReceiptRow("rr3"),

      batches: [
        liveBatch({
          id: "b1",
          initialQuantity: d("100"),
          quantity: d("52"),
        }),
      ],

      // Net sale after the void: 48 base units.
      soldGroups: [
        {
          batchId: "b1",
          sum: "48",
        },
      ],

      products: [
        {
          id: "prod-1",
          name: "زيت",
        },
      ],

      units: BASE_UNITS,
    });

    const detail = await getReceiptDetail(db as any, TENANT_ID, "rr3");

    expect(detail!.lines[0].netSold).toBe("48");
    expect(detail!.lines[0].reconciles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Cursor codec and exact reconciliation equality.
// ---------------------------------------------------------------------------

describe("cursor codec and exact reconciliation equality", () => {
  it("positions the next page using an encoded cursor", async () => {
    RECEIPTS_STORE = [
      receipt(
        "r-new",
        "2026-06-02T00:00:00.000Z",
        "2026-06-02T09:00:00.000Z"
      ),
      receipt(
        "r-old",
        "2026-05-30T00:00:00.000Z",
        "2026-05-30T09:00:00.000Z"
      ),
    ];

    const db = makeListDb();

    const page = await listReceiptsForTenant(
      db as any,
      TENANT_ID,
      {
        limit: 5,
        cursor: encodeReceiptCursor({
          purchaseDate: "2026-06-02",
          createdAt: "2026-06-02T09:00:00.000Z",
          id: "r-new",
        }),
      }
    );

    expect(page.items.map((r) => r.id)).toEqual(["r-old"]);
  });

  it("uses exact decimal equality with no tolerance", () => {
    const base = {
      initialQuantity: "100",
      netSold: "48",
      adjustments: "-2",
      remaining: "50",
    };

    expect(reconciliationIdentityHolds(base)).toBe(true);

    expect(
      reconciliationIdentityHolds({
        ...base,
        remaining: "50.0001",
      })
    ).toBe(false);

    expect(
      reconciliationIdentityHolds({
        ...base,
        remaining: "not-a-number",
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Static scans — read-only gateway and v4.8 invariants.
// ---------------------------------------------------------------------------

describe("static scans — receipt history invariants", () => {
  const read = (relative: string) =>
    fs.readFileSync(
      path.resolve(process.cwd(), relative),
      "utf8"
    );

  /**
   * Scan code, not comments. The source comments may discuss terms that
   * are forbidden in executable code.
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

  const READ_PATH_FILES = [
    ...ROUTE_FILES,
    "lib/data/receipt-history.ts",
  ];

  it("keeps the read gateway write-free and limits the detail route update", () => {
    const history = code("lib/data/receipt-history.ts");

    for (const method of [
      ".create(",
      ".update(",
      ".upsert(",
      ".delete(",
      ".execute(",
    ]) {
      expect(history).not.toContain(method);
    }

    for (const file of ROUTE_FILES) {
      const source = code(file);

      expect(source).not.toContain(".create(");
      expect(source).not.toContain(".delete(");
    }

    const idRoute = code("app/api/receipts/[id]/route.ts");

    expect(idRoute.match(/\.update\(/g) ?? []).toHaveLength(1);
    expect(idRoute).toContain("productReceipt.update");
    expect(idRoute).not.toContain("productBatch.update");
  });

  it("prevents nested batch/collection writes in receipt routes", () => {
    for (const file of ROUTE_FILES) {
      const source = code(file);

      expect(source).not.toMatch(/batches\s*:\s*\{/);
      expect(source).not.toMatch(/items\s*:\s*\{\s*create/);
      expect(source).not.toMatch(
        /data\s*:\s*\{[^\n]*receipt\s*:\s*\{/
      );
    }

    const idRoute = code("app/api/receipts/[id]/route.ts");

    expect(idRoute).not.toContain("initialQuantity");
    expect(idRoute).not.toContain("totalCostSYP");
    expect(idRoute).not.toContain("quantity");
  });

  it("keeps conversion arithmetic out of the receipt read path", () => {
    for (const file of READ_PATH_FILES) {
      const source = code(file);

      expect(source).not.toContain("conversionFactor");
      expect(source).not.toContain("toBaseUnit(");
      expect(source).not.toContain("fromBaseUnit(");
      expect(source).not.toContain("new Decimal");
    }

    const history = read("lib/data/receipt-history.ts");

    expect(history).toContain('from "@/lib/inventory/units"');
    expect(history).toContain("baseQuantity");
    expect(history).toContain("reconciliationIdentityHolds");
    expect(history).toContain("breakdownForDisplay");
  });

  it("keeps the receipt read path SYP-only without exchange-rate fields", () => {
    for (const file of READ_PATH_FILES) {
      const source = code(file);

      expect(source).not.toMatch(/USD/);
      expect(source).not.toMatch(/exchangeRate/i);
      expect(source).not.toMatch(/dailyExchangeRate/);
    }
  });
});