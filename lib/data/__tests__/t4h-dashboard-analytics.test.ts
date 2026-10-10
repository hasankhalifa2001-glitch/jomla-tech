/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "fs";
import path from "path";
import Decimal from "decimal.js";

/**
 * T4h — Dashboard Analytics: end-to-end route + data-layer tests.
 *
 * REAL here, not mocked:
 *   - app/api/analytics/route.ts — the actual handler under test.
 *   - lib/data/analytics.ts — the actual data layer (windowing, bucketing,
 *     ranking, alert reshaping), so the acceptance figures are exercised as
 *     written rather than re-implemented in the test.
 *   - lib/utils/money.ts and lib/ledger/balance.ts — real decimal arithmetic
 *     and the single T4e ledger formula.
 *   - lib/auth/role-matrix.ts — the real "dashboard:analytics" row.
 *   - lib/inventory/base-unit.ts's requireBaseUnits() — real base-unit name
 *     resolution over a faked product read (graceful degradation included).
 *
 * MOCKED only where a real call needs a real database: the Prisma boundary
 * (getTenantDb + the fakes below), the session, and the THREE narrow dashboard
 * gateways of lib/data/products.ts (product names, unit conversion factors,
 * batch alert sets) — their SQL is the gateway's own concern (and needs its
 * own test against a real/faked Prisma client: the capped, separately counted
 * WHERE clauses live THERE, not in analytics.ts); here they exist only to feed
 * analytics.ts's real derivations.
 *
 * [Revised for the T4h review fixes]
 *   - listBatchAlertRows → listBatchAlertSets (two capped lists, each with its
 *     own exact DB count). analytics.ts no longer filters or caps batch alerts
 *     itself; it reshapes what the gateway returns.
 *   - the expiry boundary is EXACT: start of the local day EXPIRING_SOON_DAYS
 *     from today (no +1 slack).
 *   - invoiceCount is EVENT-DATED: COMPLETED rows created today, independent
 *     of any void (the invoice read no longer even selects `voidedBy`).
 *   - unit conversion factors are fetched ONCE (batched), and a failure to
 *     resolve base-unit names is logged, not swallowed silently.
 *   - the route sets `Cache-Control: private, max-age=30`.
 *
 * COVERAGE → ACCEPTANCE CRITERIA
 *   1. CASHIER rejected server-side, no figure ever exposed.
 *   2. Every KPI equals an independent recomputation over the same rows.
 *   3. The chart reflects the last 7/30 days per the selected filter, with
 *      tenant-local (UTC+3) day boundaries — a 23:30 UTC sale belongs to the
 *      NEXT local day.
 *   4. "Most profitable" vs "top-selling" contain different items.
 *   5. by-value vs by-quantity produce two genuinely different orderings
 *      (quantities converted to BASE units per line).
 *   6. The balance alert never references or implies a payment deadline —
 *      enforced by a static source scan plus a response-shape assertion.
 */

const {
    mockSessionState,
    mockGetTenantDb,
    fakeDb,
    mockListNames,
    mockListFactors,
    mockListBatchSets,
} = vi.hoisted(() => {
    const fakeDb: any = {
        invoice: { findMany: vi.fn(), groupBy: vi.fn() },
        invoiceItem: { findMany: vi.fn() },
        customer: { findMany: vi.fn() },
        customerPayment: { groupBy: vi.fn() },
        tenant: { findUnique: vi.fn() },
        product: { findMany: vi.fn() },
    };
    return {
        fakeDb,
        mockGetTenantDb: vi.fn(() => fakeDb),
        mockSessionState: { session: null as any },
        mockListNames: vi.fn(),
        mockListFactors: vi.fn(),
        mockListBatchSets: vi.fn(),
    };
});

vi.mock("@/lib/db/tenant-scope", () => ({
    getTenantDb: mockGetTenantDb,
    tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(async () => mockSessionState.session) }));

vi.mock("@/lib/data/products", () => ({
    UNKNOWN_PRODUCT_NAME: "منتج غير متوفر",
    listProductNamesByIds: mockListNames,
    listUnitConversionFactors: mockListFactors,
    listBatchAlertSets: mockListBatchSets,
}));

import { GET as getAnalytics } from "@/app/api/analytics/route";
import {
    getAnalyticsDashboard,
    buildProductAggregates,
    rankTopBySalesValue,
    rankTopByQuantity,
    rankTopByProfit,
    lineProfitSYP,
    WINDOW_DAYS,
    EXPIRING_SOON_DAYS,
    ALERT_LIST_LIMIT,
} from "@/lib/data/analytics";
import { UNKNOWN_PRODUCT_NAME } from "@/lib/data/products";
import { computeBalanceSYP } from "@/lib/ledger/balance";
import { ROLE_CAPABILITY_MATRIX } from "@/lib/auth/role-matrix";
import { addLocalDays, localDayKey, startOfLocalDay } from "@/lib/utils/syria-time";

const TENANT_ID = "tenant-1";
/** A fixed clock — the data layer takes `now` so every window is deterministic. */
const NOW = new Date("2026-10-05T12:00:00.000Z"); // 15:00 local (UTC+3) → local day 2026-10-05

