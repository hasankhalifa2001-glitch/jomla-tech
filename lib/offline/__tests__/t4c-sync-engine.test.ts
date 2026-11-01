/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T4c — /api/sync test suite (v4.8 + T6c/D10 + v6.2)
 *
 * Runs the REAL route handler (app/api/sync/route.ts), the REAL fifo.ts and
 * the REAL batch-locking.ts against an in-memory, TRANSACTIONAL fake of the
 * Prisma client (state is snapshotted on $transaction entry and restored when
 * the callback throws, so atomicity is actually exercised).
 *
 * Mocked: auth, tenant-scope (raw lock query is recorded, not executed),
 * base-unit, units (decimal.js re-implementation of toBaseUnit/fromBaseUnit),
 * resolve-active, repayment, subscription status (getFreshEffectiveStatus),
 * role-matrix (only for the online void route tests).
 *
 * KNOWN LIMIT (same as T3c's note): this fake is single-threaded, so it proves
 * the LOGIC (per-line deduction, void math, ordering of lock vs write, status
 * mapping) but NOT real Postgres concurrency (two devices racing the last
 * units, deadlock freedom). Those belong to T7's real-DB concurrency suite.
 *
 * Product fixtures: P1 has base unit "P1-base" (factor 1, "قطعة") and
 * "P1-pack" (factor 24, "طرد"). P2 has base unit "P2-base" only.
 *
 * [v6.2 / this revision]
 *  - FIX: seeded users now carry isActive: true. The route resolves the
 *    record's author with `where: { id, tenantId, isActive: true }`, and the
 *    fake matches strictly, so users seeded without the flag were "not found"
 *    and every sale/void/payment failed with "المستخدم ... غير موجود" (this was
 *    the cause of the 40 failing tests).
 *  - ADD: sale-time price override (ADMIN gate, listUnitPriceSYP /
 *    hasPriceOverride storage), offline void of an invoice that sold the same
 *    product/unit at several prices (void groups by product/unit/PRICE), the
 *    online void route copying price + catalog fields row by row, and a
 *    characterization test for the documented limit (an UNDECLARED lower price
 *    is accepted as an ordinary sale).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";

// ----------------------------------------------------------------------------
// Shared mutable test state (hoisted so vi.mock factories can reach it)
// ----------------------------------------------------------------------------
const h = vi.hoisted(() => ({
    session: null as any,
    db: null as any,
    events: [] as string[],
    rawQueries: [] as string[],
    lockCalls: [] as string[][],
    txFailures: 0,
    hideVoidLookup: false,
    mergeMap: {} as Record<string, string>,
    unitFactors: { "P1-base": "1", "P1-pack": "24", "P2-base": "1" } as Record<string, string>,
    // [T6c] What getFreshEffectiveStatus returns. Reset to ACTIVE in beforeEach.
    effective: null as any,
}));

vi.mock("@/auth", () => ({ auth: async () => h.session }));

vi.mock("@/lib/db", () => ({
    prisma: {
        $transaction: (fn: any) => h.db.$transaction(fn),
        customer: { findFirst: (a: any) => h.db.customer.findFirst(a) },
        invoice: { findFirst: (a: any) => h.db.invoice.findFirst(a) },
        user: { findFirst: (a: any) => h.db.user.findFirst(a) },
    },
}));

vi.mock("@/lib/db/tenant-scope", async () => {
    const { Prisma: P } = await import("@prisma/client");
    return {
        getTenantDb: vi.fn(),
        // The ONLY raw-query path: record it as a "lock" event + capture its SQL.
        tenantScopedRawQuery: async (_tx: unknown, tenantId: string, build: (c: unknown) => any) => {
            h.events.push("lock");
            const sql = build(P.sql`"tenantId" = ${tenantId}`);
            h.rawQueries.push(String(sql.sql));
            return [];
        },
    };
});

vi.mock("@/lib/inventory/batch-locking", async () => {
    const actual = await vi.importActual<typeof import("@/lib/inventory/batch-locking")>(
        "@/lib/inventory/batch-locking"
    );
    return {
        lockBatchesForFifoAllocations: async (tx: any, tenantId: string, productIds: string[]) => {
            h.lockCalls.push([...productIds]);
            return actual.lockBatchesForFifoAllocations(tx, tenantId, productIds);
        },
    };
});

vi.mock("@/lib/inventory/base-unit", () => ({
    MissingBaseUnitError: class MissingBaseUnitError extends Error { },
    requireBaseUnit: async (_tx: unknown, _t: string, productId: string) => ({
        id: `${productId}-base`,
        unitName: "قطعة",
    }),
}));

vi.mock("@/lib/inventory/units", async () => {
    const { default: D } = await import("decimal.js");
    return {
        getUnitConversionFactor: async (_tx: unknown, _t: string, unitId: string) => {
            const f = h.unitFactors[unitId];
            if (!f) throw new Error(`unit ${unitId} not found`);
            return f;
        },
        toBaseUnit: (q: string | number, f: string) => new D(q).times(f),
        fromBaseUnit: (q: string | number, f: string) => new D(q).div(f),
    };
});

vi.mock("@/lib/customers/resolve-active", () => ({
    resolveActiveCustomerId: async (_tx: unknown, _t: string, id: string) => h.mergeMap[id] ?? id,
}));

vi.mock("@/lib/ledger/repayment", () => ({
    recordRepaymentIdempotent: vi.fn(async () => ({ paymentId: "pay-1" })),
}));

// [T6c] /api/sync no longer calls assertTenantWritable (that would 403 the
// whole batch and lose pre-lock offline sales). It reads the effective status
// ONCE via getFreshEffectiveStatus and decides per item.
vi.mock("@/lib/auth/tenant", async () => {
    const { NextResponse } = await import("next/server");
    class SubscriptionLockedError extends Error { }
    return {
        assertTenantWritable: vi.fn(async () => { }),
        getFreshEffectiveStatus: vi.fn(async () => h.effective),
        SubscriptionLockedError,
        subscriptionLockedResponse: () =>
            NextResponse.json({ error: "SUBSCRIPTION_LOCKED" }, { status: 403 }),
    };
});

// [v6.2] Only the online void route (/api/ledger/voids) uses the role matrix.
// Mocked so these tests exercise the void LOGIC, not the matrix itself: the
// "ledger:void_invoice" permission is ADMIN-only, like the real matrix.
vi.mock("@/lib/auth/role-matrix", async () => {
    const { NextResponse } = await import("next/server");
    class ForbiddenRoleError extends Error { }
    return {
        ForbiddenRoleError,
        assertRolePermission: (role: string, permission: string) => {
            if (permission === "ledger:void_invoice" && role !== "ADMIN") {
                throw new ForbiddenRoleError("forbidden");
            }
        },
        forbiddenRoleResponse: () => NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
    };
});

import { POST } from "@/app/api/sync/route";
import { commitFifoAllocation } from "@/lib/inventory/fifo";
import { assertTenantWritable } from "@/lib/auth/tenant";
import { recordRepaymentIdempotent } from "@/lib/ledger/repayment";
import { getTenantDb } from "@/lib/db/tenant-scope";

// ----------------------------------------------------------------------------
// In-memory transactional fake of the Prisma tx/client
// ----------------------------------------------------------------------------
function makeStore() {
    return {
        batches: [] as any[],
        invoices: [] as any[],
        invoiceItems: [] as any[],
        payments: [] as any[],
        customers: [] as any[],
        users: [] as any[],
    };
}
type Store = ReturnType<typeof makeStore>;

function matches(row: any, where: any): boolean {
    return Object.entries(where ?? {}).every(([k, v]) => {
        if (v !== null && typeof v === "object" && !(v instanceof Date)) {
            if ("gt" in (v as any)) return new Decimal(row[k]).gt((v as any).gt);
            if ("in" in (v as any)) return (v as any).in.includes(row[k]);
        }
        return row[k] === v;
    });
}

function p2002(field: string) {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: [field] },
    });
}

function makeDb(store: Store) {
    let seq = 0;

    // Shared by invoice.findFirst / invoice.findUnique.
    const loadInvoice = ({ where, include }: any) => {
        const row = store.invoices.find((i) => matches(i, where));
        if (!row) return null;
        return include?.items
            ? { ...row, items: store.invoiceItems.filter((it) => it.invoiceId === row.id) }
            : { ...row };
    };

    const tx = {
        tenant: {
            findUnique: async () => {
                h.events.push("tenant-lookup");
                return { dailyExchangeRate: { toString: () => "135" } };
            },
        },
        customer: {
            findFirst: async ({ where }: any) => store.customers.find((c) => matches(c, where)) ?? null,
            create: async ({ data }: any) => {
                const row = { id: `cust-${++seq}`, isSystemGenerated: false, ...data };
                store.customers.push(row);
                return row;
            },
        },
        user: {
            findFirst: async ({ where }: any) => store.users.find((u) => matches(u, where)) ?? null,
        },
        productBatch: {
            findMany: async ({ where }: any) =>
                store.batches.filter((b) => matches(b, where)).map((b) => ({ ...b })),
            findFirst: async ({ where }: any) =>
                [...store.batches]
                    .filter((b) => matches(b, where))
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))[0] ?? null,
            update: async ({ where, data }: any) => {
                h.events.push("update");
                const b = store.batches.find((x) => matches(x, where));
                if (!b) throw new Error("batch not found");
                const q = new Decimal(b.quantity);
                if (data.quantity.decrement !== undefined) {
                    b.quantity = q.minus(data.quantity.decrement).toFixed(4);
                } else if (data.quantity.increment !== undefined) {
                    b.quantity = q.plus(data.quantity.increment).toFixed(4);
                }
                return b;
            },
        },
        invoice: {
            findFirst: async (args: any) => {
                if (args.where.voidsInvoiceId && h.hideVoidLookup) return null;
                return loadInvoice(args);
            },
            // [v6.2] used by the online void route (/api/ledger/voids)
            findUnique: async (args: any) => loadInvoice(args),
            create: async ({ data }: any) => {
                if (data.offlineId && store.invoices.some((i) => i.offlineId === data.offlineId)) {
                    throw p2002("offlineId");
                }
                if (data.voidsInvoiceId && store.invoices.some((i) => i.voidsInvoiceId === data.voidsInvoiceId)) {
                    throw p2002("voidsInvoiceId");
                }
                const row = { id: `inv-${++seq}`, ...data };
                store.invoices.push(row);
                return row;
            },
        },
        invoiceItem: {
            create: async ({ data }: any) => {
                const row = { id: `item-${++seq}`, ...data };
                store.invoiceItems.push(row);
                return row;
            },
        },
        customerPayment: {
            create: async ({ data }: any) => {
                const row = { id: `pay-${++seq}`, ...data };
                store.payments.push(row);
                return row;
            },
        },
    };

    return {
        ...tx,
        async $transaction(fn: any) {
            if (h.txFailures > 0) {
                h.txFailures--;
                throw new Error("deadlock detected");
            }
            const snapshot = structuredClone(store);
            try {
                return await fn(tx);
            } catch (err) {
                Object.assign(store, snapshot); // rollback
                throw err;
            }
        },
    };
}

