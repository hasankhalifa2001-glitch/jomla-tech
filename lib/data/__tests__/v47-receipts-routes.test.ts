/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * lib/data/__tests__/v47-receipts-routes.test.ts — [v4.7, Round B]
 * HTTP-level tests for the goods-receiving history endpoints, REAL handlers
 * under test (the t4c2 posture): only the session, the tenant-scoped client
 * and the subscription gate are faked. The list route runs the REAL
 * lib/data/receipt-history.ts against a fake Prisma boundary; the detail
 * route's gateway is stubbed here because v47-receipts-history.test.ts
 * already pins its behaviour exhaustively.
 *
 * Pins:
 *  1. AUTH: unauthenticated → 401; CASHIER → 403 on list, detail, PATCH and
 *     defaults — with ZERO data read (getTenantDb is never even called, so
 *     no query can have been issued) and the write gate never reached.
 *  2. PATCH STRICTNESS: only purchaseDate/supplierName — a financial or
 *     unknown key is 400 BEFORE any DB round-trip; future / too-old dates
 *     are 400; success writes ONLY those two columns via one top-level
 *     update and never touches productBatch (batches unchanged).
 *  3. LIST validation: impossible dates, from > to, over-max limit and a
 *     malformed cursor are all 400 without querying.
 *  4. The role-matrix rows (receipts:view / receipts:edit) are ADMIN-only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { h } = vi.hoisted(() => {
  const db: any = {
    productReceipt: {
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    productBatch: {
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
      update: vi.fn(),
      create: vi.fn(),
    },
    batchDeletionLog: {
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
  };
  return {
    h: {
      db,
      getTenantDb: vi.fn(() => db),
      session: { current: null as any },
      assertTenantWritable: vi.fn(async (): Promise<any> => "ACTIVE"),
      getReceiptDetail: vi.fn(async (): Promise<any> => null),
    },
  };
});

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: h.getTenantDb,
  tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => h.session.current),
}));

vi.mock("@/lib/auth/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/tenant")>();
  return { ...actual, assertTenantWritable: h.assertTenantWritable };
});

// Detail gateway only — the list path below runs the REAL gateway.
vi.mock("@/lib/data/receipt-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/receipt-history")>();
  return { ...actual, getReceiptDetail: h.getReceiptDetail };
});

import { GET as listReceipts } from "@/app/api/receipts/route";
import {
  GET as getReceiptDetailRoute,
  PATCH as patchReceipt,
} from "@/app/api/receipts/[id]/route";
import { GET as getReceiptDefaults } from "@/app/api/receipts/defaults/route";
import { ROLE_CAPABILITY_MATRIX } from "@/lib/auth/role-matrix";
import { getBusinessDate } from "@/lib/inventory/date-utils";
import { addLocalDays, localDayKey } from "@/lib/utils/syria-time";

const TENANT_ID = "tenant-1";
const RECEIPT_ID = "receipt-1";

function setSession(role: "ADMIN" | "CASHIER" | null) {
  h.session.current = role
    ? {
        user: {
          id: role === "ADMIN" ? "admin-1" : "cashier-1",
          role,
          tenantId: TENANT_ID,
        },
      }
    : null;
}