const ADMIN_SESSION = { user: { id: "user-admin", tenantId: TENANT_ID, role: "ADMIN" } };
const CASHIER_SESSION = { user: { id: "user-cash", tenantId: TENANT_ID, role: "CASHIER" } };

/** Compare money as exact 4-dp decimals — never via float equality. */
function money(v: string | number): string {
    return new Decimal(v).toFixed(4);
}
function expectMoneyEq(actual: string, expected: string | number): void {
    expect(money(actual)).toBe(money(expected));
}
function expectNullableMoneyEq(actual: string | null, expected: string | number): void {
    // [v4.9] USD aggregates are null when no rated invoice exists today.
    expect(actual).not.toBeNull();
    expect(money(actual as string)).toBe(money(expected));
}

// === SEEDS — one fixed calendar; every date is chosen deliberately ===
const D = (iso: string) => new Date(iso);
const INV_T1 = D("2026-10-05T09:00:00.000Z"); // today (local)
const INV_T2 = D("2026-10-05T10:00:00.000Z"); // today — this original is voided by INV_T3
const INV_T3 = D("2026-10-05T11:00:00.000Z"); // today — VOID mirror row (negated totals)
const INV_T7 = D("2026-10-04T22:30:00.000Z"); // 22:30 UTC yesterday → LOCAL TODAY 01:30
const INV_O4 = D("2026-10-03T10:00:00.000Z"); // two local days ago
const INV_M5 = D("2026-09-15T10:00:00.000Z"); // inside the 30-day window only
const INV_OUT = D("2026-09-01T10:00:00.000Z"); // 35 local days ago — outside BOTH windows

const invoiceRows: any[] = [
    { totalSYP: "10000", totalUSD: "10", status: "COMPLETED", createdAt: INV_T1 },
    { totalSYP: "1000", totalUSD: "1", status: "COMPLETED", createdAt: INV_T2 },
    { totalSYP: "-1000", totalUSD: "-1", status: "VOIDED", createdAt: INV_T3 },
    { totalSYP: "600", totalUSD: "6", status: "COMPLETED", createdAt: INV_T7 },
    { totalSYP: "10000", totalUSD: "10", status: "COMPLETED", createdAt: INV_O4 },
    { totalSYP: "7000", totalUSD: "7", status: "COMPLETED", createdAt: INV_M5 },
    { totalSYP: "99999", totalUSD: "99", status: "COMPLETED", createdAt: INV_OUT },
];

const line = (
    productId: string,
    unitId: string,
    quantity: string,
    unitPriceSYP: string,
    costAmountSYP: string,
    invoice: Date
) => ({ productId, unitId, quantity, unitPriceSYP, costAmountSYP, invoice: { createdAt: invoice } });

const invoiceItemRows: any[] = [
    line("prod-volume", "unit-carton", "5", "120", "540", INV_T1), // 5 cartons, 12 pieces each
    line("prod-volume", "unit-piece", "40", "10", "260", INV_T1),
    line("prod-profit", "unit-lux", "5", "300", "300", INV_T1),
    line("prod-value", "unit-case", "1", "1000", "950", INV_T2),
    line("prod-value", "unit-case", "-1", "1000", "-950", INV_T3), // void mirror line
    line("prod-edge", "unit-edge", "1", "600", "500", INV_T7),
    line("prod-value", "unit-case", "10", "1000", "9900", INV_O4),
    line("prod-value", "unit-case", "7", "1000", "6930", INV_M5),
    line("prod-volume", "unit-piece", "999", "1", "0", INV_OUT), // POISON — must never surface
];

const PRODUCT_NAMES = new Map<string, string>([
    ["prod-volume", "زيت دوار الشمس"],
    ["prod-value", "شاي أحمر"],
    ["prod-profit", "عسل جبلي"],
    ["prod-edge", "تمر مجدول"],
]);

const UNIT_FACTORS = new Map<string, string>([
    ["unit-carton", "12"], // 1 carton = 12 pieces (the product's BASE unit)
    ["unit-piece", "1"],
    ["unit-lux", "1"],
    ["unit-case", "1"],
    ["unit-edge", "1"],
]);

/** requireBaseUnits()'s product read, served by fakeDb.product.findMany. */
const baseUnitRows: any[] = [
    { id: "prod-volume", baseUnitId: "bu-1", baseUnit: { id: "bu-1", unitName: "قطعة" } },
    { id: "prod-value", baseUnitId: "bu-2", baseUnit: { id: "bu-2", unitName: "صندوق" } },
    { id: "prod-profit", baseUnitId: "bu-3", baseUnit: { id: "bu-3", unitName: "كيس" } },
    { id: "prod-edge", baseUnitId: "bu-4", baseUnit: { id: "bu-4", unitName: "عبوة" } },
];

const customers: any[] = [
    { id: "cust-1", name: "شركة الشام", isActive: true },
    { id: "cust-2", name: "بقالة الحارة", isActive: true },
    { id: "cust-3", name: "عميل موقوف", isActive: false },
    { id: "cust-4", name: "مطعم الميدان", isActive: true },
];
const debtGroups: any[] = [
    { customerId: "cust-1", _sum: { debtAmountSYP: "50000" } },
    { customerId: "cust-2", _sum: { debtAmountSYP: "0" } },
    { customerId: "cust-3", _sum: { debtAmountSYP: "30000" } }, // inactive → must not count
    { customerId: "cust-4", _sum: { debtAmountSYP: "10000" } },
];
const repaymentGroups: any[] = [
    { customerId: "cust-1", _sum: { amountSYP: "20000" } },
    { customerId: "cust-3", _sum: { amountSYP: "5000" } },
    { customerId: "cust-4", _sum: { amountSYP: "15000" } }, // overpaid → negative balance
];