// ----------------------------------------------------------------------------
// Fixtures & helpers
// ----------------------------------------------------------------------------
let store: Store;
let batchSeq = 0;

function seedBatch(id: string, productId: string, qty: string, expiry: string | null, cost = "10") {
    store.batches.push({
        id,
        tenantId: "t1",
        productId,
        batchNumber: `BN-${id}`,
        quantity: new Decimal(qty).toFixed(4),
        expiryDate: expiry ? new Date(expiry) : null,
        costPricePerBaseUnit: cost,
        createdAt: new Date(2026, 0, 1, 0, 0, ++batchSeq),
    });
}

const qty = (id: string): string => store.batches.find((b) => b.id === id).quantity;
const eq = (a: string, b: string) => new Decimal(a).eq(b);
const itemsOf = (invoiceId: string) => store.invoiceItems.filter((i) => i.invoiceId === invoiceId);

interface LineIn {
    productId?: string;
    unitId: string;
    quantity: string;
    price: string;
    // [v6.2] catalog price the device claims it showed. undefined => the key
    // is omitted from the payload (an old client); null => explicit null.
    list?: string | null;
}

function mapLine(i: LineIn, quantity: string) {
    return {
        productId: i.productId ?? "P1",
        unitId: i.unitId,
        quantity,
        unitPriceSYP: i.price,
        unitPriceUSD: null,
        ...(i.list !== undefined ? { listUnitPriceSYP: i.list } : {}),
    };
}

function saleInvoice(o: {
    offlineId: string;
    items: LineIn[];
    customerId?: string;
    createdByUserId?: string;
    createdAt?: string;
    rate?: string | null; // undefined => "135"; null => no rate at all
}) {
    const total = o.items.reduce(
        (s, i) => s.plus(new Decimal(i.quantity).abs().times(i.price)),
        new Decimal(0)
    );
    return {
        offlineId: o.offlineId,
        customerId: o.customerId ?? "cust-cash",
        items: o.items.map((i) => mapLine(i, i.quantity)),
        totalSYP: total.toFixed(4),
        totalUSD: null,
        exchangeRateUsed: o.rate === undefined ? "135" : o.rate,
        paidAmountSYP: total.toFixed(4),
        paidAmountUSD: null,
        debtAmountSYP: "0.0000",
        debtAmountUSD: null,
        paymentMethod: "CASH",
        createdByUserId: o.createdByUserId,
        createdAt: o.createdAt ?? new Date().toISOString(),
    };
}

function voidInvoice(o: {
    offlineId: string;
    voids: string;
    items: LineIn[]; // quantities given POSITIVE; negated here
    customerId?: string;
    createdByUserId?: string;
    rate?: string | null; // what the PAYLOAD claims; the server must ignore it
}) {
    const total = o.items.reduce(
        (s, i) => s.plus(new Decimal(i.quantity).abs().times(i.price)),
        new Decimal(0)
    );
    return {
        offlineId: o.offlineId,
        voidsOfflineInvoiceId: o.voids,
        voidReason: "سبب الإلغاء",
        customerId: o.customerId ?? "cust-cash",
        items: o.items.map((i) => mapLine(i, `-${new Decimal(i.quantity).abs().toString()}`)),
        totalSYP: total.negated().toFixed(4),
        totalUSD: null,
        exchangeRateUsed: o.rate === undefined ? "135" : o.rate,
        paidAmountSYP: total.negated().toFixed(4),
        paidAmountUSD: null,
        debtAmountSYP: "0.0000",
        debtAmountUSD: null,
        createdByUserId: o.createdByUserId,
        createdAt: new Date(Date.now() + 1000).toISOString(),
    };
}

async function postSync(body: unknown) {
    const res = await POST(
        new NextRequest("http://localhost/api/sync", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        })
    );
    return { status: res.status, json: await res.json() };
}

const PACK_PRICE = "24000";
const PIECE_PRICE = "1000";

beforeEach(() => {
    store = makeStore();
    h.db = makeDb(store);
    h.session = { user: { id: "admin1", tenantId: "t1", role: "ADMIN" } };
    h.events.length = 0;
    h.rawQueries.length = 0;
    h.lockCalls.length = 0;
    h.txFailures = 0;
    h.hideVoidLookup = false;
    h.mergeMap = {};
    batchSeq = 0;

    // [T6c] Default: an ordinary active subscription (writable, never locked).
    h.effective = {
        status: "ACTIVE",
        writable: true,
        lockAt: null,
        daysLeft: 30,
        graceDaysLeft: 0,
    };

    // [v6.2 FIX] isActive: true is REQUIRED — the route looks the author up
    // with `isActive: true` and this fake matches strictly.
    store.users.push(
        { id: "admin1", tenantId: "t1", role: "ADMIN", isActive: true },
        { id: "cashier1", tenantId: "t1", role: "CASHIER", isActive: true },
        { id: "cashier2", tenantId: "t1", role: "CASHIER", isActive: true },
        // a deactivated user of this tenant, and an ADMIN of ANOTHER tenant
        { id: "ex-cashier", tenantId: "t1", role: "CASHIER", isActive: false },
        { id: "foreign-admin", tenantId: "t2", role: "ADMIN", isActive: true }
    );
    store.customers.push(
        { id: "cust-cash", tenantId: "t1", isSystemGenerated: true, offlineId: null },
        { id: "cust-old", tenantId: "t1", isSystemGenerated: false, offlineId: null },
        { id: "cust-new", tenantId: "t1", isSystemGenerated: false, offlineId: null }
    );

    vi.mocked(assertTenantWritable).mockClear();
    vi.mocked(recordRepaymentIdempotent).mockClear();
    // [v6.2] the online void route gets its DB through getTenantDb(tenantId)
    vi.mocked(getTenantDb).mockImplementation((() => h.db) as any);
});

// ----------------------------------------------------------------------------
describe("T4c — sale with a FIFO split across batches (v4.8 baseQuantity)", () => {
    it("1 طرد مقسوم 20/4: خصم دقيق + baseQuantity لكل سطر", async () => {
        seedBatch("A", "P1", "20", "2026-12-01");
        seedBatch("B", "P1", "100", "2027-06-01");

        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "0")).toBe(true);
        expect(eq(qty("B"), "96")).toBe(true);

        const items = itemsOf(json.invoices[0].realId);
        expect(items).toHaveLength(2);
        expect(items.map((i) => i.batchId)).toEqual(["A", "B"]);
        expect(eq(items[0].baseQuantity, "20")).toBe(true);
        expect(eq(items[1].baseQuantity, "4")).toBe(true);
        // العرض فقط بوحدة البيع (مقرّب)
        expect(items[0].quantity).toBe("0.8333");
        expect(items[1].quantity).toBe("0.1667");
        // التكلفة من الكمية الأساسية الدقيقة (20 x 10 و 4 x 10)
        expect(eq(items[0].costAmountSYP, "200")).toBe(true);
        expect(eq(items[1].costAmountSYP, "40")).toBe(true);
    });

    it("الإلغاء بعد التقسيم يرجّع 20 و 100 بالضبط (لا 19.9992 ولا 100.0008)", async () => {
        seedBatch("A", "P1", "20", "2026-12-01");
        seedBatch("B", "P1", "100", "2027-06-01");

        await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }] })],
        });
        const { json } = await postSync({
            invoices: [voidInvoice({ offlineId: "v1", voids: "s1", items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "20")).toBe(true);
        expect(eq(qty("B"), "100")).toBe(true);

        const voidItems = itemsOf(json.invoices[0].realId);
        expect(eq(voidItems[0].baseQuantity, "-20")).toBe(true);
        expect(eq(voidItems[1].baseQuantity, "-4")).toBe(true);
    });

    it("بيع طرد مقسوم 8/8/8 ثم إلغاؤه كاملاً ينجح (كان FAILED دائماً)", async () => {
        seedBatch("A", "P1", "8", "2026-12-01");
        seedBatch("B", "P1", "8", "2027-01-01");
        seedBatch("C", "P1", "100", "2027-06-01");

        const sale = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }] })],
        });
        expect(sale.json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "0")).toBe(true);
        expect(eq(qty("B"), "0")).toBe(true);
        expect(eq(qty("C"), "92")).toBe(true);
        expect(itemsOf(sale.json.invoices[0].realId).map((i) => i.quantity)).toEqual(["0.3333", "0.3333", "0.3333"]);

        const v = await postSync({
            invoices: [voidInvoice({ offlineId: "v1", voids: "s1", items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }] })],
        });
        expect(v.json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "8")).toBe(true);
        expect(eq(qty("B"), "8")).toBe(true);
        expect(eq(qty("C"), "100")).toBe(true);
    });

    it("إلغاء بكمية لا تطابق الأصل (2 طرد بدل 1) → FAILED والمخزون بلا تغيير", async () => {
        seedBatch("A", "P1", "20", "2026-12-01");
        seedBatch("B", "P1", "100", "2027-06-01");
        await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }] })],
        });
        const before = [qty("A"), qty("B")];

        const { json } = await postSync({
            invoices: [voidInvoice({ offlineId: "v1", voids: "s1", items: [{ unitId: "P1-pack", quantity: "2", price: PACK_PRICE }] })],
        });
        expect(json.invoices[0].status).toBe("FAILED");
        expect([qty("A"), qty("B")]).toEqual(before);
    });
});

