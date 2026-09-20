/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * T4c2 — Sales / Invoice History Log: end-to-end route + data-layer tests.
 *
 * Two things are deliberately REAL here, not mocked:
 *   - app/api/invoices/route.ts and app/api/invoices/[id]/route.ts — the
 *     actual handlers under test.
 *   - lib/data/invoices.ts — the actual listing/detail data layer, so cursor
 *     pagination, the payment-status derivation, and the paymentStatus scan
 *     path are exercised as written rather than re-implemented in the test.
 * Only the Prisma boundary (getTenantDb) and the session are faked.
 *
 * COVERAGE → ACCEPTANCE CRITERIA
 *   1. CASHIER scoping          → "A CASHIER session sees only its own
 *                                  invoices in both the UI and via a direct
 *                                  API call — verified server-side."
 *   2. ADMIN staff filter       → "An ADMIN session sees all staff's
 *                                  invoices and can filter by staff member."
 *   3. Pagination bounds        → "Pagination never loads a tenant's entire
 *                                  invoice history in a single response,
 *                                  verified against a seeded tenant with a
 *                                  large invoice count."
 *   4. Badge derivation         → "correct payment-status badge".
 *   5. Detail + cross-link auth → "A VOIDED invoice and the original invoice
 *                                  it reverses are cross-linked and
 *                                  navigable from either side."
 */

const { mockInvoice, mockSessionState, mockGetTenantDb } = vi.hoisted(() => {
    const mockInvoice = {
        findMany: vi.fn(),
        findUnique: vi.fn(),
    };
    const mockDb: any = { invoice: mockInvoice };
    const mockGetTenantDb = vi.fn(() => mockDb);
    const mockSessionState = {
        session: null as any,
    };
    return { mockInvoice, mockSessionState, mockGetTenantDb };
});

vi.mock("@/lib/db/tenant-scope", () => ({
    getTenantDb: mockGetTenantDb,
    tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/auth", () => ({
    auth: vi.fn(async () => mockSessionState.session),
}));

import { GET as getInvoices } from "@/app/api/invoices/route";
import { GET as getInvoiceDetail } from "@/app/api/invoices/[id]/route";
import { ROLE_CAPABILITY_MATRIX } from "@/lib/auth/role-matrix";

const TENANT_ID = "tenant-1";

function setSession(userId: string, role: "ADMIN" | "CASHIER") {
    mockSessionState.session = { user: { id: userId, role, tenantId: TENANT_ID } };
}

/** A Prisma-Invoice-shaped row for the listing select. Decimal columns are
 * strings: the data layer only ever calls .toString() on them, exactly as it
 * would on a real Prisma.Decimal. */
function makeLogRow(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        createdAt: new Date("2026-09-20T10:00:00.000Z"),
        status: "COMPLETED",
        totalSYP: "100.0000",
        totalUSD: "1.0000",
        paidAmountSYP: "100.0000",
        exchangeRateUsed: "15000.0000",
        voidsInvoiceId: null,
        voidedBy: null,
        user: { id: "user-1", name: "كاشير" },
        customer: { id: "cust-1", name: "زبون نقدي", isSystemGenerated: true },
        ...overrides,
    };
}

function makeDetailInvoice(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        createdAt: new Date("2026-09-20T10:00:00.000Z"),
        status: "COMPLETED",
        totalSYP: "100.0000",
        totalUSD: "1.0000",
        exchangeRateUsed: "15000.0000",
        paidAmountSYP: "100.0000",
        paidAmountUSD: "1.0000",
        debtAmountSYP: "0.0000",
        debtAmountUSD: "0.0000",
        voidReason: null,
        voidsInvoiceId: null,
        voidedBy: null,
        voidsInvoice: null,
        userId: "user-1",
        user: { id: "user-1", name: "كاشير" },
        customer: { id: "cust-1", name: "زبون نقدي", phone: "0900000000" },
        items: [],
        ...overrides,
    };
}

function listUrl(query = ""): NextRequest {
    const base =
        "http://localhost/api/invoices?from=2026-09-20T00:00:00.000Z&to=2026-09-20T23:59:59.999Z";
    return new NextRequest(query ? `${base}&${query}` : base);
}

const detailCtx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.session = null;
});