const DAY_MS = 86400000;

/**
 * What lib/data/products.ts's listBatchAlertSets() hands back. The gateway —
 * not analytics.ts — selects, caps and COUNTS these in the database, so the
 * mock models its OUTPUT contract: two lists, each with an exact `count`.
 * Rows are deliberately given in the WRONG order to prove analytics.ts still
 * presents them worst-first.
 */
const batchRow = (
    id: string,
    batchNumber: string,
    quantity: string,
    expiryDate: Date | null,
    productId: string,
    productName: string,
    unitName: string
) => ({ id, batchNumber, quantity, expiryDate, productId, productName, unitName });

const BATCH_SETS = {
    needsReconciliation: {
        count: 2,
        rows: [
            batchRow("b-neg", "BN-1", "-3", null, "prod-value", "شاي أحمر", "علبة"),
            batchRow("b-neg2", "BN-2", "-10", null, "prod-volume", "زيت دوار الشمس", "لتر"),
        ],
    },
    expiringSoon: {
        count: 2,
        rows: [
            batchRow("b-soon", "BE-2", "12", new Date(NOW.getTime() + 10 * DAY_MS), "prod-edge", "تمر مجدول", "كرتون"),
            batchRow("b-old", "BE-1", "5", new Date(NOW.getTime() - 2 * DAY_MS), "prod-profit", "عسل جبلي", "كيس"),
        ],
    },
};

beforeEach(() => {
    vi.resetAllMocks();
    mockSessionState.session = ADMIN_SESSION;

    mockGetTenantDb.mockImplementation(() => fakeDb);
    mockListNames.mockImplementation(async () => PRODUCT_NAMES);
    mockListFactors.mockImplementation(async () => UNIT_FACTORS);
    mockListBatchSets.mockImplementation(async () => BATCH_SETS);

    fakeDb.invoice.findMany.mockImplementation(async ({ where }: any) =>
        invoiceRows.filter((r) => r.createdAt >= where.createdAt.gte && r.createdAt < where.createdAt.lt)
    );
    fakeDb.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
        invoiceItemRows.filter(
            (r) =>
                r.invoice.createdAt >= where.invoice.createdAt.gte &&
                r.invoice.createdAt < where.invoice.createdAt.lt
        )
    );
    fakeDb.customer.findMany.mockImplementation(async ({ where }: any) =>
        customers.filter((c) => c.isActive === where.isActive)
    );
    fakeDb.invoice.groupBy.mockImplementation(async () => debtGroups);
    fakeDb.customerPayment.groupBy.mockImplementation(async () => repaymentGroups);
    fakeDb.tenant.findUnique.mockImplementation(async () => ({ dailyExchangeRate: "15000" }));
    fakeDb.product.findMany.mockImplementation(async ({ where }: any) =>
        baseUnitRows.filter((p) => where.id.in.includes(p.id))
    );
});

/** Invokes the real GET handler with a controlled session and query string. */
async function callRoute(query: string, session: unknown) {
    mockSessionState.session = session as any;
    const res = await getAnalytics(new NextRequest(`http://localhost/api/analytics${query}`));
    return { status: res.status, body: await res.json(), headers: res.headers };
}

