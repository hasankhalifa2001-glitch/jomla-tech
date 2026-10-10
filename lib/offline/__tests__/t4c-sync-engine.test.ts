/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T4c — /api/sync test suite (v4.8)
 *
 * Runs the REAL route handler (app/api/sync/route.ts), the REAL fifo.ts and
 * the REAL batch-locking.ts against an in-memory, TRANSACTIONAL fake of the
 * Prisma client (state is snapshotted on $transaction entry and restored when
 * the callback throws, so atomicity is actually exercised).
 *
 * Mocked: auth, tenant-scope (raw lock query is recorded, not executed),
 * base-unit, units (decimal.js re-implementation of toBaseUnit/fromBaseUnit),
 * resolve-active, repayment, subscription guard.
 *
 * KNOWN LIMIT (same as T3c's note): this fake is single-threaded, so it proves
 * the LOGIC (per-line deduction, void math, ordering of lock vs write, status
 * mapping) but NOT real Postgres concurrency (two devices racing the last
 * units, deadlock freedom). Those belong to T7's real-DB concurrency suite.
 *
 * Product fixtures: P1 has base unit "P1-base" (factor 1, "قطعة") and
 * "P1-pack" (factor 24, "طرد"). P2 has base unit "P2-base" only.
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

vi.mock("@/lib/auth/tenant", async () => {
    const { NextResponse } = await import("next/server");
    class SubscriptionLockedError extends Error { }
    return {
        assertTenantWritable: vi.fn(async () => { }),
        SubscriptionLockedError,
        subscriptionLockedResponse: () =>
            NextResponse.json({ error: "SUBSCRIPTION_LOCKED" }, { status: 403 }),
    };
});

import { POST } from "@/app/api/sync/route";
import { commitFifoAllocation } from "@/lib/inventory/fifo";
import { assertTenantWritable, SubscriptionLockedError } from "@/lib/auth/tenant";
import { recordRepaymentIdempotent } from "@/lib/ledger/repayment";

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
            findFirst: async ({ where, include }: any) => {
                if (where.voidsInvoiceId && h.hideVoidLookup) return null;
                const row = store.invoices.find((i) => matches(i, where));
                if (!row) return null;
                return include?.items
                    ? { ...row, items: store.invoiceItems.filter((it) => it.invoiceId === row.id) }
                    : { ...row };
            },
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
        items: o.items.map((i) => ({
            productId: i.productId ?? "P1",
            unitId: i.unitId,
            quantity: i.quantity,
            unitPriceSYP: i.price,
            unitPriceUSD: null,
        })),
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
        items: o.items.map((i) => ({
            productId: i.productId ?? "P1",
            unitId: i.unitId,
            quantity: `-${new Decimal(i.quantity).abs().toString()}`,
            unitPriceSYP: i.price,
            unitPriceUSD: null,
        })),
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

    store.users.push(
        { id: "admin1", tenantId: "t1", role: "ADMIN" },
        { id: "cashier1", tenantId: "t1", role: "CASHIER" },
        { id: "cashier2", tenantId: "t1", role: "CASHIER" }
    );
    store.customers.push(
        { id: "cust-cash", tenantId: "t1", isSystemGenerated: true, offlineId: null },
        { id: "cust-old", tenantId: "t1", isSystemGenerated: false, offlineId: null },
        { id: "cust-new", tenantId: "t1", isSystemGenerated: false, offlineId: null }
    );

    vi.mocked(assertTenantWritable).mockClear();
    vi.mocked(recordRepaymentIdempotent).mockClear();
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
        expect(recordRepaymentIdempotent).not.toHaveBeenCalled();
    });

    it("دفعة أنشأها كاشير ويزامنها مدير → FAILED (دور المنشئ لا دور الجلسة)", async () => {
        const { json } = await postSync({ payments: [payment({ createdByUserId: "cashier1" })] });
        expect(json.payments[0].status).toBe("FAILED");
        expect(recordRepaymentIdempotent).not.toHaveBeenCalled();
    });
});

describe("T4c — الحدود الخارجية", () => {
    it("بدون جلسة → 401", async () => {
        h.session = null;
        expect((await postSync({ invoices: [] })).status).toBe(401);
    });

    it("اشتراك منتهي/معلّق → 403 ولا يُقرأ شيء", async () => {
        vi.mocked(assertTenantWritable).mockRejectedValueOnce(new (SubscriptionLockedError as any)("locked"));
        const res = await postSync({ invoices: [] });
        expect(res.status).toBe(403);
    });

    it("JSON تالف → 400", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/sync", { method: "POST", body: "{not json" })
        );
        expect(res.status).toBe(400);
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
});