describe("T4c2 — GET /api/invoices (role scoping)", () => {
    it("rejects an unauthenticated request", async () => {
        mockSessionState.session = null;
        const res = await getInvoices(listUrl());
        expect(res.status).toBe(401);
    });

    it("forces a CASHIER's own userId, discarding a client-supplied ?userId= outright", async () => {
        setSession("user-cashier", "CASHIER");
        mockInvoice.findMany.mockResolvedValue([]);

        const res = await getInvoices(listUrl("userId=user-someone-else"));

        expect(res.status).toBe(200);
        const where = mockInvoice.findMany.mock.calls[0][0].where;
        // Discarded, not merely validated-then-trusted.
        expect(where.userId).toBe("user-cashier");
        expect(where.tenantId).toBe(TENANT_ID);
    });

    it("scopes a CASHIER's list to their own invoices even with no ?userId= sent at all", async () => {
        setSession("user-cashier", "CASHIER");
        mockInvoice.findMany.mockResolvedValue([]);

        await getInvoices(listUrl());

        expect(mockInvoice.findMany.mock.calls[0][0].where.userId).toBe("user-cashier");
    });

    it("lets an ADMIN filter by another staff member", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findMany.mockResolvedValue([]);

        const res = await getInvoices(listUrl("userId=user-cashier"));

        expect(res.status).toBe(200);
        expect(mockInvoice.findMany.mock.calls[0][0].where.userId).toBe("user-cashier");
    });

    it("leaves an ADMIN's list unfiltered (every staff member) when no ?userId= is sent", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findMany.mockResolvedValue([]);

        await getInvoices(listUrl());

        expect(mockInvoice.findMany.mock.calls[0][0].where.userId).toBeUndefined();
    });

    it("never reads outside the tenant, whatever the session says", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findMany.mockResolvedValue([]);

        await getInvoices(listUrl("userId=user-cashier"));

        expect(mockGetTenantDb).toHaveBeenCalledWith(TENANT_ID);
        expect(mockInvoice.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
    });

    it("rejects an over-max limit instead of honouring a full-history request", async () => {
        setSession("user-admin", "ADMIN");
        const res = await getInvoices(listUrl("limit=5000"));
        expect(res.status).toBe(400);
        expect(mockInvoice.findMany).not.toHaveBeenCalled();
    });

    it("rejects an unknown paymentStatus value", async () => {
        setSession("user-admin", "ADMIN");
        const res = await getInvoices(listUrl("paymentStatus=NOT_A_STATUS"));
        expect(res.status).toBe(400);
    });
});

/**
 * Cursor-aware fake table: honours `take` and `cursor`/`skip` exactly like
 * Prisma does for the listing query, so a paging walk in the test is a real
 * walk rather than a re-implementation of it.
 */
function installPagedTable(all: any[]) {
    mockInvoice.findMany.mockImplementation(async (args: any) => {
        let list = all;
        if (args?.cursor?.id) {
            const index = list.findIndex((row) => row.id === args.cursor.id);
            list = index >= 0 ? list.slice(index + (args.skip ?? 0)) : [];
        }
        return list.slice(0, args.take);
    });
}

describe("T4c2 — GET /api/invoices (pagination)", () => {
    it("returns exactly `limit` rows plus a cursor instead of the whole history", async () => {
        setSession("user-admin", "ADMIN");
        installPagedTable(Array.from({ length: 26 }, (_, i) => makeLogRow(`inv-${i}`)));

        const res = await getInvoices(listUrl("limit=25"));
        const json = await res.json();

        expect(json.success).toBe(true);
        expect(json.items).toHaveLength(25);
        expect(json.nextCursor).toBe("inv-24");
        // Never asks the DB for the full table — only limit + 1, to detect
        // whether another page exists.
        expect(mockInvoice.findMany.mock.calls[0][0].take).toBe(26);
    });

    it("walks a 250-invoice tenant page by page, with no duplicates and no gaps", async () => {
        setSession("user-admin", "ADMIN");
        const total = 250;
        installPagedTable(Array.from({ length: total }, (_, i) => makeLogRow(`inv-${i}`)));

        const seen: string[] = [];
        const pageSizes: number[] = [];
        let cursor: string | null = null;
        let requests = 0;

        do {
            const query = cursor ? `limit=25&cursor=${cursor}` : "limit=25";
            const res = await getInvoices(listUrl(query));
            const json = await res.json();

            expect(res.status).toBe(200);
            expect(json.items.length).toBeLessThanOrEqual(25);

            pageSizes.push(json.items.length);
            seen.push(...json.items.map((row: any) => row.id));
            cursor = json.nextCursor;
            requests++;
        } while (cursor && requests < 20);

        // Every invoice appears exactly once, none were skipped.
        expect(seen).toHaveLength(total);
        expect(new Set(seen).size).toBe(total);
        // 250 rows / 25 per page = 10 requests, and no single response ever
        // carried the tenant's entire history.
        expect(requests).toBe(10);
        expect(pageSizes.every((size) => size <= 25)).toBe(true);
    });

    it("bounds the paymentStatus scan to a fixed batch instead of one giant read", async () => {
        setSession("user-admin", "ADMIN");
        installPagedTable([
            makeLogRow("inv-credit", { paidAmountSYP: "0.0000" }),
            makeLogRow("inv-cash"),
            makeLogRow("inv-credit-2", { paidAmountSYP: "0.0000" }),
        ]);

        const res = await getInvoices(listUrl("limit=25&paymentStatus=CASH_FULL"));
        const json = await res.json();

        expect(json.items.map((row: any) => row.id)).toEqual(["inv-cash"]);
        // batch = limit * BATCH_SIZE_MULTIPLIER (3), not the whole table.
        expect(mockInvoice.findMany.mock.calls[0][0].take).toBe(75);
    });
});