describe("T4h — GET /api/analytics: route guards", () => {
    it("1a. the real role matrix keeps dashboard:analytics ADMIN-only", () => {
        expect(ROLE_CAPABILITY_MATRIX["dashboard:analytics"].ADMIN).toBe(true);
        expect(ROLE_CAPABILITY_MATRIX["dashboard:analytics"].CASHIER).toBe(false);
    });

    it("1b. unauthenticated callers get 401 before any data is read", async () => {
        const { status, body } = await callRoute("?range=7", null);

        expect(status).toBe(401);
        expect(body.error).toBe("UNAUTHORIZED");
        expect(mockGetTenantDb).not.toHaveBeenCalled();
        expect(fakeDb.invoice.findMany).not.toHaveBeenCalled();
    });

    it("1c. a CASHIER gets 403 with NO figure — the gate runs before every read", async () => {
        const { status, body } = await callRoute("?range=7", CASHIER_SESSION);

        expect(status).toBe(403);
        // No data-layer entry point was ever reached…
        expect(mockGetTenantDb).not.toHaveBeenCalled();
        expect(fakeDb.invoice.findMany).not.toHaveBeenCalled();
        expect(fakeDb.invoiceItem.findMany).not.toHaveBeenCalled();
        expect(mockListBatchSets).not.toHaveBeenCalled();
        // …and no financial figure leaks into the body by any path.
        const raw = JSON.stringify(body);
        for (const leaked of ["kpis", "salesSYP", "salesUSD", "netProfitSYP", "outstandingDebtSYP", "trend", "topProducts"]) {
            expect(raw).not.toContain(leaked);
        }
    });

    it("2. an unsupported range is 400 — and only after the role gate", async () => {
        const ok = await callRoute("?range=13", ADMIN_SESSION);
        expect(ok.status).toBe(400);
        expect(ok.body.error).toBe("VALIDATION_ERROR");

        // A CASHIER asking for garbage still gets 403, not 400: role first.
        const forbidden = await callRoute("?range=13", CASHIER_SESSION);
        expect(forbidden.status).toBe(403);
    });

    it("3. defaults to range=7 and returns a coherent payload (smoke)", async () => {
        const { status, body } = await callRoute("", ADMIN_SESSION);

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.range).toBe(7);
        expect(body.trend).toHaveLength(7);
        // The chart ENDS on today's tenant-local day, whatever the wall clock.
        expect(body.trend[body.trend.length - 1].date).toBe(localDayKey(new Date()));
        for (const point of body.trend) {
            expect(point).toHaveProperty("date");
            expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(new Decimal(point.salesSYP).isFinite()).toBe(true);
            expect(new Decimal(point.profitSYP).isFinite()).toBe(true);
        }
        expect(typeof body.kpis.salesSYP).toBe("string");
        // [v4.9] Null when no rated invoice exists today.
        expect(body.kpis.salesUSD === null || typeof body.kpis.salesUSD === "string").toBe(true);
        expect(typeof body.kpis.netProfitSYP).toBe("string");
        expect(typeof body.kpis.invoiceCount).toBe("number");
        expect(typeof body.kpis.outstandingDebtSYP).toBe("string");
        // Alert COUNTS come straight from the (mocked) gateway — clock-independent.
        expect(body.alerts.needsReconciliation.count).toBe(2);
        expect(body.alerts.expiringSoon.count).toBe(2);
        expect(body.alerts.largeBalances.count).toBe(1);
        expect(body.alerts.largeBalances.items[0].customerName).toBe("شركة الشام");
        for (const list of [body.topProducts.bySalesValue, body.topProducts.byQuantity, body.topProducts.byProfit]) {
            expect(list.length).toBeLessThanOrEqual(5);
        }
    });

    it("3b. range=30 is honoured end to end", async () => {
        const { status, body } = await callRoute("?range=30", ADMIN_SESSION);

        expect(status).toBe(200);
        expect(body.range).toBe(30);
        expect(body.trend).toHaveLength(30);
    });

    it("3b-ii. range=1 (today) is honoured end to end, charted by hour", async () => {
        const { status, body } = await callRoute("?range=1", ADMIN_SESSION);

        expect(status).toBe(200);
        expect(body.range).toBe(1);
        expect(body.trendGranularity).toBe("hour");
        expect(body.trend.length).toBeGreaterThanOrEqual(1);
        expect(body.trend.length).toBeLessThanOrEqual(24);
        for (const point of body.trend) expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    });

    it("3c. the response is private and briefly cacheable (financial data)", async () => {
        const { status, headers } = await callRoute("?range=7", ADMIN_SESSION);

        expect(status).toBe(200);
        // `private` is the point: a shared cache must never store a revenue figure.
        expect(headers.get("cache-control")).toBe("private, max-age=30");
    });

    it("3d. an internal failure is a generic 500 that leaks no detail", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        fakeDb.invoice.findMany.mockImplementation(async () => {
            throw new Error("db down: secret-connection-string");
        });

        const { status, body } = await callRoute("?range=7", ADMIN_SESSION);

        expect(status).toBe(500);
        expect(body.error).toBe("SERVER_ERROR");
        expect(JSON.stringify(body)).not.toContain("secret-connection-string");
        errorSpy.mockRestore();
    });
});