describe("T4c — سلة بنفس المنتج بوحدتين (خصم لكل بند)", () => {
    it("1 طرد + 5 قطع: A=0 (مو -5) و B=91", async () => {
        seedBatch("A", "P1", "20", "2026-12-01");
        seedBatch("B", "P1", "100", "2027-06-01");

        const { json } = await postSync({
            invoices: [
                saleInvoice({
                    offlineId: "s1",
                    items: [
                        { unitId: "P1-pack", quantity: "1", price: PACK_PRICE },
                        { unitId: "P1-base", quantity: "5", price: PIECE_PRICE },
                    ],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "0")).toBe(true);
        expect(eq(qty("B"), "91")).toBe(true);
        expect(store.batches.every((b) => new Decimal(b.quantity).gte(0))).toBe(true);

        const total = itemsOf(json.invoices[0].realId).reduce((s, i) => s.plus(i.baseQuantity), new Decimal(0));
        expect(total.eq(29)).toBe(true);
    });

    it("تُقفل دفعات كل المنتجات مرة وحدة وقبل أي كتابة", async () => {
        seedBatch("A", "P1", "50", "2026-12-01");
        seedBatch("C", "P2", "10", "2026-12-01");

        await postSync({
            invoices: [
                saleInvoice({
                    offlineId: "s1",
                    items: [
                        { productId: "P1", unitId: "P1-base", quantity: "1", price: PIECE_PRICE },
                        { productId: "P2", unitId: "P2-base", quantity: "1", price: PIECE_PRICE },
                    ],
                }),
            ],
        });

        expect(h.lockCalls).toHaveLength(1);
        expect([...h.lockCalls[0]].sort()).toEqual(["P1", "P2"]);
        expect(h.events[0]).toBe("lock");
        expect(h.events.indexOf("lock")).toBeLessThan(h.events.indexOf("update"));

        const sql = h.rawQueries[0];
        expect(sql).toMatch(/ORDER BY id ASC/);
        expect(sql).toMatch(/FOR UPDATE/);
        expect(sql).not.toMatch(/quantity\s*>/); // لا فلتر كمية قبل القفل
    });
});

describe("T4c — سياسة النقص (overdraw)", () => {
    it("مخزون جزئي: الباقي يروح سالب على نفس الدفعة والفاتورة SYNCED", async () => {
        seedBatch("X", "P1", "3", "2026-12-01");

        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "5", price: PIECE_PRICE }] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("X"), "-2")).toBe(true);
        const items = itemsOf(json.invoices[0].realId);
        expect(items.map((i) => i.baseQuantity).map((v) => new Decimal(v).toNumber())).toEqual([3, 2]);
    });

    it("كل الدفعات صفر: الفاتورة SYNCED والدفعة الأحدث تصير -2 (كان FAILED)", async () => {
        seedBatch("Z", "P1", "0", "2026-12-01");

        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "2", price: PIECE_PRICE }] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("Z"), "-2")).toBe(true);
    });

    it("منتج بلا أي دفعة: FAILED ولا يُكتب شيء (ذرّية)", async () => {
        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "s1", items: [{ productId: "P2", unitId: "P2-base", quantity: "1", price: PIECE_PRICE }] }),
            ],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(store.invoices).toHaveLength(0);
        expect(store.invoiceItems).toHaveLength(0);
    });
});

describe("T4c — idempotency وصحة الإدخال", () => {
    it("نفس offlineId مرتين: SYNCED بنفس realId والخصم مرة وحدة", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        const body = {
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        };

        const first = await postSync(body);
        const second = await postSync(body);

        expect(first.json.invoices[0].status).toBe("SYNCED");
        expect(second.json.invoices[0].status).toBe("SYNCED");
        expect(second.json.invoices[0].realId).toBe(first.json.invoices[0].realId);
        expect(eq(qty("A"), "90")).toBe(true);
        expect(store.invoices).toHaveLength(1);
    });

    it("الكمية كرقم JS أو كنص كلاهما مقبول", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        const inv = saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "2", price: PIECE_PRICE }] });
        (inv.items[0] as any).quantity = 2;

        const { json } = await postSync({ invoices: [inv] });
        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "98")).toBe(true);
    });

    it("كمية صفر أو إشارة خاطئة → 400 VALIDATION_ERROR", async () => {
        const zero = saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "1", price: PIECE_PRICE }] });
        (zero.items[0] as any).quantity = "0";
        expect((await postSync({ invoices: [zero] })).status).toBe(400);

        const negativeSale = saleInvoice({ offlineId: "s2", items: [{ unitId: "P1-base", quantity: "1", price: PIECE_PRICE }] });
        (negativeSale.items[0] as any).quantity = "-1";
        expect((await postSync({ invoices: [negativeSale] })).status).toBe(400);
    });

    it("إجمالي لا يطابق مجموع البنود → FAILED", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        const inv = saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "2", price: PIECE_PRICE }] });
        inv.totalSYP = "999.0000";
        inv.paidAmountSYP = "999.0000";

        const { json } = await postSync({ invoices: [inv] });
        expect(json.invoices[0].status).toBe("FAILED");
        expect(eq(qty("A"), "100")).toBe(true);
    });
});

describe("T4c — الإلغاء: صلاحيات، تكرار، تبعيات", () => {
    it("جلسة كاشير لا تستطيع الإلغاء → FAILED بدون أي تغيير", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });

        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };
        const { json } = await postSync({
            invoices: [voidInvoice({ offlineId: "v1", voids: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toMatch(/ADMIN/);
        expect(eq(qty("A"), "90")).toBe(true);
    });

    it("إلغاء ثاني لنفس الفاتورة (offlineId مختلف) → FAILED والمخزون ما يتضاعف", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });
        const v1 = await postSync({
            invoices: [voidInvoice({ offlineId: "v1", voids: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });
        expect(v1.json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "100")).toBe(true);

        const v2 = await postSync({
            invoices: [voidInvoice({ offlineId: "v2", voids: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });
        expect(v2.json.invoices[0].status).toBe("FAILED");
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("سباق حقيقي على voidsInvoiceId (P2002) → FAILED برسالة واضحة، لا نص Prisma", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });
        await postSync({
            invoices: [voidInvoice({ offlineId: "v1", voids: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });

        h.hideVoidLookup = true; // الفحص المسبق ما يشوف الإلغاء الأول (محاكاة السباق)
        const { json } = await postSync({
            invoices: [voidInvoice({ offlineId: "v2", voids: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).not.toMatch(/Unique constraint/i);
        expect(json.invoices[0].error).toMatch(/إلغاء/);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("بيع RETRY_LATER (deadlock) + إلغاؤه بنفس الطلب → كلاهما RETRY_LATER لا FAILED", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        h.txFailures = 3; // تستنفد محاولات البيع الثلاث

        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] }),
                voidInvoice({ offlineId: "v1", voids: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] }),
            ],
        });

        const byId = Object.fromEntries(json.invoices.map((r: any) => [r.offlineId, r.status]));
        expect(byId.s1).toBe("RETRY_LATER");
        expect(byId.v1).toBe("RETRY_LATER");
        expect(json.success).toBe(false);
        expect(store.invoices).toHaveLength(0);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("زبون دُمج بعد البيع وقبل الإلغاء: سطر الإلغاء يهبط على الناجي", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        await postSync({
            invoices: [
                saleInvoice({ offlineId: "s1", customerId: "cust-old", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] }),
            ],
        });

        h.mergeMap = { "cust-old": "cust-new" }; // الدمج صار بعد البيع
        const { json } = await postSync({
            invoices: [
                voidInvoice({ offlineId: "v1", voids: "s1", customerId: "cust-old", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const voidRow = store.invoices.find((i) => i.offlineId === "v1");
        expect(voidRow.customerId).toBe("cust-new");
    });
});

describe("T4c — نسب العملية للمستخدم الصحيح (createdByUserId)", () => {
    it("مدير يزامن بيع كاشير: userId = الكاشير", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "s1", createdByUserId: "cashier1", items: [{ unitId: "P1-base", quantity: "1", price: PIECE_PRICE }] }),
            ],
        });
        expect(json.invoices[0].status).toBe("SYNCED");
        expect(store.invoices.find((i) => i.offlineId === "s1").userId).toBe("cashier1");
    });

    it("بدون createdByUserId: يُنسب لمستخدم الجلسة (السلوك القديم)", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };
        await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "1", price: PIECE_PRICE }] })],
        });
        expect(store.invoices.find((i) => i.offlineId === "s1").userId).toBe("cashier1");
    });

    it("جلسة كاشير تزامن عملية كاشير آخر → RETRY_LATER ولا يُكتب شيء", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };

        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "s1", createdByUserId: "cashier2", items: [{ unitId: "P1-base", quantity: "1", price: PIECE_PRICE }] }),
            ],
        });
        expect(json.invoices[0].status).toBe("RETRY_LATER");
        expect(store.invoices).toHaveLength(0);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("createdByUserId غير موجود بالمتجر → FAILED", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "s1", createdByUserId: "ghost", items: [{ unitId: "P1-base", quantity: "1", price: PIECE_PRICE }] }),
            ],
        });
        expect(json.invoices[0].status).toBe("FAILED");
    });

    it("منشئ معطّل (isActive=false) أو من متجر آخر → FAILED ولا يُكتب شيء", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "s-off", createdByUserId: "ex-cashier", items: [{ unitId: "P1-base", quantity: "1", price: PIECE_PRICE }] }),
                saleInvoice({ offlineId: "s-foreign", createdByUserId: "foreign-admin", items: [{ unitId: "P1-base", quantity: "1", price: PIECE_PRICE }] }),
            ],
        });
        const byId = Object.fromEntries(json.invoices.map((r: any) => [r.offlineId, r]));
        expect(byId["s-off"].status).toBe("FAILED");
        expect(byId["s-off"].error).toMatch(/غير موجود/);
        expect(byId["s-foreign"].status).toBe("FAILED");
        expect(store.invoices).toHaveLength(0);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("إلغاء أنشأه كاشير (يزامنه مدير) → FAILED: الدور يُؤخذ من قاعدة البيانات", async () => {
        seedBatch("A", "P1", "100", "2026-12-01");
        await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] })],
        });
        const { json } = await postSync({
            invoices: [
                voidInvoice({ offlineId: "v1", voids: "s1", createdByUserId: "cashier1", items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }] }),
            ],
        });
        expect(json.invoices[0].status).toBe("FAILED");
        expect(eq(qty("A"), "90")).toBe(true);
    });
});

describe("T4c — الدفعات (PASS 3)", () => {
    const payment = (o: Partial<{ offlineId: string; createdByUserId: string }> = {}) => ({
        offlineId: o.offlineId ?? "p1",
        customerId: "cust-old",
        amountSYP: "1000.0000",
        amountUSD: "7.4074",
        exchangeRate: "135",
        paymentMethod: "CASH",
        createdByUserId: o.createdByUserId,
        createdAt: new Date().toISOString(),
    });

    it("مدير: SYNCED وتُستدعى recordRepaymentIdempotent", async () => {
        const { json } = await postSync({ payments: [payment()] });
        expect(json.payments[0].status).toBe("SYNCED");
        expect(json.payments[0].realId).toBe("pay-1");
        expect(recordRepaymentIdempotent).toHaveBeenCalledTimes(1);
    });

    it("كاشير: FAILED ولا تُستدعى recordRepaymentIdempotent", async () => {
        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };
        const { json } = await postSync({ payments: [payment()] });
        expect(json.payments[0].status).toBe("FAILED");
        expect(json.payments[0].error).toMatch(/ADMIN/);
        expect(recordRepaymentIdempotent).not.toHaveBeenCalled();
    });

    it("دفعة أنشأها كاشير ويزامنها مدير → FAILED (دور المنشئ لا دور الجلسة)", async () => {
        const { json } = await postSync({ payments: [payment({ createdByUserId: "cashier1" })] });
        expect(json.payments[0].status).toBe("FAILED");
        expect(json.payments[0].error).toMatch(/ADMIN/);
        expect(recordRepaymentIdempotent).not.toHaveBeenCalled();
    });
});