describe("T4c2 — payment-status badge, frozen figures, and status coverage", () => {
    it("derives CASH_FULL / CREDIT_FULL / PARTIAL from each invoice's own amounts", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findMany.mockResolvedValue([
            makeLogRow("inv-cash", { totalSYP: "100.0000", paidAmountSYP: "100.0000" }),
            makeLogRow("inv-credit", { totalSYP: "100.0000", paidAmountSYP: "0.0000" }),
            makeLogRow("inv-partial", { totalSYP: "100.0000", paidAmountSYP: "40.0000" }),
        ]);

        const json = await (await getInvoices(listUrl())).json();

        expect(json.items.map((row: any) => row.paymentStatus)).toEqual([
            "CASH_FULL",
            "CREDIT_FULL",
            "PARTIAL",
        ]);
    });

    it("returns each invoice's OWN frozen SYP/USD figures, never a live-rate conversion", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findMany.mockResolvedValue([
            // A deliberately odd rate and matching USD total: if anything
            // reconverted at some other rate, these would no longer agree.
            makeLogRow("inv-1", {
                totalSYP: "375000.0000",
                totalUSD: "25.0000",
                exchangeRateUsed: "15000.0000",
            }),
        ]);

        const json = await (await getInvoices(listUrl())).json();
        const row = json.items[0];

        expect(row.totalSYP).toBe("375000.0000");
        expect(row.totalUSD).toBe("25.0000");
        expect(row.exchangeRateUsed).toBe("15000.0000");
        // Money crosses the wire as strings, never numbers.
        expect(typeof row.totalSYP).toBe("string");
        expect(typeof row.totalUSD).toBe("string");
    });

    it("includes COMPLETED, PENDING_REVIEW and VOIDED alike by default (cash sales included)", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findMany.mockResolvedValue([
            makeLogRow("inv-void", {
                status: "VOIDED",
                voidsInvoiceId: "inv-original",
                customer: { id: "cust-1", name: "زبون نقدي", isSystemGenerated: true },
            }),
            makeLogRow("inv-pending", { status: "PENDING_REVIEW" }),
            makeLogRow("inv-completed", { status: "COMPLETED" }),
        ]);

        const json = await (await getInvoices(listUrl())).json();

        expect(json.items.map((row: any) => row.status)).toEqual([
            "VOIDED",
            "PENDING_REVIEW",
            "COMPLETED",
        ]);
        // The cash sale to the system-generated customer is present, and
        // flagged as such for the UI's "زبون نقدي" badge.
        expect(json.items[0].customer.isSystemGenerated).toBe(true);
        // No status filter is applied by default — the whole point of this
        // screen, versus the Ledger's debt-only view.
        expect(mockInvoice.findMany.mock.calls[0][0].where.status).toBeUndefined();
    });

    it("passes an explicit status filter through to the query", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findMany.mockResolvedValue([]);

        await getInvoices(listUrl("status=VOIDED"));

        expect(mockInvoice.findMany.mock.calls[0][0].where.status).toBe("VOIDED");
    });
});