describe("T4h — data layer KPIs (fixed clock, independent recomputation)", () => {
    it("2a. every KPI equals a recomputation over the same seeded rows", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        // Today (local): 10000 + 1000 − 1000 (void mirror) + 600 (22:30 UTC
        // yesterday → local today) = 10600. Out-of-window rows must not add up.
        expectMoneyEq(dash.kpis.salesSYP, 10600);
        expectNullableMoneyEq(dash.kpis.salesUSD, 16);
        // EVENT-DATED count: COMPLETED invoices created today = T1, T2, T7.
        // T2 was later voided, but the count does not move for a void (the VOID
        // mirror row is VOIDED, so it is never counted either) — salesSYP above
        // is what nets the reversal.
        expect(dash.kpis.invoiceCount).toBe(3);
        // Σ(unitPrice × qty − cost) over today's lines: 60 + 140 + 1200 + 50 − 50 + 100.
        expectMoneyEq(dash.kpis.netProfitSYP, 1500);
        // T4e's equation over ACTIVE customers only: (50000−20000) + 0 + (10000−15000).
        const expectedDebt = computeBalanceSYP(["50000", "0", "10000"], ["20000", "0", "15000"]);
        expectMoneyEq(expectedDebt, 25000);
        expectMoneyEq(dash.kpis.outstandingDebtSYP, expectedDebt);
        // The informational current rate travels as a Decimal string.
        expectMoneyEq(dash.exchangeRate!, 15000);
    });

    it("2a-ii. invoiceCount is event-dated: a later void cannot change it", async () => {
        const before = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        // Tomorrow a void is issued against today's INV_T1. In the append-only
        // ledger that is a NEW row dated TOMORROW — it is outside today's
        // window, and today's original row is untouched.
        const TOMORROW = D("2026-10-06T08:00:00.000Z");
        invoiceRows.push({ totalSYP: "-10000", totalUSD: "-10", status: "VOIDED", createdAt: TOMORROW });
        try {
            const after = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });
            expect(after.kpis.invoiceCount).toBe(before.kpis.invoiceCount);
            expectMoneyEq(after.kpis.salesSYP, before.kpis.salesSYP);
        } finally {
            invoiceRows.pop();
        }
    });

    it("2a-iii. the invoice read no longer selects the voidedBy relation", async () => {
        await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        const select = fakeDb.invoice.findMany.mock.calls[0][0].select;
        expect(select).not.toHaveProperty("voidedBy");
        expect(Object.keys(select).sort()).toEqual(["createdAt", "status", "totalSYP", "totalUSD"]);
    });

    it("2b. a KPI card and the trend's last bucket derive from the SAME rows", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });
        const last = dash.trend[dash.trend.length - 1];
        expect(last.date).toBe(localDayKey(NOW));
        expectMoneyEq(dash.kpis.salesSYP, last.salesSYP);
        expectMoneyEq(dash.kpis.netProfitSYP, last.profitSYP);
    });

    it("2c. exchangeRate is null when the tenant's rate is unset or zero", async () => {
        fakeDb.tenant.findUnique.mockResolvedValueOnce(null);
        const unset = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });
        expect(unset.exchangeRate).toBeNull();

        fakeDb.tenant.findUnique.mockResolvedValueOnce({ dailyExchangeRate: "0" });
        const zero = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });
        expect(zero.exchangeRate).toBeNull();
    });

    it("2d. unit conversion factors are requested ONCE, for the distinct sold units", async () => {
        await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        // One batched call (the N+1 fix) — never one call per line or per unit.
        expect(mockListFactors).toHaveBeenCalledTimes(1);
        const [, tenantArg, unitIdsArg] = mockListFactors.mock.calls[0];
        expect(tenantArg).toBe(TENANT_ID);
        expect([...unitIdsArg].sort()).toEqual(
            ["unit-carton", "unit-case", "unit-edge", "unit-lux", "unit-piece"]
        );
    });
});

describe("T4h — windows & tenant-local (UTC+3) day bucketing", () => {
    it("3a. range=7: exactly 7 local days, oldest → newest, ending today", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        expect(dash.trend).toHaveLength(7);
        const expectedDates = Array.from({ length: 7 }, (_, i) =>
            localDayKey(addLocalDays(startOfLocalDay(NOW), -(6 - i)))
        );
        expect(dash.trend.map((p) => p.date)).toEqual(expectedDates);
        expect(expectedDates[expectedDates.length - 1]).toBe("2026-10-05");

        // The 22:30 UTC sale (INV_T7) buckets into LOCAL today, not UTC yesterday.
        const today = dash.trend[6];
        expectMoneyEq(today.salesSYP, 10600);
        expectMoneyEq(today.profitSYP, 1500);

        // INV_O4 (2026-10-03 local) — the window's only other sale day.
        const oct3 = dash.trend.find((p) => p.date === "2026-10-03")!;
        expectMoneyEq(oct3.salesSYP, 10000);
        expectMoneyEq(oct3.profitSYP, 100);

        // Every other bucket exists and is exactly zero — never missing, never NaN.
        for (const point of dash.trend) {
            if (point.date === "2026-10-05" || point.date === "2026-10-03") continue;
            expectMoneyEq(point.salesSYP, 0);
            expectMoneyEq(point.profitSYP, 0);
        }
    });

    it("3b. range=30: 30 buckets incl. mid-window sales; the 35-day-old row stays out", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 30, now: NOW });

        expect(dash.trend).toHaveLength(WINDOW_DAYS);
        expect(dash.trend[0].date).toBe("2026-09-06");
        expect(dash.trend[dash.trend.length - 1].date).toBe("2026-10-05");

        const sep15 = dash.trend.find((p) => p.date === "2026-09-15")!;
        expectMoneyEq(sep15.salesSYP, 7000);
        expectMoneyEq(sep15.profitSYP, 70);

        // The poison row (2026-09-01, 99999 SYP) is outside every window…
        expect(dash.trend.find((p) => p.date === "2026-09-01")).toBeUndefined();
        // …and KPI "today" is window-invariant: one window, one truth.
        expectMoneyEq(dash.kpis.salesSYP, 10600);
    });
});