describe("T4c — الحدود الخارجية", () => {
    it("بدون جلسة → 401", async () => {
        h.session = null;
        expect((await postSync({ invoices: [] })).status).toBe(401);
    });

    // [T6c] The old "اشتراك منتهي/معلّق → 403" test was removed on purpose:
    // /api/sync no longer rejects the whole request for a locked tenant (that
    // would lose pre-lock offline sales). The replacement coverage is the
    // "T6c/D10" describe below.

    it("JSON تالف → 400", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/sync", { method: "POST", body: "{not json" })
        );
        expect(res.status).toBe(400);
    });
});

describe("T4c — T6c/D10: قفل الاشتراك أثناء المزامنة (قرار لكل عنصر)", () => {
    const LOCK_AT = new Date("2026-06-01T00:00:00Z");
    const BEFORE = "2026-05-31T12:00:00Z";
    const AFTER = "2026-06-02T12:00:00Z";
    const LOCKED_MESSAGE = "انتهى الاشتراك قبل تسجيل هذه العملية";

    const lockedState = () => ({
        status: "EXPIRED",
        writable: false,
        lockAt: LOCK_AT,
        daysLeft: 0,
        graceDaysLeft: 0,
    });

    beforeEach(() => {
        seedBatch("A", "P1", "100", "2026-12-01");
    });

    const sale = (offlineId: string, createdAt: string) =>
        saleInvoice({
            offlineId,
            createdAt,
            items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }],
        });

    it("مقفول: عملية قبل lockAt تُعالج، وبعده FAILED بالرسالة العربية، ولا خصم للثانية", async () => {
        h.effective = lockedState();
        const { status, json } = await postSync({
            invoices: [sale("pre", BEFORE), sale("post", AFTER)],
        });

        expect(status).toBe(200); // لا 403 للطلب كله
        const byId = Object.fromEntries(json.invoices.map((r: any) => [r.offlineId, r]));
        expect(byId.pre.status).toBe("SYNCED");
        expect(byId.post.status).toBe("FAILED");
        expect(byId.post.error).toBe(LOCKED_MESSAGE);
        expect(eq(qty("A"), "90")).toBe(true); // خصم عملية "pre" فقط
        expect(store.invoices).toHaveLength(1);
    });

    it("العنصر عند lockAt بالضبط يُعالج (الحد شامل)", async () => {
        h.effective = lockedState();
        const { json } = await postSync({ invoices: [sale("edge", LOCK_AT.toISOString())] });
        expect(json.invoices[0].status).toBe("SYNCED");
    });

    it("PENDING (ما انفعّل أبداً): كل شي FAILED حتى لو قديم", async () => {
        h.effective = { status: "PENDING", writable: false, lockAt: null, daysLeft: 0, graceDaysLeft: 0 };
        const { json } = await postSync({ invoices: [sale("old", "2020-01-01T00:00:00Z")] });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toBe(LOCKED_MESSAGE);
        expect(store.invoices).toHaveLength(0);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("tenant غير موجود (effective = null): يُعامَل كـ PENDING ويرفض كل شي", async () => {
        h.effective = null;
        const { json } = await postSync({ invoices: [sale("x", BEFORE)] });
        expect(json.invoices[0].status).toBe("FAILED");
        expect(store.invoices).toHaveLength(0);
    });

    it("GRACE قابل للكتابة: يُعالج كالعادة بغض النظر عن التاريخ", async () => {
        h.effective = { status: "GRACE", writable: true, lockAt: LOCK_AT, daysLeft: 0, graceDaysLeft: 3 };
        const { json } = await postSync({ invoices: [sale("g1", AFTER)] });
        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "90")).toBe(true);
    });

    it("الإلغاء يتبع تاريخه هو لا تاريخ البيع الأصلي", async () => {
        // البيع الأصلي يتزامن والاشتراك فعّال
        await postSync({ invoices: [sale("s1", BEFORE)] });
        expect(eq(qty("A"), "90")).toBe(true);

        h.effective = lockedState();
        const v = voidInvoice({
            offlineId: "v1",
            voids: "s1",
            items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }],
        });
        const { json } = await postSync({ invoices: [{ ...v, createdAt: AFTER }] });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toBe(LOCKED_MESSAGE);
        expect(eq(qty("A"), "90")).toBe(true); // ما رجع المخزون
    });

    it("إلغاء بتاريخ قبل lockAt لبيع قبل lockAt: يُعالج حتى والاشتراك مقفول", async () => {
        await postSync({ invoices: [sale("s1", BEFORE)] });

        h.effective = lockedState();
        const v = voidInvoice({
            offlineId: "v1",
            voids: "s1",
            items: [{ unitId: "P1-base", quantity: "10", price: PIECE_PRICE }],
        });
        const { json } = await postSync({
            invoices: [{ ...v, createdAt: "2026-05-31T18:00:00Z" }],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("الدفعات تتبع نفس القاعدة", async () => {
        h.effective = lockedState();
        const { json } = await postSync({
            payments: [
                {
                    offlineId: "p1",
                    customerId: "cust-old",
                    amountSYP: "1000.0000",
                    exchangeRate: null,
                    paymentMethod: "CASH",
                    createdAt: AFTER,
                },
            ],
        });
        expect(json.payments[0].status).toBe("FAILED");
        expect(json.payments[0].error).toBe(LOCKED_MESSAGE);
        expect(recordRepaymentIdempotent).not.toHaveBeenCalled();
    });

    it("زبون جديد بعد القفل يُرفض، وقبله يُنشأ", async () => {
        h.effective = lockedState();
        const { json } = await postSync({
            customers: [
                { offlineId: "c-pre", name: "زبون قبل", createdAt: BEFORE },
                { offlineId: "c-post", name: "زبون بعد", createdAt: AFTER },
            ],
        });
        const byId = Object.fromEntries(json.customers.map((r: any) => [r.offlineId, r.status]));
        expect(byId["c-pre"]).toBe("SYNCED");
        expect(byId["c-post"]).toBe("FAILED");
    });

    it("الراوت لا يستدعي assertTenantWritable (حتى لا يضيّع مبيعات ما قبل القفل)", async () => {
        h.effective = lockedState();
        await postSync({ invoices: [] });
        expect(assertTenantWritable).not.toHaveBeenCalled();
    });
    it("مقفول بلا lockAt (EXPIRED بدون expiresAt): يرفض الكل (fail-closed)", async () => {
        h.effective = { status: "EXPIRED", writable: false, lockAt: null, daysLeft: 0, graceDaysLeft: 0 };
        const { json } = await postSync({ invoices: [sale("x", BEFORE)] });
        expect(json.invoices[0].status).toBe("FAILED");
        expect(store.invoices).toHaveLength(0);
    });
});

describe("T4c — سعر الصرف المجمّد و USD الاختياري (v4.9)", () => {
    const sale = (o: { offlineId: string; rate?: string | null }) =>
        saleInvoice({
            offlineId: o.offlineId,
            rate: o.rate,
            items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }],
        });

    beforeEach(() => {
        seedBatch("A", "P1", "100", "2026-12-01");
    });

    it("بيع بدون سعر صرف: يُحفظ بلا USD ولا سعر، ولا يُقرأ سعر المتجر الحالي، ولا يفشل", async () => {
        const { json } = await postSync({ invoices: [sale({ offlineId: "s1", rate: null })] });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(inv.exchangeRateUsed).toBeNull();
        expect(inv.totalUSD).toBeNull();
        expect(inv.paidAmountUSD).toBeNull();
        expect(inv.debtAmountUSD).toBeNull();
        expect(itemsOf(inv.id).every((i) => i.unitPriceUSD === null)).toBe(true);
        expect(h.events).not.toContain("tenant-lookup");
    });

    it("سعر صفر أو سالب بالـ payload يُخزَّن NULL (لا 0 ولا 1)", async () => {
        await postSync({ invoices: [sale({ offlineId: "s0", rate: "0" })] });
        const inv = store.invoices.find((i) => i.offlineId === "s0");
        expect(inv.exchangeRateUsed).toBeNull();
        expect(inv.totalUSD).toBeNull();
    });

    it("بيع بسعر صرف: يُجمَّد السعر وتُشتق USD منه", async () => {
        await postSync({ invoices: [sale({ offlineId: "s1", rate: "135" })] });
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(eq(inv.exchangeRateUsed, "135")).toBe(true);
        expect(new Decimal(inv.totalUSD).toFixed(2)).toBe("177.78"); // 24000 / 135
        expect(itemsOf(inv.id)[0].unitPriceUSD).not.toBeNull();
    });

    it("الإلغاء ينسخ سعر الأصل ويعكس USD، ويتجاهل سعر الـ payload", async () => {
        await postSync({ invoices: [sale({ offlineId: "s1", rate: "135" })] });
        await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    rate: "999", // سعر مختلف بالـ payload — يجب تجاهله
                    items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }],
                }),
            ],
        });

        const original = store.invoices.find((i) => i.offlineId === "s1");
        const voided = store.invoices.find((i) => i.offlineId === "v1");
        expect(voided).toBeDefined();
        expect(voided.exchangeRateUsed).toBe(original.exchangeRateUsed);
        expect(new Decimal(voided.totalUSD).eq(new Decimal(original.totalUSD).negated())).toBe(true);
        expect(new Decimal(voided.paidAmountUSD).eq(new Decimal(original.paidAmountUSD).negated())).toBe(true);
        // مجموع الأصل + الإلغاء = صفر بالـ USD
        expect(new Decimal(original.totalUSD).plus(voided.totalUSD).isZero()).toBe(true);
    });

    it("إلغاء فاتورة بلا سعر: يبقى بلا سعر وبلا USD حتى لو الـ payload فيه سعر", async () => {
        await postSync({ invoices: [sale({ offlineId: "s1", rate: null })] });
        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    rate: "135",
                    items: [{ unitId: "P1-pack", quantity: "1", price: PACK_PRICE }],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const voided = store.invoices.find((i) => i.offlineId === "v1");
        expect(voided.exchangeRateUsed).toBeNull();
        expect(voided.totalUSD).toBeNull();
        expect(voided.paidAmountUSD).toBeNull();
        expect(voided.debtAmountUSD).toBeNull();
        expect(itemsOf(voided.id).every((i) => i.unitPriceUSD === null)).toBe(true);
        expect(h.events).not.toContain("tenant-lookup");
    });
});

