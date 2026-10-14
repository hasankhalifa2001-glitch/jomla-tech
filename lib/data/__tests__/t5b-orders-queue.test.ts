/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-restricted-syntax -- test mocks: mockDb is `any`, so
   member access here never touches a real Prisma delegate; the gateway
   under test (lib/data/orders.ts) uses only sanctioned helpers. */
import fs from "fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * T5b — Admin Orders Queue, Order Detail & Rejection.
 *
 * REAL: app/api/orders routes + lib/data/orders.ts + lib/utils/money.ts +
 * lib/utils/phone.ts + lib/inventory/units.ts conversion (fromBaseUnit/
 * toBaseUnit with a stubbed batched factor reader — the factor VALUE comes
 * from the stub, but the comparison/rendering math is the real units.ts).
 * MOCKED: Prisma boundary (getTenantDb), session, assertTenantWritable.
 */

const { mockSession, mockWritable, mockDb } = vi.hoisted(() => {
    const b2BOrderRequest = {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async () => ({ count: 1 })),
    };
    const b2BOrderRequestItem = { findMany: vi.fn(async () => []) };
    const customer = { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) };
    const verifiedRetailer = { findUnique: vi.fn(async () => null) };
    const productUnit = {
        findMany: vi.fn(async () => []),
    };
    const productBatch = { groupBy: vi.fn(async () => []) };
    const mockDb: any = {
        b2BOrderRequest,
        b2BOrderRequestItem,
        customer,
        verifiedRetailer,
        productUnit,
        productBatch,
        product: { findMany: vi.fn(async () => []) },
    };
    mockDb.$transaction = vi.fn(async (cb: any) => cb(mockDb));
    return {
        mockSession: { current: null as any },
        mockWritable: vi.fn(async () => "ACTIVE"),
        mockDb,
    };
});

vi.mock("@/lib/db/tenant-scope", () => ({
    getTenantDb: vi.fn(() => mockDb),
    tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/auth", () => ({
    auth: vi.fn(async () => mockSession.current),
}));

vi.mock("@/lib/auth/tenant", async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, assertTenantWritable: mockWritable };
});

import { GET as listHandler } from "@/app/api/orders/route";
import { GET as detailHandler } from "@/app/api/orders/[id]/route";
import { POST as rejectHandler } from "@/app/api/orders/[id]/reject/route";

const TENANT = "tenant-1";
const ADMIN = "admin-1";

function setSession(role: "ADMIN" | "CASHIER" | null) {
    mockSession.current =
        role == null
            ? null
            : { user: { id: ADMIN, role, tenantId: TENANT } };
}

function listReq(q = ""): NextRequest {
    return new NextRequest(q ? `http://localhost/api/orders?${q}` : "http://localhost/api/orders");
}

const detailCtx = (id: string) => ({ params: Promise.resolve({ id }) });