describe("T4h — range=1 (today): hourly trend over the same rows", () => {
    it("7a. buckets run from local hour 00 to the CURRENT hour — future hours are omitted", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 1, now: NOW });

        expect(dash.range).toBe(1);
        expect(dash.trendGranularity).toBe("hour");
        // NOW = 15:00 local → hours 00..15 inclusive.
        expect(dash.trend).toHaveLength(16);
        expect(dash.trend[0].date).toBe("2026-10-05T00");
        expect(dash.trend[15].date).toBe("2026-10-05T15");
    });

    it("7b. each sale lands in its LOCAL hour (UTC+3), and the buckets sum to the KPI", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 1, now: NOW });
        const at = (key: string) => dash.trend.find((p) => p.date === key)!;

        // 22:30 UTC yesterday = 01:30 local today → hour 01.
        expectMoneyEq(at("2026-10-05T01").salesSYP, 600);
        expectMoneyEq(at("2026-10-05T01").profitSYP, 100);
        // 09:00Z → 12:00 local; 10:00Z → 13:00; 11:00Z (the void mirror) → 14:00.
        expectMoneyEq(at("2026-10-05T12").salesSYP, 10000);
        expectMoneyEq(at("2026-10-05T12").profitSYP, 1400);
        expectMoneyEq(at("2026-10-05T13").salesSYP, 1000);
        expectMoneyEq(at("2026-10-05T14").salesSYP, -1000);
        expectMoneyEq(at("2026-10-05T14").profitSYP, -50);

        // Every other hour exists and is exactly zero.
        const busy = new Set(["01", "12", "13", "14"]);
        for (const p of dash.trend) {
            if (busy.has(p.date.slice(11))) continue;
            expectMoneyEq(p.salesSYP, 0);
            expectMoneyEq(p.profitSYP, 0);
        }

        const sumSales = dash.trend.reduce((acc, p) => acc.plus(p.salesSYP), new Decimal(0));
        const sumProfit = dash.trend.reduce((acc, p) => acc.plus(p.profitSYP), new Decimal(0));
        expectMoneyEq(sumSales.toString(), dash.kpis.salesSYP);
        expectMoneyEq(sumProfit.toString(), dash.kpis.netProfitSYP);
    });

    it("7c. KPIs are identical to the 7-day window's; rankings cover TODAY only", async () => {
        const one = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 1, now: NOW });
        const seven = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        expect(one.kpis).toEqual(seven.kpis);

        const ids = (list: { productId: string }[]) => list.map((a) => a.productId);
        // The 3-days-ago sale (prod-value × 10) is outside a one-day window:
        // prod-value nets to ZERO today (sold 1, voided 1).
        expect(ids(one.topProducts.bySalesValue)).toEqual(["prod-profit", "prod-volume", "prod-edge", "prod-value"]);
        expect(ids(one.topProducts.byQuantity)).toEqual(["prod-volume", "prod-profit", "prod-edge", "prod-value"]);
        expect(ids(one.topProducts.byProfit)).toEqual(["prod-profit", "prod-volume", "prod-edge", "prod-value"]);
        const value = one.topProducts.bySalesValue.find((a) => a.productId === "prod-value")!;
        expectMoneyEq(value.salesSYP, 0);
        expectMoneyEq(value.quantity, 0);
    });

    it("7d. at local 00:30 the chart has exactly one bucket (hour 00)", async () => {
        const justAfterMidnight = D("2026-10-04T21:30:00.000Z"); // 00:30 local on 10-05
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 1, now: justAfterMidnight });

        expect(dash.trend.map((p) => p.date)).toEqual(["2026-10-05T00"]);
    });

    it("7e. daily ranges stay daily", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });
        expect(dash.trendGranularity).toBe("day");
    });
});