describe("T4c — تحقق لكل عنصر بدل رفض الطلب كله (v4.9)", () => {
    beforeEach(() => {
        seedBatch("A", "P1", "100", "2026-12-01");
    });

    const piece = (offlineId: string, q = "10", extra: Record<string, unknown> = {}) =>
        Object.assign(
            saleInvoice({ offlineId, items: [{ unitId: "P1-base", quantity: q, price: PIECE_PRICE }] }),
            extra
        ) as any;

    it("createdAt غير صالح: FAILED لهذا العنصر فقط (لا 400) والباقي يُزامَن", async () => {
        const { status, json } = await postSync({
            invoices: [piece("bad", "10", { createdAt: "abc" }), piece("good", "10")],
        });

        expect(status).toBe(200);
        const byId = Object.fromEntries(json.invoices.map((r: any) => [r.offlineId, r]));
        expect(byId.bad.status).toBe("FAILED");
        expect(byId.good.status).toBe("SYNCED");
        expect(eq(qty("A"), "90")).toBe(true); // خُصمت مرة وحدة فقط
    });

    it("مفاتيح USD/السعر غائبة بالـ payload تُقرأ كـ null (لا 400)", async () => {
        const inv = piece("s1", "10");
        delete inv.totalUSD;
        delete inv.paidAmountUSD;
        delete inv.debtAmountUSD;
        delete inv.exchangeRateUsed;
        delete inv.items[0].unitPriceUSD;

        const { status, json } = await postSync({ invoices: [inv] });
        expect(status).toBe(200);
        expect(json.invoices[0].status).toBe("SYNCED");
        const row = store.invoices.find((i) => i.offlineId === "s1");
        expect(row.exchangeRateUsed).toBeNull();
        expect(row.totalUSD).toBeNull();
    });

    it("دفعة بلا سعر صرف: تُقبل ويُمرَّر frozenRate = null", async () => {
        const { status, json } = await postSync({
            payments: [
                {
                    offlineId: "p1",
                    customerId: "cust-old",
                    amountSYP: "1000.0000",
                    // amountUSD مفقود، exchangeRate = null
                    exchangeRate: null,
                    paymentMethod: "CASH",
                    createdAt: new Date().toISOString(),
                },
            ],
        });
        expect(status).toBe(200);
        expect(json.payments[0].status).toBe("SYNCED");
        const params = vi.mocked(recordRepaymentIdempotent).mock.calls[0][2] as any;
        expect(params.frozenRate).toBeNull();
    });

    it("خطأ بيانات رسالته فيها رقم 140001 يبقى FAILED (لا RETRY_LATER)", async () => {
        const inv = piece("s1", "1");
        inv.totalSYP = "140001.0000";
        inv.paidAmountSYP = "140001.0000"; // الدين 0 → يمرّ فحص الدين ويفشل فحص مجموع البنود
        const { json } = await postSync({ invoices: [inv] });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toMatch(/140001/);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("بيع بمبلغ مدفوع سالب → FAILED ولا يتغير المخزون", async () => {
        const inv = piece("s1", "1");
        inv.paidAmountSYP = "-500.0000";
        inv.debtAmountSYP = "1500.0000"; // total(1000) - paid(-500)
        const { json } = await postSync({ invoices: [inv] });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("paymentMethod ناقص مع مدفوع > 0: FAILED لهذه الفاتورة فقط وتُرجَع كمية مخزونها", async () => {
        const bad = piece("s_bad", "10");
        delete bad.paymentMethod;

        const { status, json } = await postSync({ invoices: [bad, piece("s_ok", "10")] });

        expect(status).toBe(200);
        const byId = Object.fromEntries(json.invoices.map((r: any) => [r.offlineId, r.status]));
        expect(byId.s_bad).toBe("FAILED");
        expect(byId.s_ok).toBe("SYNCED");
        expect(eq(qty("A"), "90")).toBe(true); // فقط خصم s_ok (rollback للأولى)
        expect(store.invoices).toHaveLength(1);
    });

    it("إلغاء ببنود مكررة لنفس المنتج/الوحدة (4 + 6) يُدمج ويُقبل", async () => {
        await postSync({ invoices: [piece("s1", "10")] });
        expect(eq(qty("A"), "90")).toBe(true);

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [
                        { unitId: "P1-base", quantity: "4", price: PIECE_PRICE },
                        { unitId: "P1-base", quantity: "6", price: PIECE_PRICE },
                    ],
                }),
            ],
        });
        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("إلغاء [P1, P1] مقابل فاتورة أصلية {P1, P2} → FAILED (لا استرجاع مزدوج)", async () => {
        seedBatch("C", "P2", "10", "2026-12-01");
        await postSync({
            invoices: [
                saleInvoice({
                    offlineId: "s1",
                    items: [
                        { productId: "P1", unitId: "P1-base", quantity: "1", price: PIECE_PRICE },
                        { productId: "P2", unitId: "P2-base", quantity: "1", price: PIECE_PRICE },
                    ],
                }),
            ],
        });
        const before = [qty("A"), qty("C")];

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [
                        { productId: "P1", unitId: "P1-base", quantity: "1", price: PIECE_PRICE },
                        { productId: "P1", unitId: "P1-base", quantity: "1", price: PIECE_PRICE },
                    ],
                }),
            ],
        });
        expect(json.invoices[0].status).toBe("FAILED");
        // الدمج بنفس السعر يعطي مجموعة وحدة مقابل مجموعتين أصليتين
        expect(json.invoices[0].error).toMatch(/عدد/);
        expect([qty("A"), qty("C")]).toEqual(before);
    });
});

describe("T4c — batch-locking.ts و fifo.ts", () => {
    it("commitFifoAllocation بدون params يرمي خطأ (لا يرجّع undefined بصمت)", async () => {
        await expect(commitFifoAllocation({} as any, undefined as any)).rejects.toThrow();
    });
});

