/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks: the
   tenant-scoped Prisma delegates below are hand-written fakes that READ
   the `tenantId` out of the `where` they are handed and filter an
   in-memory dataset by it, exactly as the real tenant-scope extension
   guarantees at runtime. Member access never touches a real Prisma
   delegate, so no no-restricted-syntax disable is needed here. */

/**
 * T7 — cross-tenant isolation for the T5b admin orders surfaces.
 *
 * T5b introduced three authenticated routes (GET /api/orders,
 * GET /api/orders/[id], POST /api/orders/[id]/reject). A session for
 * tenant A must NEVER read or write tenant B's rows, even by guessing an
 * id. This suite proves that for the queue/detail/reject paths in
 * ISOLATION, independent of the feature's own unit tests.
 *
 * TECHNIQUE: the fake delegates below ACTUALLY ENFORCE tenantId — each
 * holds a shared dataset with BOTH tenants' rows and filters by the
 * `tenantId` present in the incoming `where` (mirroring the getTenantDb()
 * extension, which injects tenantId into every query). So "tenant A never
 * sees/touches tenant B" holds only because the gateway itself passed
 * tenantId; a gateway bug that omitted it would surface as wrong rows.
 *
 * MOCKED: getTenantDb, auth, assertTenantWritable.
 * REAL: the three route handlers + lib/data/orders.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";
const ADMIN_A = "admin-A";

const ORDERS: any[] = [
    { id: "a-1", tenantId: TENANT_A, status: "PENDING_REVIEW", retailerName: "تاجر أ", retailerPhone: "0944123456", retailerShopName: "متجر أ", createdAt: new Date("2026-10-01T10:00:00.000Z"), resultingInvoiceId: null },
    { id: "a-2", tenantId: TENANT_A, status: "PENDING_REVIEW", retailerName: "تاجر أ٢", retailerPhone: "0944222222", retailerShopName: "متجر أ٢", createdAt: new Date("2026-10-01T09:00:00.000Z"), resultingInvoiceId: null },
    { id: "b-1", tenantId: TENANT_B, status: "PENDING_REVIEW", retailerName: "تاجر ب", retailerPhone: "0944333333", retailerShopName: "متجر ب", createdAt: new Date("2026-10-01T11:00:00.000Z"), resultingInvoiceId: null },
];

const ITEMS = [
    { id: "item-a1", orderRequestId: "a-1", tenantId: TENANT_A, productId: "p-a", unitId: "u-a", quantity: "2", approvedQuantity: null, priceWholesaleSnapshot: "5000", pricingCurrencySnapshot: "SYP" },
    { id: "item-b1", orderRequestId: "b-1", tenantId: TENANT_B, productId: "p-b", unitId: "u-b", quantity: "9", approvedQuantity: null, priceWholesaleSnapshot: "9999", pricingCurrencySnapshot: "SYP" },
];

const CUSTOMERS = [
    { id: "cust-a", tenantId: TENANT_A, name: "زبون أ", phone: "0944123456", shopName: "متجر أ", isActive: true, isSystemGenerated: false },
    { id: "cust-b", tenantId: TENANT_B, name: "زبون ب", phone: "0944123456", shopName: "متجر ب", isActive: true, isSystemGenerated: false },
];

const { mockSession, mockDb, mockWritable } = vi.hoisted(() => {
    const scope = (rows: any[], where: any) => {
        const t = where?.tenantId;
        if (t == null) return [];
        return rows.filter((r) => r.tenantId === t);
    };
    const b2BOrderRequest = {
        findMany: vi.fn(async (args: any) => {
            let rows = scope(ORDERS, args?.where);
            const status = args?.where?.status;
            if (status) rows = rows.filter((r) => r.status === status);
            const ord = args?.orderBy;
            if (Array.isArray(ord)) {
                rows = [...rows].sort((x, y) => {
                    for (const key of ord) {
                        const f = Object.keys(key)[0];
                        const dir = (key as any)[f] === "desc" ? -1 : 1;
                        if (f === "createdAt") {
                            const d = x.createdAt.getTime() - y.createdAt.getTime();
                            if (d !== 0) return d * dir;
                        } else if (f === "id") {
                            const d = x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
                            if (d !== 0) return d * dir;
                        }
                    }
                    return 0;
                });
            }
            return rows;
        }),
        findFirst: vi.fn(async (args: any) => {
            const rows = scope(ORDERS, args?.where);
            return rows.find((r) => r.id === args?.where?.id) ?? null;
        }),
        count: vi.fn(async (args: any) => {
            let rows = scope(ORDERS, args?.where);
            const status = args?.where?.status;
            if (status) rows = rows.filter((r) => r.status === status);
            return rows.length;
        }),
        updateMany: vi.fn(async (args: any) => {
            const t = args?.where?.tenantId;
            if (t == null) return { count: 0 };
            let n = 0;
            for (const r of ORDERS) {
                if (r.tenantId !== t) continue;
                if (args?.where?.id && r.id !== args.where.id) continue;
                if (args?.where?.status && r.status !== args.where.status) continue;
                Object.assign(r, args.data);
                n += 1;
            }
            return { count: n };
        }),
    };
    const b2BOrderRequestItem = {
        findMany: vi.fn(async (args: any) => {
            const t = args?.where?.tenantId;
            if (t == null) return [];
            // Detail uses a single `orderRequestId`; the queue uses `{ in: [...] }`.
            const or = args?.where?.orderRequestId;
            const ids = or?.in ? new Set(or.in) : or ? new Set([or]) : new Set<string>();
            return ITEMS.filter((r) => r.tenantId === t && ids.has(r.orderRequestId));
        }),
    };
    const customer = {
        findMany: vi.fn(async (args: any) => scope(CUSTOMERS, args?.where)),
        findFirst: vi.fn(async (args: any) => {
            const rows = scope(CUSTOMERS, args?.where);
            return rows.find((r) => r.id === args?.where?.id) ?? null;
        }),
    };
    const verifiedRetailer = { findUnique: vi.fn(async () => null) };
    const productUnit = { findMany: vi.fn(async () => []) };
    const productBatch = { groupBy: vi.fn(async () => []) };
    const mockDb: any = {
        b2BOrderRequest, b2BOrderRequestItem, customer, verifiedRetailer,
        productUnit, productBatch, product: { findMany: vi.fn(async () => []) },
    };
    mockDb.$transaction = vi.fn(async (cb: any) => cb(mockDb));
    const mockWritable = vi.fn(async (_tenantId: string) => "ACTIVE");
    return { mockSession: { current: null as any }, mockDb, mockWritable };
});

vi.mock("@/lib/db/tenant-scope", () => ({
    getTenantDb: vi.fn(() => mockDb),
    tenantScopedRawQuery: vi.fn(async () => []),
}));
// [T5c Phase 4] The approve route opens its transaction on the RAW prisma
// client (category-5: lock/FIFO helpers need Prisma.TransactionClient).
// Route it to the same tenant-enforcing fake — never a real database.
vi.mock("@/lib/db", () => ({
    prisma: mockDb,
    getTenantDb: vi.fn(() => mockDb),
    tenantScopedRawQuery: vi.fn(async () => []),
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => mockSession.current) }));
vi.mock("@/lib/auth/tenant", async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, assertTenantWritable: mockWritable };
});

import { GET as listHandler } from "@/app/api/orders/route";
import { GET as detailHandler } from "@/app/api/orders/[id]/route";
import { POST as rejectHandler } from "@/app/api/orders/[id]/reject/route";
// [T5c Phase 4] Approve route joins the cross-tenant suite: a foreign order
// id must 404 with zero writes.
import { POST as approveHandler } from "@/app/api/orders/[id]/approve/route";

function setSession(role: "ADMIN" | "CASHIER") {
    mockSession.current = { user: { id: ADMIN_A, role, tenantId: TENANT_A } };
}
const listReq = (q = "") => new NextRequest(q ? `http://localhost/api/orders?${q}` : "http://localhost/api/orders");
const detailCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const rejectReq = (id: string, body: unknown) =>
    new Request(`http://localhost/api/orders/${id}/reject`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

beforeEach(() => {
    vi.clearAllMocks();
    setSession("ADMIN");
    for (const o of ORDERS) {
        o.status = "PENDING_REVIEW";
        o.resultingInvoiceId = null;
        delete o.rejectionReason;
        delete o.reviewedByUserId;
        delete o.reviewedAt;
    }
});


describe("T7 cross-tenant isolation — T5b orders", () => {
    it("list for tenant A never returns tenant B's orders", async () => {
        setSession("ADMIN");
        const res = await listHandler(listReq("status=PENDING_REVIEW&limit=50"));
        expect(res.status).toBe(200);
        const j: any = await res.json();
        const ids = j.items.map((r: any) => r.id);
        expect(ids).toContain("a-1");
        expect(ids).toContain("a-2");
        expect(ids).not.toContain("b-1");
        // The query was scoped by A's tenantId.
        expect(mockDb.b2BOrderRequest.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_A);
    });

    it("detail for a tenant-B id under tenant A -> 404, and never leaks B's fields", async () => {
        setSession("ADMIN");
        const res = await detailHandler(new Request("http://localhost/x"), detailCtx("b-1"));
        expect(res.status).toBe(404);
        const body = await res.text();
        // None of tenant B's identifying data may appear in the response.
        expect(body).not.toContain("تاجر ب");
        expect(body).not.toContain("متجر ب");
        expect(body).not.toContain("0944333333");
        expect(mockDb.b2BOrderRequest.findFirst.mock.calls[0][0].where).toEqual({
            id: "b-1", tenantId: TENANT_A,
        });
    });

    it("detail of tenant A's own order only ever carries tenant A's lines", async () => {
        setSession("ADMIN");
        const res = await detailHandler(new Request("http://localhost/x"), detailCtx("a-1"));
        expect(res.status).toBe(200);
        const j: any = await res.json();
        expect(j.order.id).toBe("a-1");
        // Exactly one SYP line for a-1 (the b-1 line must not appear).
        expect(j.order.lines).toHaveLength(1);
        expect(j.order.lines[0].priceWholesaleSnapshot).toBe("5000");
        // The batched item read is scoped by A's tenantId.
        expect(mockDb.b2BOrderRequestItem.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_A);
    });

    it("reject of a tenant-B id under tenant A -> 404 and B's row is left untouched", async () => {
        setSession("ADMIN");
        expect(ORDERS.find((o) => o.id === "b-1")!.status).toBe("PENDING_REVIEW");
        const res = await rejectHandler(rejectReq("b-1", { reason: "سبب رفض صالح" }), detailCtx("b-1"));
        expect(res.status).toBe(404);
        const after = ORDERS.find((o) => o.id === "b-1")!;
        // B's row was NOT mutated: still PENDING_REVIEW, no rejection written.
        expect(after.status).toBe("PENDING_REVIEW");
        expect(after.rejectionReason).toBeUndefined();
        expect(after.reviewedByUserId).toBeUndefined();
        // The conditional write carried A's tenantId, so it matched zero B rows.
        expect(mockDb.b2BOrderRequest.updateMany.mock.calls[0][0].where.tenantId).toBe(TENANT_A);
    });

    it("approve of a tenant-B id under tenant A -> 404 and B's row is left untouched", async () => {
        setSession("ADMIN");
        expect(ORDERS.find((o) => o.id === "b-1")!.status).toBe("PENDING_REVIEW");
        const res = await approveHandler(
            new Request(`http://localhost/api/orders/b-1/approve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    lines: [{ itemId: "item-b1", approvedQuantity: "9" }],
                    customer: { mode: "EXISTING", customerId: "cust-a" },
                    payment: { mode: "FULL_CREDIT" },
                }),
            }),
            detailCtx("b-1")
        );
        expect(res.status).toBe(404);
        const after = ORDERS.find((o) => o.id === "b-1")!;
        expect(after.status).toBe("PENDING_REVIEW");
        expect(after.resultingInvoiceId).toBeNull();
    });

    it("reject of tenant A's own pending order succeeds and only touches A", async () => {
        setSession("ADMIN");
        const res = await rejectHandler(rejectReq("a-1", { reason: "سبب رفض صالح" }), detailCtx("a-1"));
        expect(res.status).toBe(200);
        const a1 = ORDERS.find((o) => o.id === "a-1")!;
        const b1 = ORDERS.find((o) => o.id === "b-1")!;
        expect(a1.status).toBe("REJECTED");
        expect(a1.reviewedByUserId).toBe(ADMIN_A);
        expect(b1.status).toBe("PENDING_REVIEW"); // B untouched
    });

    it("candidate matching for tenant A never returns tenant B's customer", async () => {
        setSession("ADMIN");
        // Both tenants have a customer with the same phone. Opening A's order
        // (which triggers candidate loading) must surface only A's customer.
        const res = await detailHandler(new Request("http://localhost/x"), detailCtx("a-1"));
        expect(res.status).toBe(200);
        const j: any = await res.json();
        const candidateIds = (j.order.candidates ?? []).map((c: any) => c.id);
        expect(candidateIds).toContain("cust-a");
        expect(candidateIds).not.toContain("cust-b");
        expect(mockDb.customer.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_A);
    });

    it("CASHIER under tenant A: reject -> 403 with zero writes", async () => {
        setSession("CASHIER");
        const res = await rejectHandler(rejectReq("a-1", { reason: "سبب رفض صالح" }), detailCtx("a-1"));
        expect(res.status).toBe(403);
        expect(mockDb.b2BOrderRequest.updateMany).not.toHaveBeenCalled();
        expect(ORDERS.find((o) => o.id === "a-1")!.status).toBe("PENDING_REVIEW");
    });
});

it("harness canary: the fake is strict (no tenantId -> nothing; tenant B -> only B)", async () => {
    expect(await mockDb.b2BOrderRequest.findMany({ where: { status: "PENDING_REVIEW" } })).toEqual([]);
    const b = await mockDb.b2BOrderRequest.findMany({ where: { tenantId: TENANT_B } });
    expect(b.map((r: any) => r.id)).toEqual(["b-1"]);
    expect(await mockDb.b2BOrderRequest.count({ where: {} })).toBe(0);
});

it("searching tenant B's phone/name under tenant A never surfaces B's order", async () => {
    // NOTE: the fake does not evaluate OR, so this proves tenant scoping of
    // searches, not search correctness (that lives in t5b-orders-queue).
    for (const q of ["0944333333", encodeURIComponent("تاجر ب")]) {
        const res = await listHandler(listReq(`q=${q}`));
        expect(res.status).toBe(200);
        const j: any = await res.json();
        expect(j.items.map((r: any) => r.id)).not.toContain("b-1");
        const calls = mockDb.b2BOrderRequest.findMany.mock.calls;
        expect(calls[calls.length - 1][0].where.tenantId).toBe(TENANT_A);
    }
});

it("CASHIER under tenant A asking for tenant B's order detail -> 404", async () => {
    setSession("CASHIER");
    const res = await detailHandler(new Request("http://localhost/x"), detailCtx("b-1"));
    expect(res.status).toBe(404);
    expect(mockDb.customer.findMany).not.toHaveBeenCalled();
});

it("assertTenantWritable is called with the SESSION tenant, even for a foreign order id", async () => {
    setSession("ADMIN");
    await rejectHandler(rejectReq("b-1", { reason: "سبب رفض صالح" }), detailCtx("b-1"));
    expect(mockWritable).toHaveBeenCalledWith(TENANT_A);
    expect(mockWritable).not.toHaveBeenCalledWith(TENANT_B);
});

it("retailer signal exposes only {hasPriorApproval, verificationCount}", async () => {
    setSession("ADMIN");
    mockDb.verifiedRetailer.findUnique.mockResolvedValueOnce({
        verificationCount: 3, id: "vr-1", phone: "0944123456", shopName: "متجر آخر",
    });
    const res = await detailHandler(new Request("http://localhost/x"), detailCtx("a-1"));
    const j: any = await res.json();
    expect(Object.keys(j.order.signal).sort()).toEqual(["hasPriorApproval", "verificationCount"]);
    expect(JSON.stringify(j)).not.toContain("متجر آخر");
});