describe("T4h — Top-5 product rankings (criteria 4 & 5)", () => {
    const ids = (list: { productId: string }[]) => list.map((a) => a.productId);

    it("4/5. range=7: three DIFFERENT orderings derived from one window", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        // by value:   10000 / 1500 / 1000 / 600
        expect(ids(dash.topProducts.bySalesValue)).toEqual([
            "prod-value",
            "prod-profit",
            "prod-volume",
            "prod-edge",
        ]);
        // by BASE-unit quantity: 100 / 10 / 5 / 1 — the poison 999 never surfaces
        expect(ids(dash.topProducts.byQuantity)).toEqual([
            "prod-volume",
            "prod-value",
            "prod-profit",
            "prod-edge",
        ]);
        // by profit: 1200 / 200 / 100 / 100 (tie → productId ascending)
        expect(ids(dash.topProducts.byProfit)).toEqual([
            "prod-profit",
            "prod-volume",
            "prod-edge",
            "prod-value",
        ]);

        // Acceptance 4: the head of each list is a DIFFERENT product.
        expect(dash.topProducts.bySalesValue[0].productId).toBe("prod-value");
        expect(dash.topProducts.byQuantity[0].productId).toBe("prod-volume");
        expect(dash.topProducts.byProfit[0].productId).toBe("prod-profit");
        // Acceptance 5: by-value vs by-quantity are genuinely different orderings.
        expect(ids(dash.topProducts.bySalesValue)).not.toEqual(ids(dash.topProducts.byQuantity));
    });

    it("4/5b. range=30: rankings recompute over the wider window (prod-value gains 7000)", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 30, now: NOW });

        expect(ids(dash.topProducts.bySalesValue)).toEqual([
            "prod-value",
            "prod-profit",
            "prod-volume",
            "prod-edge",
        ]);
        expect(ids(dash.topProducts.byQuantity)).toEqual([
            "prod-volume",
            "prod-value",
            "prod-profit",
            "prod-edge",
        ]);
        expect(ids(dash.topProducts.byProfit)).toEqual([
            "prod-profit",
            "prod-volume",
            "prod-value",
            "prod-edge",
        ]);
        expectMoneyEq(dash.topProducts.bySalesValue[0].salesSYP, 17000);
        expect(ids(dash.topProducts.bySalesValue)).not.toEqual(ids(dash.topProducts.byQuantity));
    });

    it("5b. quantities are per-line converted to BASE units (carton → 12 pieces)", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        const volume = dash.topProducts.byQuantity.find((a) => a.productId === "prod-volume")!;
        // 5 cartons × 12 + 40 pieces = 100. A raw sum would be 45 and would
        // rank 10 pieces (prod-value) ABOVE 5 cartons — exactly the T4h bug.
        expectMoneyEq(volume.quantity, 100);
        expect(volume.baseUnitName).toBe("قطعة");

        const value = dash.topProducts.bySalesValue.find((a) => a.productId === "prod-value")!;
        expect(value.baseUnitName).toBe("صندوق");
        // Every surfaced product carries a non-empty base-unit label.
        for (const a of dash.topProducts.bySalesValue) {
            expect(a.baseUnitName.length).toBeGreaterThan(0);
        }
    });

    it("5b-ii. if base-unit names cannot be resolved, figures survive, unit labels go blank, and it is LOGGED", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        fakeDb.product.findMany.mockImplementation(async () => {
            throw new Error("base unit lookup failed");
        });

        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        // The dashboard still renders every figure…
        expectMoneyEq(dash.kpis.salesSYP, 10600);
        const volume = dash.topProducts.byQuantity.find((a) => a.productId === "prod-volume")!;
        expectMoneyEq(volume.quantity, 100);
        // …with an empty label rather than a failed request…
        for (const list of [dash.topProducts.bySalesValue, dash.topProducts.byQuantity, dash.topProducts.byProfit]) {
            for (const a of list) expect(a.baseUnitName).toBe("");
        }
        // …and the data-integrity problem is no longer silent.
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it("5c. a missing unit factor is a data-integrity error — it THROWS", () => {
        const factors = new Map(UNIT_FACTORS);
        factors.delete("unit-carton");
        expect(() =>
            buildProductAggregates(
                [line("prod-volume", "unit-carton", "1", "10", "5", INV_T1)],
                PRODUCT_NAMES,
                factors
            )
        ).toThrow(/no conversion factor/);
    });

    it("5d. a product deleted after sale falls back to the shared placeholder constant", () => {
        const aggregates = buildProductAggregates(
            [line("prod-ghost", "unit-piece", "10", "10", "50", INV_T1)],
            PRODUCT_NAMES,
            UNIT_FACTORS
        );
        expect(aggregates).toHaveLength(1);
        expect(aggregates[0].productName).toBe(UNKNOWN_PRODUCT_NAME);
        expectMoneyEq(aggregates[0].salesSYP, 100);
        expectMoneyEq(aggregates[0].profitSYP, 50);
    });
});

describe("T4h — alerts (gateway contract, ordering, counts, no deadlines)", () => {
    it("6a. the gateway is asked for the EXACT horizon and a capped page", async () => {
        await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        // `expiryDate < start of the local day EXPIRING_SOON_DAYS from today`
        // is precisely "fewer than N calendar days to go" — no +1 slack, and
        // measured from the tenant-local start of today, not from `now`.
        expect(mockListBatchSets).toHaveBeenCalledTimes(1);
        expect(mockListBatchSets).toHaveBeenCalledWith(fakeDb, TENANT_ID, {
            expiringBefore: new Date(startOfLocalDay(NOW).getTime() + EXPIRING_SOON_DAYS * DAY_MS),
            limit: ALERT_LIST_LIMIT,
        });
    });

    it("6b. gateway rows are reshaped and presented worst-first", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        const rec = dash.alerts.needsReconciliation;
        expect(rec.count).toBe(2);
        expect(rec.items.map((a) => a.batchId)).toEqual(["b-neg2", "b-neg"]); // −10 before −3
        expect(rec.items[0]).toEqual({
            productId: "prod-volume",
            productName: "زيت دوار الشمس",
            batchId: "b-neg2",
            batchNumber: "BN-2",
            quantity: "-10",
            unitName: "لتر",
        });

        const exp = dash.alerts.expiringSoon;
        expect(exp.count).toBe(2);
        expect(exp.items.map((a) => a.batchId)).toEqual(["b-old", "b-soon"]); // expired first
        expect(exp.items[0].daysToExpiry).toBe(-2);
        expect(exp.items[0].isExpired).toBe(true);
        expect(exp.items[1].daysToExpiry).toBe(10);
        expect(exp.items[1].isExpired).toBe(false);
    });

    it("6c. `count` is the gateway's exact DB count — NOT the length of the capped page", async () => {
        mockListBatchSets.mockImplementation(async () => ({
            needsReconciliation: {
                count: 42,
                rows: Array.from({ length: ALERT_LIST_LIMIT }, (_, i) =>
                    batchRow(`neg-${i}`, `N-${i}`, `-${i + 1}`, null, "prod-volume", "زيت دوار الشمس", "لتر")
                ),
            },
            expiringSoon: { count: 0, rows: [] },
        }));

        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        expect(dash.alerts.needsReconciliation.count).toBe(42);
        expect(dash.alerts.needsReconciliation.items).toHaveLength(ALERT_LIST_LIMIT);
        // Most-under first, even within the page.
        expect(dash.alerts.needsReconciliation.items[0].quantity).toBe("-5");
        expect(dash.alerts.expiringSoon).toEqual({ count: 0, items: [] });
    });

    it("6d. large balances: positive net balances only, ranked descending", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        const large = dash.alerts.largeBalances;
        // cust-2 is zero, cust-4 is negative (overpaid), cust-3 is inactive.
        expect(large.count).toBe(1);
        expect(large.items[0].customerId).toBe("cust-1");
        expectMoneyEq(large.items[0].balanceSYP, 30000);
        // The alert body carries NO payment-deadline concept — exactly three keys.
        expect(Object.keys(large.items[0]).sort()).toEqual(["balanceSYP", "customerId", "customerName"]);
    });

    it("6e. large balances are capped at ALERT_LIST_LIMIT with the FULL count", async () => {
        const many = Array.from({ length: 7 }, (_, i) => ({
            id: `c-${i}`,
            name: `زبون ${i}`,
            isActive: true,
        }));
        fakeDb.customer.findMany.mockImplementation(async () => many);
        fakeDb.invoice.groupBy.mockImplementation(async () =>
            many.map((c, i) => ({ customerId: c.id, _sum: { debtAmountSYP: String((i + 1) * 1000) } }))
        );
        fakeDb.customerPayment.groupBy.mockImplementation(async () => []);

        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });

        expect(dash.alerts.largeBalances.count).toBe(7);
        expect(dash.alerts.largeBalances.items).toHaveLength(ALERT_LIST_LIMIT);
        expect(dash.alerts.largeBalances.items.map((a) => a.customerId)).toEqual([
            "c-6",
            "c-5",
            "c-4",
            "c-3",
            "c-2",
        ]);
        expectMoneyEq(dash.alerts.largeBalances.items[0].balanceSYP, 7000);
    });
});