describe("T4c — فحوصات ساكنة على الشيفرة (static source scans)", () => {
    const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), "utf8");
    // يحذف التعليقات حتى لا تُحسب الكلمات داخلها
    const code = (rel: string) =>
        read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    it("sync route: لا z.coerce.number ولا Math.abs ولا toString() على requestedQty", () => {
        const src = code("app/api/sync/route.ts");
        expect(src).not.toMatch(/z\.coerce\.number/);
        expect(src).not.toMatch(/Math\.abs\(/);
        expect(src).not.toMatch(/requestedQty:\s*[A-Za-z.]+\.toString\(\)/);
    });

    it("sync route: الخصم (decrement) واحد ويسبق إنشاء الفاتورة (داخل حلقة البنود)", () => {
        const src = code("app/api/sync/route.ts");
        expect(src.match(/decrement:/g)).toHaveLength(1);
        expect(src.indexOf("decrement:")).toBeLessThan(src.indexOf("status: InvoiceStatus.COMPLETED"));
    });

    it("sync route: يكتب baseQuantity للبيع والإلغاء ولا يعيد تحويل quantity", () => {
        const src = code("app/api/sync/route.ts");
        expect((src.match(/baseQuantity:/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(src).not.toMatch(/qtyToRestore\s*=\s*toBaseUnit/);
    });

    it("voids route: لا toBaseUnit ولا getUnitConversionFactor، ويعتمد baseQuantity", () => {
        const src = code("app/api/ledger/voids/route.ts");
        expect(src).not.toMatch(/toBaseUnit|getUnitConversionFactor/);
        expect(src).toMatch(/item\.baseQuantity/);
    });

    it("fifo.ts: لا حارس `if (!params)` ولا أي إشارة إلى conversionFactor", () => {
        const src = code("lib/inventory/fifo.ts");
        expect(src).not.toMatch(/if\s*\(\s*!params\s*\)/);
        expect(src).not.toMatch(/conversionFactor/);
    });

    it("batch-locking.ts: بدون فلتر كمية وبدون قراءة سابقة غير مقفولة", () => {
        const src = code("lib/inventory/batch-locking.ts");
        expect(src).not.toMatch(/findMany/);
        expect(src).not.toMatch(/quantity:\s*\{\s*gt/);
        expect(src).not.toMatch(/Number\(/);
        expect(src).toMatch(/ORDER BY id ASC/);
    });

    it("sync route: لا dailyExchangeRate ولا convertCurrency (لا استبدال سعر، USD عبر deriveUsd فقط)", () => {
        const src = code("app/api/sync/route.ts");
        expect(src).not.toMatch(/dailyExchangeRate/);
        expect(src).not.toMatch(/convertCurrency/);
        expect(src).toMatch(/deriveUsd/);
    });

    it("voids route: لا .toString() مباشر على حقول USD القابلة للـ null", () => {
        const src = code("app/api/ledger/voids/route.ts");
        expect(src).not.toMatch(/originalInvoice\.(totalUSD|paidAmountUSD|debtAmountUSD)\.toString/);
        expect(src).toMatch(/negateNullableMoney/);
    });

    it("sync route: كل الكتابات استدعاءات top-level (لا nested writes)", () => {
        const src = code("app/api/sync/route.ts");
        expect(src).not.toMatch(/\b(create|connect|connectOrCreate)\s*:\s*\{/);
    });

    it("sync route (T6c): يقرأ الحالة عبر getFreshEffectiveStatus ولا يقارن subscriptionStatus/expiresAt مباشرة", () => {
        const src = code("app/api/sync/route.ts");
        expect(src).toMatch(/getFreshEffectiveStatus/);
        expect(src).not.toMatch(/\.subscriptionStatus/);
        expect(src).not.toMatch(/\.expiresAt/);
        expect(src).not.toMatch(/assertTenantWritable\(/);
    });
});


// ----------------------------------------------------------------------------
// By-amount sales (بيع بالمبلغ): 0.3333 kg @ 15,000 = 4,999.5, but the customer
// paid 5,000. The invoice total is the typed amount; the shared tolerance
// (half a quantity step x price, summed per line) accepts it, nothing more.
// ----------------------------------------------------------------------------
describe("T4c — البيع بالمبلغ (تسامح التقريب)", () => {
    const KG_PRICE = "15000";

    function byAmountSale(offlineId: string, total = "5000.0000", lines = 1) {
        const inv = saleInvoice({
            offlineId,
            items: Array.from({ length: lines }, () => ({
                unitId: "P1-base",
                quantity: "0.3333",
                price: KG_PRICE,
            })),
        });
        inv.totalSYP = total;
        inv.paidAmountSYP = total;
        inv.debtAmountSYP = "0.0000";
        return inv;
    }

    function byAmountVoid(offlineId: string, voids: string, total = "5000.0000") {
        const v = voidInvoice({
            offlineId,
            voids,
            items: [{ unitId: "P1-base", quantity: "0.3333", price: KG_PRICE }],
        });
        v.totalSYP = `-${total}`;
        v.paidAmountSYP = `-${total}`;
        v.debtAmountSYP = "0.0000";
        return v;
    }

    it("0.3333 كغ @ 15000 بإجمالي 5000 → SYNCED، المخزّن 5000 والخصم والتكلفة دقيقان", async () => {
        seedBatch("A", "P1", "10", "2026-12-01", "10");

        const { json } = await postSync({ invoices: [byAmountSale("s1")] });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(eq(inv.totalSYP, "5000")).toBe(true);
        expect(eq(inv.debtAmountSYP, "0")).toBe(true);

        const items = itemsOf(inv.id);
        expect(items).toHaveLength(1);
        expect(eq(items[0].baseQuantity, "0.3333")).toBe(true);
        expect(eq(items[0].costAmountSYP, "3.333")).toBe(true); // 0.3333 x 10
        expect(eq(qty("A"), "9.6667")).toBe(true);
    });

    it("إجمالي مزوّر (4000 أو 5001) لنفس الكمية → FAILED والمخزون ما يتغير", async () => {
        seedBatch("A", "P1", "10", "2026-12-01");

        const low = await postSync({ invoices: [byAmountSale("s1", "4000.0000")] });
        const high = await postSync({ invoices: [byAmountSale("s2", "5001.0000")] });

        expect(low.json.invoices[0].status).toBe("FAILED");
        expect(high.json.invoices[0].status).toBe("FAILED");
        expect(store.invoices).toHaveLength(0);
        expect(eq(qty("A"), "10")).toBe(true);
    });

    it("حدّ التسامح شامل: فرق 0.75 مقبول وفرق أكبر منه بخطوة 4 خانات مرفوض", async () => {
        seedBatch("A", "P1", "10", "2026-12-01");
        // expected = 4999.5, tolerance = 0.75
        const atEdge = await postSync({ invoices: [byAmountSale("edge", "5000.2500")] });
        const beyond = await postSync({ invoices: [byAmountSale("over", "5000.2501")] });

        expect(atEdge.json.invoices[0].status).toBe("SYNCED");
        expect(beyond.json.invoices[0].status).toBe("FAILED");
    });

    it("سطران: التسامح هو المجموع (1.5) لا تسامح الفاتورة الواحدة", async () => {
        seedBatch("A", "P1", "10", "2026-12-01");
        // expected = 9999.0 ; tolerance = 2 x 0.75 = 1.5
        const ok = await postSync({ invoices: [byAmountSale("two-ok", "10000.0000", 2)] }); // diff 1.0
        const bad = await postSync({ invoices: [byAmountSale("two-bad", "10001.0000", 2)] }); // diff 2.0

        expect(ok.json.invoices[0].status).toBe("SYNCED");
        expect(bad.json.invoices[0].status).toBe("FAILED");
    });

    it("بيع بالمبلغ موزّع على دفعتين: مجموع baseQuantity = 0.3333 بالضبط والإجمالي 5000", async () => {
        seedBatch("A", "P1", "0.2", "2026-12-01");
        seedBatch("B", "P1", "10", "2027-06-01");

        const { json } = await postSync({ invoices: [byAmountSale("s1")] });

        expect(json.invoices[0].status).toBe("SYNCED");
        const items = itemsOf(json.invoices[0].realId);
        expect(items).toHaveLength(2);
        const sum = items.reduce((s, i) => s.plus(i.baseQuantity), new Decimal(0));
        expect(sum.eq("0.3333")).toBe(true);
        expect(eq(qty("A"), "0")).toBe(true);
        expect(eq(qty("B"), "9.8667")).toBe(true);
        expect(eq(store.invoices[0].totalSYP, "5000")).toBe(true);
    });

    it("إلغاء بيع بالمبلغ عبر الـ sync: SYNCED، الأصل + الإلغاء = 0 للإجمالي/المدفوع/الدين/التكلفة، والمخزون يرجع كما كان", async () => {
        seedBatch("A", "P1", "10", "2026-12-01", "10");
        await postSync({ invoices: [byAmountSale("s1")] });
        expect(eq(qty("A"), "9.6667")).toBe(true);

        const { json } = await postSync({ invoices: [byAmountVoid("v1", "s1")] });

        expect(json.invoices[0].status).toBe("SYNCED");
        const original = store.invoices.find((i) => i.offlineId === "s1");
        const voided = store.invoices.find((i) => i.offlineId === "v1");
        for (const f of ["totalSYP", "paidAmountSYP", "debtAmountSYP"] as const) {
            expect(new Decimal(original[f]).plus(voided[f]).isZero()).toBe(true);
        }
        const costSum = [...itemsOf(original.id), ...itemsOf(voided.id)].reduce(
            (s, i) => s.plus(i.costAmountSYP),
            new Decimal(0)
        );
        const baseSum = [...itemsOf(original.id), ...itemsOf(voided.id)].reduce(
            (s, i) => s.plus(i.baseQuantity),
            new Decimal(0)
        );
        expect(costSum.isZero()).toBe(true);
        expect(baseSum.isZero()).toBe(true);
        expect(eq(qty("A"), "10")).toBe(true); // لا 10.0001 ولا 9.9999
    });

    it("إلغاء بإجمالي مزوّر لبيع بالمبلغ (غير سالب الأصل) → FAILED والمخزون ما يرجع", async () => {
        seedBatch("A", "P1", "10", "2026-12-01");
        await postSync({ invoices: [byAmountSale("s1")] });

        const { json } = await postSync({ invoices: [byAmountVoid("v1", "s1", "4999.5000")] });

        expect(json.invoices[0].status).toBe("FAILED"); // الفحص الدقيق مقابل الأصل المخزّن
        expect(eq(qty("A"), "9.6667")).toBe(true);
    });
});

describe("T4c — فحوصات ساكنة للتسامح (تعريف واحد)", () => {
    const strip = (rel: string) =>
        readFileSync(path.resolve(process.cwd(), rel), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");

    it("الثابت 0.00005 معرّف مرة وحدة بـ money.ts ولا يظهر بأي ملف تاني", () => {
        expect((strip("lib/utils/money.ts").match(/0\.00005/g) ?? []).length).toBe(1);
        for (const rel of [
            "app/api/sync/route.ts",
            "app/api/ledger/voids/route.ts",
            "lib/offline/db.ts",
            "lib/offline/pos-service.ts",
        ]) {
            expect(strip(rel), rel).not.toMatch(/0\.00005/);
        }
    });

    it("لا مقارنة دقيقة بين مجموع البنود والإجمالي بمسار الـ sync", () => {
        const src = strip("app/api/sync/route.ts");
        expect(src).not.toMatch(/compareMoney\(\s*expectedTotalSYP\s*,\s*totalSYP\s*\)/);
        expect(src).toMatch(/isTotalWithinTolerance\(\s*expectedTotalSYP/);
    });

    it("فحوصات الإلغاء المقابلة للأصل المخزّن تبقى دقيقة (لا تسامح)", () => {
        const src = strip("app/api/sync/route.ts");
        expect(src).toMatch(/compareMoney\(totalSYP, expectedVoidTotalSYP\) !== 0/);
        expect(src).toMatch(/compareMoney\(paidSYP, expectedVoidPaidSYP\) !== 0/);
        expect(src).toMatch(/compareMoney\(debtSYP, expectedVoidDebtSYP\) !== 0/);
    });
});

// ============================================================================
// [v6.2] SALE-TIME PRICE OVERRIDE — gate + storage
//
// "Effective override" = the line carries listUnitPriceSYP AND it differs
// (numerically) from the final unitPriceSYP. Only an ADMIN author (looked up in
// the DATABASE) may sync such an invoice; the catalog price is stored only for
// effective overrides; Invoice.hasPriceOverride mirrors "any stored line has
// it". Catalog price: 1000 per piece, cost 10 per piece throughout.
// ============================================================================
describe("T4c — v6.2: تعديل سعر البيع (بوابة ADMIN والتخزين)", () => {
    const seedA = () => seedBatch("A", "P1", "100", "2026-12-01", "10");
    const line = (price: string, list?: string | null, q = "10"): LineIn => ({
        unitId: "P1-base",
        quantity: q,
        price,
        list,
    });

    it("ADMIN: سعر أقل من الكتالوج (900 مقابل 1000) يُخزَّن، و hasPriceOverride = true", async () => {
        seedA();
        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [line("900", "1000")] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(inv.hasPriceOverride).toBe(true);
        expect(eq(inv.totalSYP, "9000")).toBe(true);
        const [item] = itemsOf(inv.id);
        expect(eq(item.unitPriceSYP, "900")).toBe(true); // السعر النهائي هو المعتمد
        expect(eq(item.listUnitPriceSYP, "1000")).toBe(true); // لقطة الكتالوج
        expect(eq(qty("A"), "90")).toBe(true);
    });

    it("ADMIN: سعر أعلى من الكتالوج (زيادة) يُقبل أيضاً ويُعلَّم override", async () => {
        seedA();
        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [line("1200", "1000")] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(inv.hasPriceOverride).toBe(true);
        expect(eq(itemsOf(inv.id)[0].listUnitPriceSYP as string, "1000")).toBe(true);
    });

    it("list يساوي السعر النهائي (بصيغ مختلفة أو بغياب المفتاح) ليس override: null/false", async () => {
        seedA();
        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "same-fmt", items: [line("1000", "1000.0000", "1")] }),
                saleInvoice({ offlineId: "no-key", items: [line("1000", undefined, "1")] }),
                saleInvoice({ offlineId: "null-key", items: [line("1000", null, "1")] }),
            ],
        });

        expect(json.invoices.map((r: any) => r.status)).toEqual(["SYNCED", "SYNCED", "SYNCED"]);
        for (const id of ["same-fmt", "no-key", "null-key"]) {
            const inv = store.invoices.find((i) => i.offlineId === id);
            expect(inv.hasPriceOverride, id).toBe(false);
            expect(itemsOf(inv.id).every((i) => i.listUnitPriceSYP === null), id).toBe(true);
        }
    });

    it("كاشير بتعديل سعر فعلي → FAILED برسالة ADMIN ولا يُكتب شيء ولا يُخصم مخزون", async () => {
        seedA();
        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };

        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [line("900", "1000")] })],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toMatch(/ADMIN/);
        expect(store.invoices).toHaveLength(0);
        expect(store.invoiceItems).toHaveLength(0);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("كاشير: list = السعر النهائي بصيغتين مختلفتين ليس override فيمرّ ويُخزَّن null", async () => {
        seedA();
        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };

        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [line("1000", "1000.0000")] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(inv.userId).toBe("cashier1");
        expect(inv.hasPriceOverride).toBe(false);
        expect(itemsOf(inv.id)[0].listUnitPriceSYP).toBeNull();
    });

    it("مدير يزامن فاتورة كاشير فيها override → FAILED: الدور من قاعدة البيانات لا من الجلسة", async () => {
        seedA();
        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "s1", createdByUserId: "cashier1", items: [line("900", "1000")] }),
            ],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toMatch(/ADMIN/);
        expect(store.invoices).toHaveLength(0);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("كاشير يزامن فاتورة مدير فيها override → RETRY_LATER (لا يُكتب شيء، وتتزامن مع جلسة المدير)", async () => {
        seedA();
        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };
        const body = {
            invoices: [
                saleInvoice({ offlineId: "s1", createdByUserId: "admin1", items: [line("900", "1000")] }),
            ],
        };

        const deferred = await postSync(body);
        expect(deferred.json.invoices[0].status).toBe("RETRY_LATER");
        expect(store.invoices).toHaveLength(0);

        h.session = { user: { id: "admin1", tenantId: "t1", role: "ADMIN" } };
        const retried = await postSync(body);
        expect(retried.json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(inv.userId).toBe("admin1");
        expect(inv.hasPriceOverride).toBe(true);
    });

    it("فاتورة بسطرين: سطر معدّل وسطر عادي → list فقط على المعدّل و hasPriceOverride = true", async () => {
        seedA();
        seedBatch("C", "P2", "10", "2026-12-01", "10");

        const { json } = await postSync({
            invoices: [
                saleInvoice({
                    offlineId: "s1",
                    items: [
                        { productId: "P1", unitId: "P1-base", quantity: "2", price: "900", list: "1000" },
                        { productId: "P2", unitId: "P2-base", quantity: "1", price: "1000" },
                    ],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(inv.hasPriceOverride).toBe(true);
        const rows = itemsOf(inv.id);
        const p1 = rows.find((r) => r.productId === "P1");
        const p2 = rows.find((r) => r.productId === "P2");
        expect(eq(p1.listUnitPriceSYP, "1000")).toBe(true);
        expect(p2.listUnitPriceSYP).toBeNull();
    });

    it("سطر معدّل موزّع FIFO على دفعتين: الصفّان يحملان نفس السعر النهائي ونفس سعر الكتالوج", async () => {
        seedBatch("A", "P1", "20", "2026-12-01", "10");
        seedBatch("B", "P1", "100", "2027-06-01", "10");

        const { json } = await postSync({
            invoices: [
                saleInvoice({
                    offlineId: "s1",
                    items: [{ unitId: "P1-pack", quantity: "1", price: "20000", list: "24000" }],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(eq(inv.totalSYP, "20000")).toBe(true);
        const rows = itemsOf(inv.id);
        expect(rows).toHaveLength(2);
        for (const r of rows) {
            expect(eq(r.unitPriceSYP, "20000")).toBe(true);
            expect(eq(r.listUnitPriceSYP, "24000")).toBe(true);
        }
        expect(rows.reduce((s, r) => s.plus(r.baseQuantity), new Decimal(0)).eq(24)).toBe(true);
    });

    it("سعر نهائي صفر مسموح (هدية) والتكلفة تبقى مسجلة", async () => {
        seedA();
        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s0", items: [line("0", "1000")] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s0");
        expect(eq(inv.totalSYP, "0")).toBe(true);
        expect(inv.hasPriceOverride).toBe(true);
        const [item] = itemsOf(inv.id);
        expect(eq(item.unitPriceSYP, "0")).toBe(true);
        expect(eq(item.costAmountSYP, "100")).toBe(true); // 10 قطع x 10
        expect(store.payments).toHaveLength(0); // لا مدفوع → لا دفعة
    });

    it("سعر نهائي سالب → FAILED ولا يتغير المخزون", async () => {
        seedA();
        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [line("-100", "1000")] })],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(store.invoices).toHaveLength(0);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("سعر كتالوج سالب (من مدير) → FAILED برسالة الكتالوج ولا يتغير شيء", async () => {
        seedA();
        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [line("900", "-1000")] })],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toMatch(/الكتالوج/);
        expect(store.invoices).toHaveLength(0);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("سعر كتالوج غير صالح ('abc') → FAILED لهذه الفاتورة فقط والباقي يُزامَن", async () => {
        seedA();
        const { status, json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "s_bad", items: [line("900", "abc")] }),
                saleInvoice({ offlineId: "s_ok", items: [line("1000", undefined)] }),
            ],
        });

        expect(status).toBe(200);
        const byId = Object.fromEntries(json.invoices.map((r: any) => [r.offlineId, r.status]));
        expect(byId.s_bad).toBe("FAILED");
        expect(byId.s_ok).toBe("SYNCED");
        expect(eq(qty("A"), "90")).toBe(true); // خصم s_ok فقط
        expect(store.invoices).toHaveLength(1);
    });

    it("التكلفة المجمّدة لا تتأثر بالسعر: الربح = الإجمالي − Σ التكلفة يتغير بالسعر فقط", async () => {
        seedA();
        const { json } = await postSync({
            invoices: [
                saleInvoice({ offlineId: "plain", items: [line("1000", undefined)] }),
                saleInvoice({ offlineId: "disc", items: [line("900", "1000")] }),
            ],
        });
        expect(json.invoices.map((r: any) => r.status)).toEqual(["SYNCED", "SYNCED"]);

        const profit = (offlineId: string) => {
            const inv = store.invoices.find((i) => i.offlineId === offlineId);
            const cost = itemsOf(inv.id).reduce((s, i) => s.plus(i.costAmountSYP), new Decimal(0));
            return { cost, profit: new Decimal(inv.totalSYP).minus(cost) };
        };
        expect(profit("plain").cost.eq(100)).toBe(true);
        expect(profit("disc").cost.eq(100)).toBe(true); // نفس التكلفة
        expect(profit("plain").profit.eq(9900)).toBe(true);
        expect(profit("disc").profit.eq(8900)).toBe(true);
    });

    // CHARACTERIZATION TEST — documents an ACCEPTED limit (decision 2026-10-30),
    // it is not a bug report: the server never knows which catalog price the
    // device showed, so it only gates DECLARED overrides. Re-deriving the price
    // or rejecting a mismatch with the CURRENT catalog would drop real sales
    // whenever the catalog changed between the sale and the sync. If this test
    // ever fails because someone made the server reject such a sale, that is a
    // deliberate product decision to revisit, not a regression to patch around.
    it("حد معروف: سعر أقل بدون إعلان override يُقبل كبيع عادي (السيرفر لا يعرف سعر الكتالوج)", async () => {
        seedA();
        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };

        const { json } = await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [line("500", null)] })],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const inv = store.invoices.find((i) => i.offlineId === "s1");
        expect(inv.hasPriceOverride).toBe(false);
        expect(itemsOf(inv.id)[0].listUnitPriceSYP).toBeNull();
        expect(eq(inv.totalSYP, "5000")).toBe(true);
    });
});