function listReq(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/receipts${query ? `?${query}` : ""}`);
}

const detailCtx = (id: string) => ({ params: Promise.resolve({ id }) });

function detailReq(): NextRequest {
  return new NextRequest(`http://localhost/api/receipts/${RECEIPT_ID}`);
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/receipts/${RECEIPT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const today = () => getBusinessDate();
const tomorrow = () => localDayKey(addLocalDays(new Date(), 1));
const longAgo = () => localDayKey(addLocalDays(new Date(), -800));

beforeEach(() => {
  vi.clearAllMocks();
  h.session.current = null;
  h.assertTenantWritable.mockResolvedValue("ACTIVE" as any);
  h.getReceiptDetail.mockResolvedValue(null as any);
  h.db.productReceipt.findMany.mockImplementation(async () => []);
  h.db.productReceipt.findFirst.mockResolvedValue({ id: RECEIPT_ID });
  h.db.productReceipt.update.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// 1. AUTH — 401 / 403 with ZERO data read
// ---------------------------------------------------------------------------

describe("[v4.7] receipts routes — authentication & role gate", () => {
  it("rejects an unauthenticated request with 401 on list, detail, PATCH and defaults — zero reads", async () => {
    setSession(null);

    const list = await listReceipts(listReq());
    const detail = await getReceiptDetailRoute(detailReq(), detailCtx(RECEIPT_ID));
    const patched = await patchReceipt(patchReq({ supplierName: "x" }), detailCtx(RECEIPT_ID));
    const defaults = await getReceiptDefaults();

    for (const res of [list, detail, patched, defaults]) {
      expect(res.status).toBe(401);
    }
    expect(h.getTenantDb).not.toHaveBeenCalled();
    expect(h.assertTenantWritable).not.toHaveBeenCalled();
  });

  it("rejects a CASHIER with 403 on the list route with zero data read", async () => {
    setSession("CASHIER");
    const res = await listReceipts(listReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("FORBIDDEN");
    // The role check runs BEFORE getTenantDb → no client, no query.
    expect(h.getTenantDb).not.toHaveBeenCalled();
    expect(h.db.productReceipt.findMany).not.toHaveBeenCalled();
    expect(h.db.productBatch.groupBy).not.toHaveBeenCalled();
  });

  it("rejects a CASHIER with 403 on the detail route with zero data read", async () => {
    setSession("CASHIER");
    const res = await getReceiptDetailRoute(detailReq(), detailCtx(RECEIPT_ID));
    expect(res.status).toBe(403);
    expect(h.getTenantDb).not.toHaveBeenCalled();
    expect(h.getReceiptDetail).not.toHaveBeenCalled();
    expect(h.db.productReceipt.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a CASHIER with 403 on PATCH — before the body, the write gate or any query", async () => {
    setSession("CASHIER");
    const res = await patchReceipt(patchReq({ supplierName: "x" }), detailCtx(RECEIPT_ID));
    expect(res.status).toBe(403);
    expect(h.assertTenantWritable).not.toHaveBeenCalled();
    expect(h.getTenantDb).not.toHaveBeenCalled();
    expect(h.db.productReceipt.update).not.toHaveBeenCalled();
  });

  it("rejects a CASHIER with 403 on the defaults route too", async () => {
    setSession("CASHIER");
    const res = await getReceiptDefaults();
    expect(res.status).toBe(403);
  });

  it("lets an ADMIN through to the data layer (tenant-scoped client)", async () => {
    setSession("ADMIN");
    const res = await listReceipts(listReq());
    expect(res.status).toBe(200);
    expect(h.getTenantDb).toHaveBeenCalledWith(TENANT_ID);
    expect(h.db.productReceipt.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// 2. PATCH — strict allowlist, date rules, batches untouched
// ---------------------------------------------------------------------------

describe("[v4.7] PATCH /api/receipts/[id] — strict schema", () => {
  beforeEach(() => setSession("ADMIN"));

  it("400s a FINANCIAL key before any DB round-trip (zero reads, zero writes)", async () => {
    const res = await patchReceipt(
      patchReq({ purchaseDate: today(), totalCostSYP: "999999" }),
      detailCtx(RECEIPT_ID)
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("FIELD_NOT_ALLOWED");
    expect(h.assertTenantWritable).not.toHaveBeenCalled();
    expect(h.getTenantDb).not.toHaveBeenCalled();
    expect(h.db.productReceipt.update).not.toHaveBeenCalled();
  });

  it("400s `initialQuantity` — the write-once batch snapshot may never be edited", async () => {
    const res = await patchReceipt(
      patchReq({ purchaseDate: today(), initialQuantity: "500" }),
      detailCtx(RECEIPT_ID)
    );
    expect(res.status).toBe(400);
    expect(h.getTenantDb).not.toHaveBeenCalled();
  });

  it("400s ANY unknown key, even alongside a valid one (no partial write)", async () => {
    const res = await patchReceipt(
      patchReq({ supplierName: "x", someTypo: true }),
      detailCtx(RECEIPT_ID)
    );
    expect(res.status).toBe(400);
    expect(h.db.productReceipt.update).not.toHaveBeenCalled();
  });

  it("400s an empty body instead of a no-op update", async () => {
    const res = await patchReceipt(patchReq({}), detailCtx(RECEIPT_ID));
    expect(res.status).toBe(400);
    expect(h.db.productReceipt.update).not.toHaveBeenCalled();
  });

  it("400s a purchaseDate in the FUTURE (Round A's not-future rule)", async () => {
    const res = await patchReceipt(
      patchReq({ purchaseDate: tomorrow() }),
      detailCtx(RECEIPT_ID)
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");
    expect(h.assertTenantWritable).not.toHaveBeenCalled();
    expect(h.db.productReceipt.update).not.toHaveBeenCalled();
  });

  it("400s a purchaseDate older than MAX_BACKDATE_DAYS (Round A's not-too-old rule)", async () => {
    const res = await patchReceipt(
      patchReq({ purchaseDate: longAgo() }),
      detailCtx(RECEIPT_ID)
    );
    expect(res.status).toBe(400);
    expect(h.db.productReceipt.update).not.toHaveBeenCalled();
  });

  it("200s a valid edit, writing ONLY purchaseDate/supplierName via ONE top-level update", async () => {
    const res = await patchReceipt(
      patchReq({ purchaseDate: today(), supplierName: "شركة الفجر" }),
      detailCtx(RECEIPT_ID)
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    expect(h.assertTenantWritable).toHaveBeenCalledWith(TENANT_ID);
    expect(h.db.productReceipt.findFirst).toHaveBeenCalledWith({
      where: { id: RECEIPT_ID, tenantId: TENANT_ID },
      select: { id: true },
    });
    expect(h.db.productReceipt.update).toHaveBeenCalledTimes(1);
    const call = h.db.productReceipt.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: RECEIPT_ID, tenantId: TENANT_ID });
    expect(Object.keys(call.data).sort()).toEqual(["purchaseDate", "supplierName"]);
    // purchaseDate round-trips through the @db.Date conversion (UTC midnight).
    expect(call.data.purchaseDate).toEqual(
      new Date(`${today()}T00:00:00.000Z`)
    );

    // BATCHES UNCHANGED: not a single batch read or write from this route.
    expect(h.db.productBatch.update).not.toHaveBeenCalled();
    expect(h.db.productBatch.create).not.toHaveBeenCalled();
    expect(h.db.productBatch.findMany).not.toHaveBeenCalled();
  });

  it("accepts a supplier-only edit (purchaseDate omitted, never re-stamped)", async () => {
    const res = await patchReceipt(patchReq({ supplierName: "مؤسسة جديدة" }), detailCtx(RECEIPT_ID));
    expect(res.status).toBe(200);
    const call = h.db.productReceipt.update.mock.calls[0][0];
    expect(Object.keys(call.data)).toEqual(["supplierName"]);
    expect(call.data.purchaseDate).toBeUndefined();
  });

  it("stores an emptied supplier as null (no empty-string rows)", async () => {
    const res = await patchReceipt(patchReq({ supplierName: "" }), detailCtx(RECEIPT_ID));
    expect(res.status).toBe(200);
    expect(h.db.productReceipt.update.mock.calls[0][0].data.supplierName).toBeNull();
  });

  it("404s an unknown/foreign receipt id without writing", async () => {
    h.db.productReceipt.findFirst.mockResolvedValue(null);
    const res = await patchReceipt(
      patchReq({ purchaseDate: today() }),
      detailCtx("someone-elses-receipt")
    );
    expect(res.status).toBe(404);
    expect(h.db.productReceipt.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. LIST validation & detail wiring & role-matrix rows
// ---------------------------------------------------------------------------

describe("[v4.7] GET /api/receipts — validation", () => {
  beforeEach(() => setSession("ADMIN"));

  it("400s an impossible calendar date (2026-02-31) instead of letting V8 roll it over", async () => {
    const res = await listReceipts(listReq("from=2026-02-31"));
    expect(res.status).toBe(400);
    expect(h.db.productReceipt.findMany).not.toHaveBeenCalled();
  });

  it("400s a swapped range (from > to) instead of silently returning an empty page", async () => {
    const res = await listReceipts(listReq("from=2026-06-02&to=2026-06-01"));
    expect(res.status).toBe(400);
    expect(h.db.productReceipt.findMany).not.toHaveBeenCalled();
  });

  it("400s an over-max limit instead of honouring a full-history request", async () => {
    const res = await listReceipts(listReq("limit=5000"));
    expect(res.status).toBe(400);
    expect(h.db.productReceipt.findMany).not.toHaveBeenCalled();
  });

  it("400s a malformed cursor without querying", async () => {
    const res = await listReceipts(listReq("cursor=zzzz-not-a-cursor"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CURSOR");
    expect(h.db.productReceipt.findMany).not.toHaveBeenCalled();
  });

  it("applies from/to and supplierName as typed query clauses for an ADMIN", async () => {
    const res = await listReceipts(
      listReq("from=2026-01-01&to=2026-06-30&supplierName=الفجر&limit=10")
    );
    expect(res.status).toBe(200);
    const where = h.db.productReceipt.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT_ID);
    expect(where.purchaseDate.gte).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(where.purchaseDate.lte).toEqual(new Date("2026-06-30T00:00:00.000Z"));
    expect(where.supplierName).toEqual({ contains: "الفجر", mode: "insensitive" });
  });
});

describe("[v4.7] GET /api/receipts/[id] — detail wiring", () => {
  beforeEach(() => setSession("ADMIN"));

  it("returns the gateway's payload for an existing receipt", async () => {
    h.getReceiptDetail.mockResolvedValue({
      id: RECEIPT_ID,
      purchaseDate: "2026-06-01T00:00:00.000Z",
      lines: [],
      deletedLines: [],
      totalCostSYP: "0",
      liveLineCount: 0,
      deletedLineCount: 0,
    });
    const res = await getReceiptDetailRoute(detailReq(), detailCtx(RECEIPT_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.id).toBe(RECEIPT_ID);
    expect(h.getReceiptDetail).toHaveBeenCalledWith(expect.anything(), TENANT_ID, RECEIPT_ID);
  });

  it("404s when the gateway says the receipt is unknown/foreign", async () => {
    h.getReceiptDetail.mockResolvedValue(null);
    const res = await getReceiptDetailRoute(detailReq(), detailCtx("foreign-id"));
    expect(res.status).toBe(404);
  });
});

describe("[v4.7] role matrix — receipts view/edit rows", () => {
  it("receipts:view and receipts:edit are both ADMIN-only", () => {
    expect(ROLE_CAPABILITY_MATRIX["receipts:view"]).toEqual({ ADMIN: true, CASHIER: false });
    expect(ROLE_CAPABILITY_MATRIX["receipts:edit"]).toEqual({ ADMIN: true, CASHIER: false });
    // The receiving capability itself is untouched by Round B.
    expect(ROLE_CAPABILITY_MATRIX["inventory:mutate"]).toEqual({ ADMIN: true, CASHIER: false });
  });
});