describe("T4c2 — GET /api/invoices/[id] (detail + cross-link authorization)", () => {
    it("returns 404 for an invoice that does not exist in the tenant", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findUnique.mockResolvedValue(null);

        const res = await getInvoiceDetail(new NextRequest("http://localhost/api/invoices/nope"), detailCtx("nope"));

        expect(res.status).toBe(404);
    });

    it("returns every line item (product, unit, quantity, unit price) for an accessible invoice", async () => {
        setSession("user-cashier", "CASHIER");
        mockInvoice.findUnique.mockResolvedValue(
            makeDetailInvoice("inv-1", {
                userId: "user-cashier",
                items: [
                    {
                        id: "item-1",
                        productId: "prod-1",
                        product: { name: "شاي العروسة" },
                        unitId: "unit-1",
                        unit: { unitName: "طرد" },
                        batchId: "batch-1",
                        quantity: "3.0000",
                        unitPriceSYP: "50000.0000",
                        unitPriceUSD: "3.3333",
                    },
                ],
            })
        );

        const json = await (
            await getInvoiceDetail(new NextRequest("http://localhost/api/invoices/inv-1"), detailCtx("inv-1"))
        ).json();

        expect(json.success).toBe(true);
        expect(json.invoice.items).toHaveLength(1);
        expect(json.invoice.items[0]).toMatchObject({
            productName: "شاي العروسة",
            unitName: "طرد",
            quantity: "3.0000",
            unitPriceSYP: "50000.0000",
            unitPriceUSD: "3.3333",
        });
    });

    it("rejects a CASHIER opening another employee's unrelated invoice (403), even with a valid id", async () => {
        setSession("user-cashier", "CASHIER");
        mockInvoice.findUnique.mockResolvedValue(
            makeDetailInvoice("inv-other", { userId: "user-other", voidsInvoiceId: null, voidsInvoice: null })
        );

        const res = await getInvoiceDetail(
            new NextRequest("http://localhost/api/invoices/inv-other"),
            detailCtx("inv-other")
        );

        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe("FORBIDDEN");
    });

    it("lets a CASHIER open the void that reverses their OWN invoice, and exposes the cross-link both ways", async () => {
        setSession("user-cashier", "CASHIER");
        // The void row: created by the ADMIN, but it reverses this cashier's
        // own sale — the exact case that made the cross-link unreachable.
        mockInvoice.findUnique.mockResolvedValue(
            makeDetailInvoice("inv-void", {
                status: "VOIDED",
                userId: "user-admin",
                voidsInvoiceId: "inv-own-sale",
                voidsInvoice: { userId: "user-cashier" },
                voidReason: "إرجاع كامل من الزبون",
            })
        );

        const res = await getInvoiceDetail(
            new NextRequest("http://localhost/api/invoices/inv-void"),
            detailCtx("inv-void")
        );
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.invoice.voidsInvoiceId).toBe("inv-own-sale");
        expect(json.invoice.originalInvoiceUserId).toBe("user-cashier");
        expect(json.invoice.voidReason).toBe("إرجاع كامل من الزبون");
    });

    it("exposes the reverse cross-link on the original invoice (voidedByInvoiceId) for the UI", async () => {
        setSession("user-admin", "ADMIN");
        mockInvoice.findUnique.mockResolvedValue(
            makeDetailInvoice("inv-original", {
                // The original is append-only: still COMPLETED, and only the
                // voidedBy relation reveals that it has been reversed.
                status: "COMPLETED",
                userId: "user-cashier",
                voidedBy: { id: "inv-void" },
            })
        );

        const json = await (
            await getInvoiceDetail(
                new NextRequest("http://localhost/api/invoices/inv-original"),
                detailCtx("inv-original")
            )
        ).json();

        expect(json.invoice.voidedByInvoiceId).toBe("inv-void");
        expect(json.invoice.originalInvoiceUserId).toBeNull();
    });
});

describe("T4c2 — T2b Role Capability Matrix extension", () => {
    it("permits the sales-log staff filter to ADMIN only", () => {
        expect(ROLE_CAPABILITY_MATRIX["sales_log:view_all_staff"].ADMIN).toBe(true);
        expect(ROLE_CAPABILITY_MATRIX["sales_log:view_all_staff"].CASHIER).toBe(false);
    });

    it("keeps voiding an invoice ADMIN-only (the row's void button → T4d)", () => {
        expect(ROLE_CAPABILITY_MATRIX["ledger:void_invoice"].ADMIN).toBe(true);
        expect(ROLE_CAPABILITY_MATRIX["ledger:void_invoice"].CASHIER).toBe(false);
    });
});