// ============================================================================
// [v6.2] OFFLINE VOID OF AN INVOICE THAT SOLD THE SAME PRODUCT/UNIT AT SEVERAL
// PRICES. The void path groups by productId::unitId::PRICE (numeric price
// match). The client's void payload must list one line per price group.
//
// Fixture: P1 piece sold as 5 @ 1000 (catalog) + 3 @ 800 (list 1000) = 7400.
// ============================================================================
describe("T4c — v6.2: إلغاء أوفلاين لفاتورة فيها أكثر من سعر لنفس المنتج/الوحدة", () => {
    const seedA = () => seedBatch("A", "P1", "100", "2026-12-01", "10");

    const mixedSale = (offlineId = "s1") =>
        saleInvoice({
            offlineId,
            items: [
                { unitId: "P1-base", quantity: "5", price: "1000" },
                { unitId: "P1-base", quantity: "3", price: "800", list: "1000" },
            ],
        });

    async function syncMixedSale(): Promise<string> {
        const r = await postSync({ invoices: [mixedSale()] });
        expect(r.json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "92")).toBe(true);
        return r.json.invoices[0].realId as string;
    }

    it("إلغاء كامل بسطرين (5 @ 1000 و 3 @ 800) → SYNCED والمخزون يرجع 100 والمجموع صفر", async () => {
        seedA();
        const saleId = await syncMixedSale();

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [
                        { unitId: "P1-base", quantity: "5", price: "1000" },
                        { unitId: "P1-base", quantity: "3", price: "800" },
                    ],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "100")).toBe(true);

        const original = store.invoices.find((i) => i.id === saleId);
        const voided = store.invoices.find((i) => i.offlineId === "v1");
        expect(voided.hasPriceOverride).toBe(true); // منسوخ من الأصل
        expect(new Decimal(original.totalSYP).plus(voided.totalSYP).isZero()).toBe(true);
        expect(new Decimal(original.totalUSD).plus(voided.totalUSD).isZero()).toBe(true);

        const voidRows = itemsOf(voided.id);
        expect(voidRows).toHaveLength(2);
        const five = voidRows.find((r) => eq(r.baseQuantity, "-5"));
        const three = voidRows.find((r) => eq(r.baseQuantity, "-3"));
        // الأسعار تُنسخ كما هي (موجبة) ولقطة الكتالوج تُنسخ من السطر الأصلي
        expect(eq(five.unitPriceSYP, "1000")).toBe(true);
        expect(five.listUnitPriceSYP).toBeNull();
        expect(eq(three.unitPriceSYP, "800")).toBe(true);
        expect(eq(three.listUnitPriceSYP, "1000")).toBe(true);

        const all = [...itemsOf(original.id), ...voidRows];
        expect(all.reduce((s, i) => s.plus(i.baseQuantity), new Decimal(0)).isZero()).toBe(true);
        expect(all.reduce((s, i) => s.plus(i.costAmountSYP), new Decimal(0)).isZero()).toBe(true);
    });

    it("الإلغاء يتجاهل listUnitPriceSYP القادم بالـ payload (يُنسخ من الأصل فقط)", async () => {
        seedA();
        await postSync({
            invoices: [saleInvoice({ offlineId: "s1", items: [{ unitId: "P1-base", quantity: "10", price: "1000" }] })],
        });

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [{ unitId: "P1-base", quantity: "10", price: "1000", list: "999" }],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        const voided = store.invoices.find((i) => i.offlineId === "v1");
        expect(voided.hasPriceOverride).toBe(false);
        expect(itemsOf(voided.id).every((i) => i.listUnitPriceSYP === null)).toBe(true);
    });

    it("أسعار مبدّلة بين المجموعتين (5 @ 800 و 3 @ 1000) → FAILED والمخزون بلا تغيير", async () => {
        seedA();
        await syncMixedSale();

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [
                        { unitId: "P1-base", quantity: "5", price: "800" },
                        { unitId: "P1-base", quantity: "3", price: "1000" },
                    ],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toMatch(/كمية/);
        expect(eq(qty("A"), "92")).toBe(true);
        expect(store.invoices.some((i) => i.offlineId === "v1")).toBe(false);
    });

    it("سعر إلغاء لا يطابق أي سعر بيع أصلي (700) → FAILED", async () => {
        seedA();
        await syncMixedSale();

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [
                        { unitId: "P1-base", quantity: "5", price: "1000" },
                        { unitId: "P1-base", quantity: "3", price: "700" },
                    ],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toMatch(/سعر/);
        expect(eq(qty("A"), "92")).toBe(true);
    });

    it("عقد الكلاينت: دمج سطرين بسعرين مختلفين بسطر وحدة (8 @ 1000) → FAILED", async () => {
        seedA();
        await syncMixedSale();

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [{ unitId: "P1-base", quantity: "8", price: "1000" }],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("FAILED");
        expect(json.invoices[0].error).toMatch(/عدد/);
        expect(eq(qty("A"), "92")).toBe(true);
    });

    it("مقارنة السعر رقمية: '1000.0000' و '800.00' تطابق 1000 و 800", async () => {
        seedA();
        await syncMixedSale();

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [
                        { unitId: "P1-base", quantity: "5", price: "1000.0000" },
                        { unitId: "P1-base", quantity: "3", price: "800.00" },
                    ],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("سطران بنفس السعر المخفّض (5 + 3 @ 800) يُدمجان بمجموعة وحدة والإلغاء بسطر 8 @ 800 ينجح", async () => {
        seedA();
        await postSync({
            invoices: [
                saleInvoice({
                    offlineId: "s1",
                    items: [
                        { unitId: "P1-base", quantity: "5", price: "800", list: "1000" },
                        { unitId: "P1-base", quantity: "3", price: "800", list: "1000" },
                    ],
                }),
            ],
        });
        expect(eq(qty("A"), "92")).toBe(true);

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [{ unitId: "P1-base", quantity: "8", price: "800" }],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("العكس: بيع بسطر 8 @ 800 والإلغاء بسطرين (5 + 3 @ 800) يُدمجان ويُقبلان", async () => {
        seedA();
        await postSync({
            invoices: [
                saleInvoice({
                    offlineId: "s1",
                    items: [{ unitId: "P1-base", quantity: "8", price: "800", list: "1000" }],
                }),
            ],
        });

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [
                        { unitId: "P1-base", quantity: "5", price: "800" },
                        { unitId: "P1-base", quantity: "3", price: "800" },
                    ],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("طرد بسعرين مع تقسيم FIFO (24000 و 20000): الإلغاء يرجّع A=20 و B=100 بالضبط", async () => {
        seedBatch("A", "P1", "20", "2026-12-01", "10");
        seedBatch("B", "P1", "100", "2027-06-01", "10");

        const sale = await postSync({
            invoices: [
                saleInvoice({
                    offlineId: "s1",
                    items: [
                        { unitId: "P1-pack", quantity: "1", price: "24000" },
                        { unitId: "P1-pack", quantity: "1", price: "20000", list: "24000" },
                    ],
                }),
            ],
        });
        expect(sale.json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "0")).toBe(true);
        expect(eq(qty("B"), "72")).toBe(true); // 100 - 4 - 24
        expect(itemsOf(sale.json.invoices[0].realId)).toHaveLength(3); // A:20, B:4, B:24

        const { json } = await postSync({
            invoices: [
                voidInvoice({
                    offlineId: "v1",
                    voids: "s1",
                    items: [
                        { unitId: "P1-pack", quantity: "1", price: "24000" },
                        { unitId: "P1-pack", quantity: "1", price: "20000" },
                    ],
                }),
            ],
        });

        expect(json.invoices[0].status).toBe("SYNCED");
        expect(eq(qty("A"), "20")).toBe(true);
        expect(eq(qty("B"), "100")).toBe(true);
        const voided = store.invoices.find((i) => i.offlineId === "v1");
        expect(voided.hasPriceOverride).toBe(true);
        const voidRows = itemsOf(voided.id);
        expect(voidRows).toHaveLength(3);
        expect(voidRows.filter((r) => r.listUnitPriceSYP !== null)).toHaveLength(1);
    });
});

// ============================================================================
// [v6.2] ONLINE VOID — POST /api/ledger/voids copies every line verbatim (price,
// catalog snapshot, USD) and restores InvoiceItem.baseQuantity per row, so a
// mixed-price invoice is never a problem there. The route is imported
// dynamically so a load problem in it can only fail THESE tests.
// ============================================================================
describe("T4c — v6.2: الإلغاء الأونلاين (/api/ledger/voids) ينسخ السعر والكتالوج بند ببند", () => {
    const seedA = () => seedBatch("A", "P1", "100", "2026-12-01", "10");

    async function callOnlineVoid(invoiceId: string) {
        const { POST: voidsPOST } = await import("@/app/api/ledger/voids/route");
        const res = await voidsPOST(
            new Request("http://localhost/api/ledger/voids", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ invoiceId, voidReason: "سبب الإلغاء" }),
            })
        );
        return { status: res.status, json: await res.json() };
    }

    async function syncSale(items: LineIn[]): Promise<string> {
        const r = await postSync({ invoices: [saleInvoice({ offlineId: "s1", items })] });
        expect(r.json.invoices[0].status).toBe("SYNCED");
        return r.json.invoices[0].realId as string;
    }

    it("فاتورة بسعرين: 200 والمخزون يرجع بالضبط والسعر/الكتالوج/hasPriceOverride تُنسخ والمجموع صفر", async () => {
        seedA();
        const saleId = await syncSale([
            { unitId: "P1-base", quantity: "5", price: "1000" },
            { unitId: "P1-base", quantity: "3", price: "800", list: "1000" },
        ]);
        expect(eq(qty("A"), "92")).toBe(true);

        const { status, json } = await callOnlineVoid(saleId);

        expect(status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.voidItemsCount).toBe(2);
        expect(eq(qty("A"), "100")).toBe(true);

        const original = store.invoices.find((i) => i.id === saleId);
        const voided = store.invoices.find((i) => i.id === json.voidInvoiceId);
        expect(voided.status).toBe("VOIDED");
        expect(voided.voidsInvoiceId).toBe(saleId);
        expect(voided.hasPriceOverride).toBe(true);
        expect(new Decimal(original.totalSYP).plus(voided.totalSYP).isZero()).toBe(true);
        expect(new Decimal(original.totalUSD).plus(voided.totalUSD).isZero()).toBe(true);

        const voidRows = itemsOf(voided.id);
        const five = voidRows.find((r) => eq(r.baseQuantity, "-5"));
        const three = voidRows.find((r) => eq(r.baseQuantity, "-3"));
        expect(eq(five.unitPriceSYP, "1000")).toBe(true);
        expect(five.listUnitPriceSYP).toBeNull();
        expect(eq(three.unitPriceSYP, "800")).toBe(true);
        expect(eq(three.listUnitPriceSYP, "1000")).toBe(true);

        const all = [...itemsOf(original.id), ...voidRows];
        expect(all.reduce((s, i) => s.plus(i.baseQuantity), new Decimal(0)).isZero()).toBe(true);
        expect(all.reduce((s, i) => s.plus(i.costAmountSYP), new Decimal(0)).isZero()).toBe(true);
    });

    it("فاتورة عادية: hasPriceOverride = false و listUnitPriceSYP = null على الإلغاء", async () => {
        seedA();
        const saleId = await syncSale([{ unitId: "P1-base", quantity: "10", price: "1000" }]);

        const { status, json } = await callOnlineVoid(saleId);

        expect(status).toBe(200);
        const voided = store.invoices.find((i) => i.id === json.voidInvoiceId);
        expect(voided.hasPriceOverride).toBe(false);
        expect(itemsOf(voided.id).every((i) => i.listUnitPriceSYP === null)).toBe(true);
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("إلغاء ثانٍ لنفس الفاتورة → 400 INVALID_STATE والمخزون لا يتضاعف", async () => {
        seedA();
        const saleId = await syncSale([{ unitId: "P1-base", quantity: "10", price: "1000" }]);
        const first = await callOnlineVoid(saleId);
        expect(first.status).toBe(200);

        const second = await callOnlineVoid(saleId);

        expect(second.status).toBe(400);
        expect(second.json.error).toBe("INVALID_STATE");
        expect(eq(qty("A"), "100")).toBe(true);
    });

    it("جلسة كاشير → 403 ولا يُكتب شيء", async () => {
        seedA();
        const saleId = await syncSale([{ unitId: "P1-base", quantity: "10", price: "1000" }]);
        h.session = { user: { id: "cashier1", tenantId: "t1", role: "CASHIER" } };

        const { status } = await callOnlineVoid(saleId);

        expect(status).toBe(403);
        expect(store.invoices.filter((i) => i.status === "VOIDED")).toHaveLength(0);
        expect(eq(qty("A"), "90")).toBe(true);
    });
});

// ============================================================================
// [v6.2] STATIC SCANS — keep the override rules from drifting apart.
// ============================================================================
describe("T4c — v6.2: فحوصات ساكنة (بوابة واحدة، نسخ عند الإلغاء، تجميع بالسعر)", () => {
    const code = (rel: string) =>
        readFileSync(path.resolve(process.cwd(), rel), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");

    it("sync route: البوابة والكتابة تستخدمان نفس الدالة hasEffectiveListPrice", () => {
        const src = code("app/api/sync/route.ts");
        expect(src).toMatch(/function hasEffectiveListPrice\(/);
        expect(src).toMatch(/hasEffectiveListPrice\(it\)/); // البوابة
        expect(src).toMatch(/hasEffectiveListPrice\(item\)\s*\?\s*serializeMoney/); // الكتابة
    });

    it("sync route: hasPriceOverride للبيع يُحسب من البنود المخزّنة لا من الـ payload", () => {
        const src = code("app/api/sync/route.ts");
        expect(src).toMatch(/const hasPriceOverride\s*=\s*resolvedAllocations\.some\(/);
    });

    it("sync route: الإلغاء ينسخ listUnitPriceSYP و hasPriceOverride من الأصل", () => {
        const src = code("app/api/sync/route.ts");
        expect(src).toMatch(/hasPriceOverride:\s*originalInvoice\.hasPriceOverride/);
        expect(src).toMatch(/listUnitPriceSYP:\s*portion\.listUnitPriceSYP/);
    });

    it("sync route: الإلغاء يجمّع بالسعر (samePriceSYP) ولا بقي الرفض القديم لاختلاف الأسعار", () => {
        const src = code("app/api/sync/route.ts");
        expect(src).toMatch(/samePriceSYP\(/);
        expect(src).not.toMatch(/voidByKey/);
        expect(src).not.toMatch(/priceMismatch/);
    });

    it("voids route: ينسخ listUnitPriceSYP و hasPriceOverride من الأصل", () => {
        const src = code("app/api/ledger/voids/route.ts");
        expect(src).toMatch(/hasPriceOverride:\s*originalInvoice\.hasPriceOverride/);
        expect(src).toMatch(/listUnitPriceSYP:\s*item\.listUnitPriceSYP/);
    });
});