describe("T4h — pure helpers (no database)", () => {
    it("lineProfitSYP: a void line is the EXACT negation of the original", () => {
        const original = lineProfitSYP("10", "3", "25"); // 10×3 − 25
        const mirror = lineProfitSYP("10", "-3", "-25"); // 10×(−3) − (−25)
        expectMoneyEq(original, 5);
        expectMoneyEq(mirror, -5);
        // Adding the two must give EXACTLY zero — the void nets out.
        expect(new Decimal(original).plus(mirror).toFixed(4)).toBe("0.0000");
    });

    it("rank helpers: metric-descending, productId tie-break, limit applied", () => {
        const agg = (productId: string, salesSYP: string, quantity: string, profitSYP: string) => ({
            productId,
            productName: productId,
            salesSYP,
            quantity,
            baseUnitName: "وحدة",
            profitSYP,
        });
        const seed = [
            agg("p-b", "100", "1", "10"),
            agg("p-a", "100", "1", "10"),
            agg("p-c", "50", "9", "99"),
        ];

        expect(rankTopBySalesValue(seed, 2).map((a) => a.productId)).toEqual(["p-a", "p-b"]);
        expect(rankTopByQuantity(seed, 2).map((a) => a.productId)).toEqual(["p-c", "p-a"]);
        expect(rankTopByProfit(seed, 3).map((a) => a.productId)).toEqual(["p-c", "p-a", "p-b"]);
    });

    it("windows stay aligned with T3c's inventory filter and the list caps", () => {
        expect(WINDOW_DAYS).toBe(30);
        expect(EXPIRING_SOON_DAYS).toBe(60); // same horizon as the inventory screen's `expiring`
        expect(ALERT_LIST_LIMIT).toBe(5);
    });
});

describe("T4h — static scan: no payment-deadline concept (criterion 6)", () => {
    const ANALYTICS_FILES = [
        "app/api/analytics/route.ts",
        "lib/data/analytics.ts",
        "components/dashboard/analytics-client.tsx",
    ];
    // FIELD-level patterns only: prose that explicitly REFUSES a deadline
    // (buildAlerts's NOTE) is legitimate and must not trip the scan.
    const BANNED = [
        /dueDate/i,
        /due_date/i,
        /paymentDue/i,
        /lateFee/i,
        /amortizationSchedule/i,
        /deadlineDate/i,
        /deadline:/i,
        /موعد الدفع/i,
        /أقساط/i,
    ];

    it.each(ANALYTICS_FILES)("%s carries no due-date/deadline/amortization field", (file) => {
        const source = readFileSync(path.join(process.cwd(), file), "utf8");
        for (const pattern of BANNED) {
            expect(pattern.test(source), `${file} must not contain ${pattern}`).toBe(false);
        }
    });

    it("the serialized balance alert exposes a balance — and nothing schedule-shaped", async () => {
        const dash = await getAnalyticsDashboard(fakeDb, TENANT_ID, { range: 7, now: NOW });
        const raw = JSON.stringify(dash.alerts.largeBalances);
        for (const pattern of [/dueDate/i, /paymentDue/i, /deadline/i, /amortization/i]) {
            expect(pattern.test(raw)).toBe(false);
        }
    });
});