function rejectReq(id: string, body: unknown): Request {
    return new Request(`http://localhost/api/orders/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function orderRow(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        retailerName: "تاجر",
        retailerPhone: "0944123456",
        retailerShopName: "متجر",
        status: "PENDING_REVIEW",
        createdAt: new Date("2026-10-01T10:00:00.000Z"),
        resultingInvoiceId: null,
        ...overrides,
    };
}

function lineRow(orderId: string, overrides: Record<string, unknown> = {}) {
    return {
        orderRequestId: orderId,
        quantity: "2",
        approvedQuantity: null,
        priceWholesaleSnapshot: "5000",
        pricingCurrencySnapshot: "SYP",
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    setSession("ADMIN");
    mockWritable.mockResolvedValue("ACTIVE" as never);
    mockDb.b2BOrderRequest.findMany.mockResolvedValue([]);
    mockDb.b2BOrderRequest.findFirst.mockResolvedValue(null);
    mockDb.b2BOrderRequest.count.mockResolvedValue(0);
    mockDb.b2BOrderRequest.updateMany.mockResolvedValue({ count: 1 });
    mockDb.b2BOrderRequestItem.findMany.mockResolvedValue([]);
    mockDb.customer.findMany.mockResolvedValue([]);
    mockDb.customer.findFirst.mockResolvedValue(null);
    mockDb.verifiedRetailer.findUnique.mockResolvedValue(null);
    mockDb.product.findMany.mockResolvedValue([]);
    mockDb.productUnit.findMany.mockResolvedValue([]);
    mockDb.productBatch.groupBy.mockResolvedValue([]);
    mockDb.$transaction.mockImplementation(async (cb: any) => cb(mockDb));
});


describe("T5b auth", () => {
    it("unauthenticated -> 401 on list, detail, reject", async () => {
        setSession(null);
        expect((await listHandler(listReq())).status).toBe(401);
        const d = await detailHandler(new Request("http://localhost/x"), detailCtx("o1"));
        expect(d.status).toBe(401);
        const r = await rejectHandler(rejectReq("o1", { reason: "سبب كاف" }), detailCtx("o1"));
        expect(r.status).toBe(401);
    });

    it("CASHIER list/detail ok; reject 403 zero writes", async () => {
        setSession("CASHIER");
        mockDb.b2BOrderRequest.findMany.mockResolvedValueOnce([orderRow("o1")]);
        mockDb.b2BOrderRequest.count.mockResolvedValueOnce(1);
        expect((await listHandler(listReq())).status).toBe(200);
        mockDb.b2BOrderRequest.updateMany.mockClear();
        const rej = await rejectHandler(rejectReq("o1", { reason: "سبب كاف للرفض" }), detailCtx("o1"));
        expect(rej.status).toBe(403);
        expect((await rej.json()).code).toBe("FORBIDDEN");
        expect(mockDb.b2BOrderRequest.updateMany).not.toHaveBeenCalled();
        expect(mockWritable).not.toHaveBeenCalled();
    });

    it("locked tenant -> reject 403 TENANT_NOT_WRITABLE", async () => {
        const { SubscriptionLockedError } = await import("@/lib/auth/tenant");
        mockWritable.mockRejectedValueOnce(new SubscriptionLockedError("EXPIRED"));
        const res = await rejectHandler(rejectReq("o1", { reason: "سبب كاف للرفض" }), detailCtx("o1"));
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe("TENANT_NOT_WRITABLE");
        expect(mockDb.b2BOrderRequest.updateMany).not.toHaveBeenCalled();
    });
});

describe("T5b reject", () => {
    it("bad reasons -> 400", async () => {
        for (const bad of ["", "   ", "ab"]) {
            const res = await rejectHandler(rejectReq("o1", { reason: bad }), detailCtx("o1"));
            expect(res.status).toBe(400);
            expect((await res.json()).code).toBe("VALIDATION_ERROR");
        }
        const long = await rejectHandler(rejectReq("o1", { reason: "x".repeat(501) }), detailCtx("o1"));
        expect(long.status).toBe(400);
        const missing = await rejectHandler(rejectReq("o1", {}), detailCtx("o1"));
        expect(missing.status).toBe(400);
    });

    it("success writes only four fields", async () => {
        mockDb.b2BOrderRequest.updateMany.mockResolvedValueOnce({ count: 1 });
        const res = await rejectHandler(rejectReq("o1", { reason: "  مخزون غير كاف  " }), detailCtx("o1"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        const args = mockDb.b2BOrderRequest.updateMany.mock.calls[0][0];
        expect(args.where).toEqual({ id: "o1", tenantId: TENANT, status: "PENDING_REVIEW" });
        expect(Object.keys(args.data).sort()).toEqual(
            ["rejectionReason", "reviewedAt", "reviewedByUserId", "status"].sort()
        );
        expect(args.data.rejectionReason).toBe("مخزون غير كاف");
    });

    it("already reviewed -> 409; unknown -> 404", async () => {
        mockDb.b2BOrderRequest.updateMany.mockResolvedValueOnce({ count: 0 });
        mockDb.b2BOrderRequest.findFirst.mockResolvedValueOnce({ id: "o1" });
        const c = await rejectHandler(rejectReq("o1", { reason: "سبب كاف" }), detailCtx("o1"));
        expect(c.status).toBe(409);
        expect((await c.json()).code).toBe("ALREADY_REVIEWED");
        mockDb.b2BOrderRequest.updateMany.mockResolvedValueOnce({ count: 0 });
        mockDb.b2BOrderRequest.findFirst.mockResolvedValueOnce(null);
        const m = await rejectHandler(rejectReq("nope", { reason: "سبب كاف" }), detailCtx("nope"));
        expect(m.status).toBe(404);
    });
});

describe("T5b list", () => {
    it("mixed SYP/USD totals separate; APPROVED uses approvedQuantity", async () => {
        mockDb.b2BOrderRequest.findMany.mockResolvedValueOnce([orderRow("o1", { status: "APPROVED" })]);
        mockDb.b2BOrderRequestItem.findMany.mockResolvedValueOnce([
            lineRow("o1", { quantity: "2", approvedQuantity: "1", priceWholesaleSnapshot: "100", pricingCurrencySnapshot: "SYP" }),
            lineRow("o1", { quantity: "5", approvedQuantity: "4", priceWholesaleSnapshot: "2", pricingCurrencySnapshot: "USD" }),
        ]);
        const j: any = await (await listHandler(listReq("status=APPROVED"))).json();
        expect(j.items[0].totalSYP).toBe("100.0000");
        expect(j.items[0].totalUSD).toBe("8.0000");
        expect(j.items[0].lineCount).toBe(2);
        expect(mockDb.b2BOrderRequestItem.findMany).toHaveBeenCalledTimes(1);
    });

    it("bad cursor 400; ref search endsWith; no cost in payload", async () => {
        const bad = await listHandler(listReq("cursor=!!!not-base64!!!"));
        expect(bad.status).toBe(400);
        mockDb.b2BOrderRequest.findMany.mockResolvedValueOnce([orderRow("abcDEF12")]);
        mockDb.b2BOrderRequestItem.findMany.mockResolvedValueOnce([]);
        const res = await listHandler(listReq("q=bcDEF1"));
        expect(res.status).toBe(200);
        const where = mockDb.b2BOrderRequest.findMany.mock.calls[0][0].where;
        expect(JSON.stringify(where)).toContain("endsWith");
        expect(JSON.stringify(await res.json())).not.toMatch(/cost|baseUnitId|passwordHash|matchedCustomerId/i);
    });

    it("pending count reflects PENDING_REVIEW only", async () => {
        mockDb.b2BOrderRequest.findMany.mockResolvedValueOnce([]);
        mockDb.b2BOrderRequest.count.mockResolvedValueOnce(7);
        const j: any = await (await listHandler(listReq("status=REJECTED"))).json();
        expect(j.pendingCount).toBe(7);
        expect(mockDb.b2BOrderRequest.count).toHaveBeenCalledWith({
            where: { tenantId: TENANT, status: "PENDING_REVIEW" },
        });
    });
});
describe("T5b detail", () => {
    function arrange(status = "PENDING_REVIEW") {
        mockDb.b2BOrderRequest.findFirst.mockResolvedValueOnce({
            id: "o1", retailerName: "تاجر", retailerPhone: "0944123456",
            retailerShopName: "متجر", status,
            createdAt: new Date("2026-10-01T10:00:00Z"),
            reviewedAt: null, rejectionReason: status === "REJECTED" ? "مخزون" : null,
            matchedCustomerId: "c1",
            resultingInvoiceId: status === "APPROVED" ? "inv-1" : null,
            reviewedByUser: { name: "المدير" },
        });
        mockDb.b2BOrderRequestItem.findMany.mockResolvedValueOnce([{
            id: "l1", productId: "p1", unitId: "u1", quantity: "5",
            approvedQuantity: status === "APPROVED" ? "4" : null,
            priceWholesaleSnapshot: "1000", pricingCurrencySnapshot: "SYP",
        }]);
        mockDb.product.findMany.mockResolvedValueOnce([{ id: "p1", name: "سكر" }]);
        mockDb.productUnit.findMany.mockImplementation(async (a: any) => {
            if (a?.select?.conversionFactor) return [{ id: "u1", conversionFactor: "10" }];
            return [{ id: "u1", unitName: "طرد" }];
        });
        mockDb.productBatch.groupBy.mockResolvedValueOnce([{ productId: "p1", _sum: { quantity: "30" } }]);
        mockDb.verifiedRetailer.findUnique.mockResolvedValueOnce({ verificationCount: 2 });
        mockDb.b2BOrderRequest.count.mockResolvedValueOnce(3);
        mockDb.customer.findMany.mockResolvedValueOnce([]);
        mockDb.customer.findFirst.mockResolvedValueOnce(
            { id: "c1", name: "زبون", phone: "0944123456", shopName: null }
        );
    }
    it("names, warning, signal, reviewer name only", async () => {
        arrange();
        const req = new Request("http://localhost/x");
        const j: any = await (await detailHandler(req, detailCtx("o1"))).json();
        expect(j.order.lines[0].productName).toBe("سكر");
        expect(j.order.lines[0].availableInUnit).toBe("3");
        expect(j.order.lines[0].exceedsAvailability).toBe(true);
        expect(j.order.signal).toEqual({ hasPriorApproval: true, verificationCount: 2 });
        expect(j.order.reviewedByUserName).toBe("المدير");
        expect(JSON.stringify(j)).not.toMatch(/passwordHash|cost|baseUnitId/i);
    });
    it("CASHIER has no candidates", async () => {
        arrange();
        setSession("CASHIER");
        const req = new Request("http://localhost/x");
        const j: any = await (await detailHandler(req, detailCtx("o1"))).json();
        expect(j.order.candidates).toEqual([]);
        expect(j.order.matchedCustomer).toBeNull();
    });
    it("candidates match formatted phones, 50-cap prefilter", async () => {
        const m = await import("@/lib/data/orders");
        mockDb.customer.findMany.mockReset();
        mockDb.customer.findMany.mockResolvedValueOnce([
            { id: "a", name: "A", phone: "+963 944 123 456", shopName: null },
            { id: "b", name: "B", phone: "0944-123-456", shopName: null },
            { id: "c", name: "C", phone: "0999999999", shopName: null },
        ]);
        const found = await m.findCandidateCustomersByPhone(mockDb, TENANT, "0944123456");
        expect(found.map((r) => r.id).sort()).toEqual(["a", "b"]);
        const args = mockDb.customer.findMany.mock.calls[0][0];
        expect(args.take).toBe(50);
        expect(args.where.phone).toEqual({ contains: "456" });
    });
    it("static scans", async () => {
        const labels = fs.readFileSync("lib/config/retailer-signal-labels.ts", "utf-8");
        expect(labels).toContain("رقم سبق قبول طلب منه");
        const src = fs.readFileSync("lib/data/orders.ts", "utf-8");
        expect(src).not.toMatch(/\.conversionFactor/);
        expect(src).not.toMatch(/\$queryRaw/);
        expect(src).not.toMatch(/passwordHash/);
        expect(src).not.toMatch(/costPrice|costAmount/);
        expect(src).not.toMatch(/baseUnitId/);
        expect(src).not.toMatch(/batchNumber/);
        expect(src).not.toMatch(/productBatch\.(create|update|delete|groupBy)/);
        expect(src).toContain("loadAvailableBaseQuantities");
        expect(src).not.toContain("quantity: { gt: 0 }");
        const defs = fs.readFileSync("lib/db/call-group-by.ts", "utf-8").match(/export function callGroupBy/g) ?? [];
        expect(defs.length).toBe(1);
        for (const f of ["app/api/orders/route.ts", "app/api/orders/[id]/route.ts", "app/api/orders/[id]/reject/route.ts"]) {
            const content = fs.readFileSync(f, "utf-8");
            // No approve CONTROL: the APPROVED status enum value is fine, but
            // no approve action/route/button may exist in T5b.
            expect(content).not.toMatch(/approv(e|al|ing)[a-z]*\s*(order|button|action|route|handler)/i);
            expect(content).not.toMatch(/orders:approve/);
        }
    });
    it("UI wording: no trust labels, shared constants, no approve control", async () => {
        const uiFiles = [
            "components/orders/orders-client.tsx",
            "components/orders/order-detail-drawer.tsx",
            "components/orders/reject-order-dialog.tsx",
            "components/orders/orders-utils.ts",
        ];
        for (const f of uiFiles) {
            const content = fs.readFileSync(f, "utf-8");
            expect(content).not.toContain("موثوق");
            expect(content).not.toContain("موثّق");
            expect(content).not.toMatch(/orders:approve/);
        }
        const drawer = fs.readFileSync("components/orders/order-detail-drawer.tsx", "utf-8");
        expect(drawer).toContain("PRIOR_APPROVAL_BADGE_LABEL");
        expect(drawer).toContain("NO_PRIOR_APPROVAL_LABEL");
        expect(drawer).toContain("RETAILER_SIGNAL_WARNING");
        expect(drawer).toContain("retailer-signal-labels");
    });
});

describe("T5b review fixes", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const plainReq = () => new Request("http://localhost/x");

    function arrangeLines(items: any[], factors: any[], stock: string | null) {
        mockDb.b2BOrderRequest.findFirst.mockResolvedValueOnce({
            id: "o1", retailerName: "تاجر", retailerPhone: "0944123456",
            retailerShopName: null, status: "PENDING_REVIEW",
            createdAt: new Date("2026-10-01T10:00:00Z"), reviewedAt: null,
            rejectionReason: null, matchedCustomerId: null,
            resultingInvoiceId: null, reviewedByUser: null,
        });
        mockDb.b2BOrderRequestItem.findMany.mockResolvedValueOnce(items);
        mockDb.product.findMany.mockResolvedValueOnce([{ id: "p1", name: "سكر" }]);
        mockDb.productUnit.findMany.mockImplementation(async (a: any) => {
            if (a?.select?.conversionFactor) return factors;
            return [{ id: "u1", unitName: "طرد" }, { id: "u2", unitName: "قطعة" }];
        });
        mockDb.productBatch.groupBy.mockResolvedValueOnce(
            stock ? [{ productId: "p1", _sum: { quantity: stock } }] : []
        );
    }
    const line = (id: string, unitId: string, quantity: string) => ({
        id, productId: "p1", unitId, quantity, approvedQuantity: null,
        priceWholesaleSnapshot: "1000", pricingCurrencySnapshot: "SYP",
    });

    it("401 uses the UNAUTHORIZED code on list, detail and reject", async () => {
        setSession(null);
        expect((await (await listHandler(listReq())).json()).code).toBe("UNAUTHORIZED");
        expect((await (await detailHandler(plainReq(), detailCtx("o1"))).json()).code).toBe("UNAUTHORIZED");
        const r = await rejectHandler(rejectReq("o1", { reason: "سبب كاف" }), detailCtx("o1"));
        expect((await r.json()).code).toBe("UNAUTHORIZED");
    });

    it("reject body with an extra field -> 400 and zero writes", async () => {
        const res = await rejectHandler(
            rejectReq("o1", { reason: "سبب كاف للرفض", status: "APPROVED" }),
            detailCtx("o1")
        );
        expect(res.status).toBe(400);
        expect(mockDb.b2BOrderRequest.updateMany).not.toHaveBeenCalled();
    });

    it("two concurrent rejects: exactly one wins (mock-level)", async () => {
        mockDb.b2BOrderRequest.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        mockDb.b2BOrderRequest.findFirst.mockResolvedValueOnce({ id: "o1" });
        const [a, b] = await Promise.all([
            rejectHandler(rejectReq("o1", { reason: "سبب كاف أول" }), detailCtx("o1")),
            rejectHandler(rejectReq("o1", { reason: "سبب كاف ثاني" }), detailCtx("o1")),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it("cursor with empty or oversized id -> 400", async () => {
        for (const i of ["", "x".repeat(65)]) {
            const res = await listHandler(
                listReq(`cursor=${enc({ c: "2026-10-01T10:00:00.000Z", i })}`)
            );
            expect(res.status).toBe(400);
        }
    });

    it("cursor keyset breaks createdAt ties by id", async () => {
        mockDb.b2BOrderRequest.findMany.mockResolvedValueOnce([]);
        await listHandler(listReq(`cursor=${enc({ c: "2026-10-01T10:00:00.000Z", i: "o5" })}`));
        const where = mockDb.b2BOrderRequest.findMany.mock.calls[0][0].where;
        expect(JSON.stringify(where.AND)).toContain('"id":{"lt":"o5"}');
        expect(mockDb.b2BOrderRequest.findMany.mock.calls[0][0].orderBy).toEqual([
            { createdAt: "desc" }, { id: "desc" },
        ]);
    });

    it("Arabic-Indic digits in search match the normalized phone", async () => {
        mockDb.b2BOrderRequest.findMany.mockResolvedValueOnce([]);
        await listHandler(listReq("q=" + encodeURIComponent("٠٩٤٤١٢٣٤٥٦")));
        const where = mockDb.b2BOrderRequest.findMany.mock.calls[0][0].where;
        expect(JSON.stringify(where.OR)).toContain('"retailerPhone":"0944123456"');
    });

    it("unknown unit factor -> availableInUnit null (not 0), no warning", async () => {
        arrangeLines([line("l1", "u1", "5")], [], "30");
        const j: any = await (await detailHandler(plainReq(), detailCtx("o1"))).json();
        expect(j.order.lines[0].availableInUnit).toBeNull();
        expect(j.order.lines[0].exceedsAvailability).toBe(false);
    });

    it("two lines of one product in different units are checked together", async () => {
        // u1 factor 10: 2 -> 20 base; u2 factor 1: 15 -> 15 base; stock 30.
        // Each alone fits (20, 15 <= 30) but together 35 > 30.
        arrangeLines(
            [line("l1", "u1", "2"), line("l2", "u2", "15")],
            [{ id: "u1", conversionFactor: "10" }, { id: "u2", conversionFactor: "1" }],
            "30"
        );
        const j: any = await (await detailHandler(plainReq(), detailCtx("o1"))).json();
        expect(j.order.lines.every((l: any) => l.exceedsAvailability === true)).toBe(true);
    });

    it("detail is tenant-scoped; foreign/unknown id -> 404", async () => {
        mockDb.b2BOrderRequest.findFirst.mockResolvedValueOnce(null);
        const res = await detailHandler(plainReq(), detailCtx("foreign"));
        expect(res.status).toBe(404);
        expect(mockDb.b2BOrderRequest.findFirst.mock.calls[0][0].where).toEqual({
            id: "foreign", tenantId: TENANT,
        });
    });

    it("CASHIER detail never asks the gateway to load customers", async () => {
        setSession("CASHIER");
        arrangeLines([line("l1", "u1", "1")], [{ id: "u1", conversionFactor: "10" }], "30");
        const res = await detailHandler(plainReq(), detailCtx("o1"));
        expect(res.status).toBe(200);
        expect(mockDb.customer.findMany).not.toHaveBeenCalled();
        expect(mockDb.customer.findFirst).not.toHaveBeenCalled();
    });

    it("candidate pre-filter is tenant-scoped, active-only, non-system, ordered", async () => {
        const m = await import("@/lib/data/orders");
        mockDb.customer.findMany.mockResolvedValueOnce([]);
        await m.findCandidateCustomersByPhone(mockDb, TENANT, "0944123456");
        const args = mockDb.customer.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({
            tenantId: TENANT, isActive: true, isSystemGenerated: false,
        });
        expect(args.orderBy).toEqual({ id: "asc" });
        expect(args.take).toBe(50);
    });
});
