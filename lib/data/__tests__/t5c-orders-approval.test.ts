/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * lib/data/__tests__/t5c-orders-approval.test.ts
 *
 * T5c Phase 3 — the approval route + gateway transaction, mock level.
 *
 * REAL: app/api/orders/[id]/approve/route.ts, lib/data/orders-approval-tx.ts,
 *       lib/data/orders-approval.ts, lib/db/tx-retry.ts, lib/data/products.ts
 *       (batched readers), lib/inventory/fifo.ts, lib/inventory/units.ts,
 *       lib/utils/money.ts, lib/utils/phone.ts, lib/auth/role-matrix.ts.
 * MOCKED: @/lib/db (raw prisma), @/auth, assertTenantWritable, the batch-lock
 *         helper (the one raw query), requireBaseUnit and resolveActiveCustomerId.
 *
 * THE FAKE DATABASE is deliberately strict:
 *  - `select` is honoured: only selected keys come back, so code that reads a
 *    field it did not select gets `undefined` and fails (like production would).
 *  - `where` filters are evaluated (equality, in, not, gt/gte/lt/lte); an
 *    unsupported filter THROWS instead of silently matching everything.
 *  - every write is appended to `h.log`, so tests can prove WRITE ORDER (the
 *    claim is first) and WRITE CONTENT (only approvedQuantity is updated on
 *    an order item; no product/productUnit/tenant writes).
 *  - `$transaction` snapshots all stores and restores them when the callback
 *    (or an injected post-callback failure) throws: a faithful rollback.
 *
 * WHAT THIS DOES NOT PROVE (stated honestly, per the spec):
 *  - real FOR UPDATE row-lock serialization or deadlock freedom,
 *  - real database atomicity under true concurrency,
 *  - that the native upsert compiles to INSERT ... ON CONFLICT,
 *  - that a 20-second transaction timeout is respected under real latency.
 * Those need a disposable real Postgres — see t5c-orders-approval.real.test.ts
 * (a gated placeholder, NOT run here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";

const TENANT = "tenant-1";
const ADMIN = "admin-1";
const ORDER = "order-1";

const h = vi.hoisted(() => {
    const stores: any = {
        order: null,
        items: [],
        product: [],
        unit: [],
        batch: [],
        customer: [],
        tenantRow: null,
        invoice: [],
        invoiceItem: [],
        payment: [],
        verifiedRetailer: [],
    };
    const state = {
        session: null as any,
        txCalls: 0,
        /** Errors thrown AFTER the callback ran, with a ROLLBACK (failure before commit). */
        failAfter: [] as unknown[],
        /** Errors thrown AFTER the callback ran WITHOUT rollback (commit landed, response lost). */
        failAfterCommit: [] as unknown[],
        mergeMap: {} as Record<string, string>,
    };
    const log: Array<{ model: string; op: string; data?: any }> = [];
    const reads: Record<string, number> = {};
    let idc = 0;
    return {
        stores,
        state,
        log,
        reads,
        nextId: (p: string) => `${p}-${++idc}`,
        resetIds: () => {
            idc = 0;
        },
        mockWritable: vi.fn(async (_tenantId: string) => "ACTIVE"),
    };
});

function resetAll() {
    const s = h.stores;
    s.order = null;
    s.items = [];
    s.product = [];
    s.unit = [];
    s.batch = [];
    s.customer = [];
    s.tenantRow = null;
    s.invoice = [];
    s.invoiceItem = [];
    s.payment = [];
    s.verifiedRetailer = [];
    h.state.session = null;
    h.state.txCalls = 0;
    h.state.failAfter.length = 0;
    h.state.failAfterCommit.length = 0;
    h.state.mergeMap = {};
    h.log.length = 0;
    for (const k of Object.keys(h.reads)) delete h.reads[k];
    h.resetIds();
}

// ---------------------------------------------------------------------------
// Strict fake database
// ---------------------------------------------------------------------------
function cmpAny(a: any, b: any): number {
    if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime();
    const num = /^-?\d+(\.\d+)?$/;
    if (num.test(String(a)) && num.test(String(b))) return new Decimal(String(a)).comparedTo(String(b));
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matches(row: any, where: any): boolean {
    return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
        if (v !== null && typeof v === "object" && !(v instanceof Date)) {
            if ("in" in v) return (v.in as any[]).includes(row[k]);
            if ("not" in v) {
                return v.not === null ? row[k] !== null && row[k] !== undefined : row[k] !== v.not;
            }
            if ("gt" in v) return cmpAny(row[k], v.gt) > 0;
            if ("gte" in v) return row[k] != null && cmpAny(row[k], v.gte) >= 0;
            if ("lt" in v) return cmpAny(row[k], v.lt) < 0;
            if ("lte" in v) return cmpAny(row[k], v.lte) <= 0;
            throw new Error(`fake db: unsupported where filter on "${k}": ${JSON.stringify(v)}`);
        }
        return row[k] === v;
    });
}

/** Honours `select`: only selected keys come back (a missing select returns a full copy). */
function pick(row: any, select?: any): any {
    if (!select) return { ...row };
    const out: any = {};
    for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
    return out;
}

function sortRows(rows: any[], orderBy?: any): any[] {
    if (!orderBy) return rows;
    const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((x, y) => {
        for (const key of keys) {
            const f = Object.keys(key)[0];
            const dir = key[f] === "desc" ? -1 : 1;
            const a = x[f];
            const b = y[f];
            if ((a === null || a === undefined) && (b === null || b === undefined)) continue;
            if (a === null || a === undefined) return 1; // nulls last
            if (b === null || b === undefined) return -1;
            const r = cmpAny(a, b);
            if (r !== 0) return r * dir;
        }
        return 0;
    });
}

const rd = (name: string) => {
    h.reads[name] = (h.reads[name] ?? 0) + 1;
};

function buildTx() {
    const tx: any = {};

    tx.b2BOrderRequest = {
        updateMany: async ({ where, data }: any) => {
            h.log.push({ model: "b2BOrderRequest", op: "updateMany", data });
            const o = h.stores.order;
            if (o && matches(o, where)) {
                Object.assign(o, data);
                return { count: 1 };
            }
            return { count: 0 };
        },
        findFirst: async ({ where, select }: any) => {
            const o = h.stores.order;
            return o && matches(o, where) ? pick(o, select) : null;
        },
        findUnique: async ({ where, select }: any) => {
            const o = h.stores.order;
            return o && matches(o, where) ? pick(o, select) : null;
        },
        update: async ({ where, data }: any) => {
            h.log.push({ model: "b2BOrderRequest", op: "update", data });
            const o = h.stores.order;
            if (!o || o.id !== where.id || o.tenantId !== where.tenantId) throw new Error("order.update: not found");
            Object.assign(o, data);
            return o;
        },
    };

    tx.b2BOrderRequestItem = {
        findMany: async ({ where, select, orderBy }: any) => {
            rd("b2BOrderRequestItem.findMany");
            return sortRows(h.stores.items.filter((i: any) => matches(i, where)), orderBy).map((i: any) => pick(i, select));
        },
        update: async ({ where, data }: any) => {
            h.log.push({ model: "b2BOrderRequestItem", op: "update", data });
            const it = h.stores.items.find((i: any) => i.id === where.id && i.tenantId === where.tenantId);
            if (!it) throw new Error("item.update: not found");
            Object.assign(it, data);
            return it;
        },
    };

    tx.product = {
        findMany: async ({ where, select }: any) => {
            rd("product.findMany");
            return h.stores.product.filter((p: any) => matches(p, where)).map((p: any) => pick(p, select));
        },
    };

    tx.productUnit = {
        findMany: async ({ where, select }: any) => {
            rd("productUnit.findMany");
            return h.stores.unit.filter((u: any) => matches(u, where)).map((u: any) => pick(u, select));
        },
    };

    tx.productBatch = {
        findMany: async ({ where, select, orderBy, take }: any) => {
            rd("productBatch.findMany");
            let rows = sortRows(h.stores.batch.filter((b: any) => matches(b, where)), orderBy);
            if (typeof take === "number") rows = rows.slice(0, take);
            return rows.map((b: any) => pick(b, select));
        },
        update: async ({ where, data }: any) => {
            h.log.push({ model: "productBatch", op: "update", data });
            const b = h.stores.batch.find((x: any) => x.id === where.id && x.tenantId === where.tenantId);
            if (!b) throw new Error("batch.update: not found");
            const { subtractMoney, addMoney } = await import("@/lib/utils/money");
            if (data.quantity?.decrement !== undefined) {
                b.quantity = subtractMoney(String(b.quantity), String(data.quantity.decrement));
            } else if (data.quantity?.increment !== undefined) {
                b.quantity = addMoney(String(b.quantity), String(data.quantity.increment));
            }
            return b;
        },
    };

    tx.tenant = {
        findUnique: async ({ where, select }: any) =>
            h.stores.tenantRow && h.stores.tenantRow.id === where.id ? pick(h.stores.tenantRow, select) : null,
    };

    tx.customer = {
        findFirst: async ({ where, select }: any) => {
            const c = h.stores.customer.find((row: any) => matches(row, where));
            return c ? pick(c, select) : null;
        },
        create: async ({ data }: any) => {
            h.log.push({ model: "customer", op: "create", data });
            const row = { id: h.nextId("cust"), ...data };
            h.stores.customer.push(row);
            return row;
        },
    };

    tx.invoice = {
        create: async ({ data }: any) => {
            h.log.push({ model: "invoice", op: "create", data });
            const row = { id: h.nextId("inv"), ...data };
            h.stores.invoice.push(row);
            return row;
        },
        findFirst: async ({ where, select }: any) => {
            const inv = h.stores.invoice.find((row: any) => matches(row, where));
            return inv ? pick(inv, select) : null;
        },
    };

    tx.invoiceItem = {
        create: async ({ data }: any) => {
            h.log.push({ model: "invoiceItem", op: "create", data });
            const row = { id: h.nextId("item"), ...data };
            h.stores.invoiceItem.push(row);
            return row;
        },
    };

    tx.customerPayment = {
        create: async ({ data }: any) => {
            h.log.push({ model: "customerPayment", op: "create", data });
            const row = { id: h.nextId("pay"), ...data };
            h.stores.payment.push(row);
            return row;
        },
    };

    tx.verifiedRetailer = {
        upsert: async ({ where, create, update }: any) => {
            h.log.push({ model: "verifiedRetailer", op: "upsert", data: { where, create, update } });
            const row = h.stores.verifiedRetailer.find((r: any) => r.phone === where.phone);
            if (row) {
                row.verificationCount += update.verificationCount.increment;
                return row;
            }
            const created = { ...create };
            h.stores.verifiedRetailer.push(created);
            return created;
        },
    };

    return tx;
}

function restore(snap: any) {
    for (const k of Object.keys(h.stores)) delete h.stores[k];
    Object.assign(h.stores, snap);
}

vi.mock("@/lib/db", () => {
    const delegates = () => buildTx();
    return {
        prisma: {
            $transaction: async (fn: (tx: any) => Promise<any>) => {
                h.state.txCalls += 1;
                const snap = structuredClone(h.stores);
                const tx = buildTx();
                let result: any;
                try {
                    result = await fn(tx);
                    const injected = h.state.failAfter.shift();
                    if (injected) throw injected; // failure BEFORE commit -> rollback
                } catch (e) {
                    restore(snap);
                    throw e;
                }
                const lost = h.state.failAfterCommit.shift();
                if (lost) throw lost; // commit landed, the client never saw the result
                return result;
            },
            // Read-only delegates used by the idempotent-recovery check.
            get b2BOrderRequest() {
                return delegates().b2BOrderRequest;
            },
            get b2BOrderRequestItem() {
                return delegates().b2BOrderRequestItem;
            },
            get invoice() {
                return delegates().invoice;
            },
            get customer() {
                return delegates().customer;
            },
        },
    };
});

vi.mock("@/lib/db/tenant-scope", () => ({
    getTenantDb: vi.fn(),
    tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.state.session) }));

vi.mock("@/lib/auth/tenant", async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, assertTenantWritable: h.mockWritable };
});

// The one raw query: return the LOCKED batches' quantities keyed by batchId.
vi.mock("@/lib/inventory/batch-locking", () => ({
    lockBatchesForFifoAllocations: vi.fn(async (_tx: any, tenantId: string, productIds: string[]) => {
        const map = new Map<string, string>();
        for (const b of h.stores.batch) {
            if (b.tenantId === tenantId && productIds.includes(b.productId)) map.set(b.id, String(b.quantity));
        }
        return map;
    }),
}));

vi.mock("@/lib/inventory/base-unit", async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        requireBaseUnit: async (_tx: unknown, tenantId: string, productId: string) => {
            const p = h.stores.product.find((x: any) => x.id === productId && x.tenantId === tenantId);
            if (!p) throw new Error(`requireBaseUnit: product ${productId} not found`);
            return { id: p.baseUnitId, unitName: "قطعة" };
        },
    };
});

vi.mock("@/lib/customers/resolve-active", () => ({
    resolveActiveCustomerId: async (_tx: unknown, _tenantId: string, id: string) => h.state.mergeMap[id] ?? id,
}));

import { POST as approveHandler } from "@/app/api/orders/[id]/approve/route";
import { SubscriptionLockedError } from "@/lib/auth/tenant";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function setSession(role: "ADMIN" | "CASHIER" | null, id: string = ADMIN) {
    h.state.session = role == null ? null : { user: { id, role, tenantId: TENANT } };
}

function req(bodyObj: unknown): Request {
    return new Request(`http://localhost/api/orders/${ORDER}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj),
    });
}
const ctx = { params: Promise.resolve({ id: ORDER }) } as any;
const post = (bodyObj: unknown) => approveHandler(req(bodyObj), ctx);

const eq = (a: any, b: string) => new Decimal(String(a)).eq(b);
const qty = (batchId: string): string => h.stores.batch.find((b: any) => b.id === batchId).quantity;

let batchSeq = 0;

function seedTenant(rate: string | null = null) {
    h.stores.tenantRow = { id: TENANT, dailyExchangeRate: rate };
}

function seedOrderRow(o: { retailerPhone?: string; retailerShopName?: string | null; matchedCustomerId?: string | null } = {}) {
    h.stores.order = {
        id: ORDER,
        tenantId: TENANT,
        status: "PENDING_REVIEW",
        retailerPhone: o.retailerPhone ?? "0944123456",
        retailerShopName: o.retailerShopName === undefined ? "متجر التاجر" : o.retailerShopName,
        matchedCustomerId: o.matchedCustomerId ?? null,
        resultingInvoiceId: null,
        reviewedByUserId: null,
        reviewedAt: null,
    };
}

function addProduct(
    o: {
        productId?: string;
        baseUnitId?: string;
        soldUnitId?: string;
        factor?: string;
        productActive?: boolean;
        unitActive?: boolean;
        livePrice?: string;
        batches?: Array<{ id: string; quantity: string; cost?: string; expiry?: string | null }>;
    } = {}
) {
    const productId = o.productId ?? "prod-1";
    const baseUnitId = o.baseUnitId ?? "unit-base";
    const soldUnitId = o.soldUnitId ?? "unit-pack";
    h.stores.product.push({
        id: productId,
        tenantId: TENANT,
        isActive: o.productActive ?? true,
        baseUnitId,
        name: "سكر",
    });
    h.stores.unit.push({
        id: baseUnitId,
        tenantId: TENANT,
        productId,
        isActive: true,
        conversionFactor: "1",
        unitName: "قطعة",
        priceWholesale: "10",
        pricingCurrency: "SYP",
    });
    h.stores.unit.push({
        id: soldUnitId,
        tenantId: TENANT,
        productId,
        isActive: o.unitActive ?? true,
        conversionFactor: o.factor ?? "24",
        unitName: "طرد",
        priceWholesale: o.livePrice ?? "1000",
        pricingCurrency: "SYP",
    });
    for (const b of o.batches ?? [{ id: "batch-1", quantity: "100", cost: "10", expiry: null }]) {
        h.stores.batch.push({
            id: b.id,
            tenantId: TENANT,
            productId,
            batchNumber: `BN-${b.id}`,
            quantity: new Decimal(b.quantity).toFixed(4),
            expiryDate: b.expiry ? new Date(b.expiry) : null,
            costPricePerBaseUnit: b.cost ?? "10",
            createdAt: new Date(2026, 0, 1, 0, 0, ++batchSeq),
        });
    }
}

function addLine(o: {
    itemId?: string;
    productId?: string;
    unitId?: string;
    qty?: string;
    price?: string;
    currency?: "SYP" | "USD";
}) {
    h.stores.items.push({
        id: o.itemId ?? "item-1",
        orderRequestId: ORDER,
        tenantId: TENANT,
        productId: o.productId ?? "prod-1",
        unitId: o.unitId ?? "unit-pack",
        quantity: o.qty ?? "3",
        approvedQuantity: null,
        priceWholesaleSnapshot: o.price ?? "1000",
        pricingCurrencySnapshot: o.currency ?? "SYP",
    });
}

/** One product + one line, the common case. */
function seed(
    o: {
        rate?: string | null;
        factor?: string;
        price?: string;
        currency?: "SYP" | "USD";
        qty?: string;
        livePrice?: string;
        productActive?: boolean;
        unitActive?: boolean;
        retailerPhone?: string;
        retailerShopName?: string | null;
        matchedCustomerId?: string | null;
        batches?: Array<{ id: string; quantity: string; cost?: string; expiry?: string | null }>;
    } = {}
) {
    seedTenant(o.rate ?? null);
    seedOrderRow({
        retailerPhone: o.retailerPhone,
        retailerShopName: o.retailerShopName,
        matchedCustomerId: o.matchedCustomerId,
    });
    addProduct({
        factor: o.factor,
        livePrice: o.livePrice,
        productActive: o.productActive,
        unitActive: o.unitActive,
        batches: o.batches,
    });
    addLine({ qty: o.qty, price: o.price, currency: o.currency });
}

function seedCustomer(o: Record<string, unknown> = {}) {
    const row = {
        id: "cust-1",
        tenantId: TENANT,
        isActive: true,
        isSystemGenerated: false,
        name: "زبون",
        phone: "0944123456",
        shopName: null,
        ...o,
    };
    h.stores.customer.push(row);
    return row;
}

function body(overrides: Record<string, unknown> = {}) {
    return {
        lines: [{ itemId: "item-1", approvedQuantity: "3" }],
        customer: { mode: "EXISTING", customerId: "cust-1" },
        payment: { mode: "FULL_CREDIT" },
        ...overrides,
    };
}

const transient = (code = "P2034") =>
    new Prisma.PrismaClientKnownRequestError("transient", { code, clientVersion: "test" });

beforeEach(() => {
    resetAll();
    batchSeq = 0;
    setSession("ADMIN");
    h.mockWritable.mockReset();
    h.mockWritable.mockResolvedValue("ACTIVE");
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe("T5c approval — happy path and write discipline", () => {
    it("creates one COMPLETED invoice, deducts stock, links the order, writes the signal", async () => {
        seed({});
        seedCustomer();
        const res = await post(body());
        expect(res.status).toBe(200);
        const j: any = await res.json();
        expect(Object.keys(j).sort()).toEqual(
            ["customerId", "debtAmountSYP", "invoiceId", "paidAmountSYP", "success", "totalSYP"].sort()
        );
        // 3 packs x 1000 = 3000; full credit -> paid 0, debt 3000.
        expect(eq(j.totalSYP, "3000")).toBe(true);
        expect(eq(j.paidAmountSYP, "0")).toBe(true);
        expect(eq(j.debtAmountSYP, "3000")).toBe(true);
        // Stock: 100 - (3 x 24 = 72) = 28 (sold unit's OWN factor, never the base unit's 1).
        expect(eq(qty("batch-1"), "28")).toBe(true);
        expect(h.stores.invoice).toHaveLength(1);
        expect(h.stores.invoiceItem).toHaveLength(1);
        expect(eq(h.stores.invoiceItem[0].baseQuantity, "72")).toBe(true);
        expect(h.stores.payment).toHaveLength(0);
        expect(h.stores.order.status).toBe("APPROVED");
        expect(h.stores.order.resultingInvoiceId).toBe(h.stores.invoice[0].id);
        expect(h.stores.invoice[0].userId).toBe(ADMIN);
        expect(h.stores.invoice[0].offlineId).toBeNull();
        expect(h.stores.invoice[0].status).toBe("COMPLETED");
        expect(h.stores.verifiedRetailer).toMatchObject([
            { phone: "0944123456", shopName: "متجر التاجر", verificationCount: 1 },
        ]);
    });

    it("the claim is the FIRST write; no product/unit/tenant writes ever happen", async () => {
        seed({});
        seedCustomer();
        await post(body());
        expect(h.log[0]).toMatchObject({ model: "b2BOrderRequest", op: "updateMany" });
        expect(h.log.every((e) => !["product", "productUnit", "tenant"].includes(e.model))).toBe(true);
    });

    it("the VerifiedRetailer upsert is keyed by phone only and carries no tenantId", async () => {
        seed({});
        seedCustomer();
        await post(body());
        const entry = h.log.find((e) => e.model === "verifiedRetailer")!;
        expect(Object.keys(entry.data.where)).toEqual(["phone"]);
        expect("tenantId" in entry.data.create).toBe(false);
    });

    it("the success response and the stock details carry no cost / batch / baseUnit data", async () => {
        seed({});
        seedCustomer();
        const res = await post(body());
        const text = JSON.stringify(await res.json());
        expect(text).not.toMatch(/cost|batch|baseUnit|passwordHash/i);
    });
});

// ---------------------------------------------------------------------------
describe("T5c approval — rollback, retry and idempotent resubmission", () => {
    it("a rule failure after the claim rolls everything back (order stays PENDING_REVIEW)", async () => {
        seed({});
        seedCustomer();
        const res = await post(body({ customer: { mode: "EXISTING", customerId: "missing-cust" } }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).code).toBe("INVALID_CUSTOMER");
        expect(h.log[0]).toMatchObject({ model: "b2BOrderRequest", op: "updateMany" }); // the claim DID run
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
        expect(h.stores.invoice).toHaveLength(0);
        expect(h.stores.invoiceItem).toHaveLength(0);
        expect(h.stores.payment).toHaveLength(0);
        expect(eq(qty("batch-1"), "100")).toBe(true);
        expect(h.stores.verifiedRetailer).toHaveLength(0);
    });

    it("a failure AFTER every write (before commit) rolls back all of them", async () => {
        seed({});
        seedCustomer();
        h.state.failAfter.push(transient("P2028"), transient("P2028"));
        const res = await post(body());
        expect(res.status).toBe(503);
        expect(((await res.json()) as any).code).toBe("TX_RETRY");
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
        expect(h.stores.invoice).toHaveLength(0);
        expect(h.stores.invoiceItem).toHaveLength(0);
        expect(eq(qty("batch-1"), "100")).toBe(true);
        expect(h.stores.verifiedRetailer).toHaveLength(0);
        expect(h.stores.order.resultingInvoiceId).toBeNull();
    });

    it("a transient P2034 on the first attempt, then success -> exactly one invoice and one deduction", async () => {
        seed({});
        seedCustomer();
        h.state.failAfter.push(transient("P2034"));
        const res = await post(body());
        expect(res.status).toBe(200);
        expect(h.state.txCalls).toBe(2);
        expect(h.stores.invoice).toHaveLength(1);
        expect(h.stores.invoiceItem).toHaveLength(1);
        expect(eq(qty("batch-1"), "28")).toBe(true);
    });

    it("exhausting retries on P2034 -> 503 TX_RETRY after 3 attempts, nothing written", async () => {
        seed({});
        seedCustomer();
        h.state.failAfter.push(transient(), transient(), transient());
        const res = await post(body());
        expect(res.status).toBe(503);
        expect(h.state.txCalls).toBe(3);
        expect(h.stores.invoice).toHaveLength(0);
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
    });

    it("P2028 is capped at 2 failures", async () => {
        seed({});
        seedCustomer();
        h.state.failAfter.push(transient("P2028"), transient("P2028"), transient("P2028"));
        const res = await post(body());
        expect(res.status).toBe(503);
        expect(h.state.txCalls).toBe(2);
    });

    it("domain errors are NEVER retried (INSUFFICIENT_STOCK -> exactly one attempt)", async () => {
        seed({ batches: [{ id: "batch-1", quantity: "10" }] });
        seedCustomer();
        const res = await post(body());
        expect(res.status).toBe(409);
        expect(h.state.txCalls).toBe(1);
    });

    it("commit landed but the response was lost -> the retry returns the SAME invoice (one invoice, one deduction)", async () => {
        seed({});
        seedCustomer();
        h.state.failAfterCommit.push(transient("P1017"));
        const res = await post(body());
        expect(res.status).toBe(200);
        const j: any = await res.json();
        expect(h.state.txCalls).toBe(2);
        expect(h.stores.invoice).toHaveLength(1);
        expect(j.invoiceId).toBe(h.stores.invoice[0].id);
        expect(eq(qty("batch-1"), "28")).toBe(true);
    });

    it("identical resubmission by the same admin within the window -> same invoiceId, zero extra side effects", async () => {
        seed({});
        seedCustomer();
        const first: any = await (await post(body())).json();
        const second = await post(body());
        expect(second.status).toBe(200);
        expect(((await second.json()) as any).invoiceId).toBe(first.invoiceId);
        expect(h.stores.invoice).toHaveLength(1);
        expect(eq(qty("batch-1"), "28")).toBe(true);
    });

    it("a resubmission with DIFFERENT quantities -> 409 ALREADY_REVIEWED", async () => {
        seed({});
        seedCustomer();
        await post(body());
        const res = await post(body({ lines: [{ itemId: "item-1", approvedQuantity: "2" }] }));
        expect(res.status).toBe(409);
        expect(((await res.json()) as any).code).toBe("ALREADY_REVIEWED");
        expect(h.stores.invoice).toHaveLength(1);
    });

    it("a resubmission with a DIFFERENT customer -> 409", async () => {
        seed({});
        seedCustomer();
        seedCustomer({ id: "cust-2" });
        await post(body());
        const res = await post(body({ customer: { mode: "EXISTING", customerId: "cust-2" } }));
        expect(res.status).toBe(409);
    });

    it("a resubmission with a DIFFERENT payment mode -> 409", async () => {
        seed({});
        seedCustomer();
        await post(body());
        const res = await post(body({ payment: { mode: "FULL_CASH", paymentMethod: "CASH" } }));
        expect(res.status).toBe(409);
    });

    it("a resubmission by a DIFFERENT admin -> 409", async () => {
        seed({});
        seedCustomer();
        await post(body());
        setSession("ADMIN", "admin-2");
        const res = await post(body());
        expect(res.status).toBe(409);
    });

    it("a resubmission OUTSIDE the 2-minute window -> 409", async () => {
        seed({});
        seedCustomer();
        await post(body());
        h.stores.order.reviewedAt = new Date(Date.now() - 3 * 60 * 1000);
        const res = await post(body());
        expect(res.status).toBe(409);
    });

    it("an approved order with NO linked invoice is never recovered -> 409", async () => {
        seed({});
        seedCustomer();
        await post(body());
        h.stores.order.resultingInvoiceId = null;
        const res = await post(body());
        expect(res.status).toBe(409);
    });

    it("a different order id of another tenant -> 404 and zero writes", async () => {
        seed({});
        seedCustomer();
        h.stores.order.tenantId = "tenant-B";
        for (const it of h.stores.items) it.tenantId = "tenant-B";
        const res = await post(body());
        expect(res.status).toBe(404);
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
        expect(h.stores.invoice).toHaveLength(0);
        expect(h.stores.verifiedRetailer).toHaveLength(0);
        expect(eq(qty("batch-1"), "100")).toBe(true);
        // Nothing that creates or deducts was attempted for the foreign order.
        expect(h.log.some((e) => ["invoice", "invoiceItem", "customerPayment", "customer", "productBatch"].includes(e.model))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe("T5c approval — stock, FIFO and conversion", () => {
    it("insufficient stock -> 409 with per-line details (exact keys, no batch data), nothing written", async () => {
        seed({ batches: [{ id: "batch-1", quantity: "50" }] });
        seedCustomer();
        const res = await post(body());
        expect(res.status).toBe(409);
        const j: any = await res.json();
        expect(j.code).toBe("INSUFFICIENT_STOCK");
        expect(j.details).toHaveLength(1);
        expect(Object.keys(j.details[0]).sort()).toEqual(["available", "itemId", "productName", "unitName"]);
        expect(j.details[0].available).toBe("2.0833"); // 50 / 24 truncated, never 2.0834
        expect(JSON.stringify(j)).not.toMatch(/batch/i);
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
        expect(h.stores.invoice).toHaveLength(0);
        expect(eq(qty("batch-1"), "50")).toBe(true);
    });

    it("two lines of ONE product in different units are checked together and BOTH are listed", async () => {
        seedTenant();
        seedOrderRow();
        addProduct({ batches: [{ id: "batch-1", quantity: "100" }] });
        addLine({ itemId: "item-1", unitId: "unit-pack", qty: "2", price: "1000" }); // 48 base
        addLine({ itemId: "item-2", unitId: "unit-base", qty: "60", price: "10" }); // 60 base; 108 > 100
        seedCustomer();
        const res = await post(
            body({
                lines: [
                    { itemId: "item-1", approvedQuantity: "2" },
                    { itemId: "item-2", approvedQuantity: "60" },
                ],
            })
        );
        expect(res.status).toBe(409);
        const j: any = await res.json();
        expect(j.details.map((d: any) => d.itemId).sort()).toEqual(["item-1", "item-2"]);
        for (const d of j.details) {
            expect(Object.keys(d).sort()).toEqual(["available", "itemId", "productName", "unitName"]);
        }
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
        expect(eq(qty("batch-1"), "100")).toBe(true);
    });

    it("two lines of one product drawing from the SAME batch never drive it below zero", async () => {
        seedTenant();
        seedOrderRow();
        addProduct({ batches: [{ id: "batch-1", quantity: "100" }] });
        addLine({ itemId: "item-1", unitId: "unit-pack", qty: "2", price: "1000" }); // 48
        addLine({ itemId: "item-2", unitId: "unit-base", qty: "50", price: "10" }); // 50 -> 98 <= 100
        seedCustomer();
        const res = await post(
            body({
                lines: [
                    { itemId: "item-1", approvedQuantity: "2" },
                    { itemId: "item-2", approvedQuantity: "50" },
                ],
            })
        );
        expect(res.status).toBe(200);
        expect(eq(qty("batch-1"), "2")).toBe(true);
        expect(h.stores.batch.every((b: any) => new Decimal(b.quantity).gte(0))).toBe(true);
        const sum = h.stores.invoiceItem.reduce((s: any, i: any) => s.plus(i.baseQuantity), new Decimal(0));
        expect(sum.eq(98)).toBe(true);
    });

    it("a negative batch counts as zero and is never touched", async () => {
        seed({
            batches: [
                { id: "b-neg", quantity: "-5", expiry: "2026-06-01" },
                { id: "b-ok", quantity: "72", expiry: "2026-12-01" },
            ],
        });
        seedCustomer();
        const res = await post(body());
        expect(res.status).toBe(200);
        expect(eq(qty("b-ok"), "0")).toBe(true);
        expect(eq(qty("b-neg"), "-5")).toBe(true);
    });

    it("FIFO spanning two batches -> two rows with an exact baseQuantity sum and per-allocation cost", async () => {
        seed({
            qty: "1",
            price: "24000",
            batches: [
                { id: "A", quantity: "20", cost: "10", expiry: "2026-12-01" },
                { id: "B", quantity: "100", cost: "12", expiry: "2027-06-01" },
            ],
        });
        seedCustomer();
        const res = await post(body({ lines: [{ itemId: "item-1", approvedQuantity: "1" }] }));
        expect(res.status).toBe(200);
        expect(eq(qty("A"), "0")).toBe(true);
        expect(eq(qty("B"), "96")).toBe(true);
        const rows = h.stores.invoiceItem;
        expect(rows).toHaveLength(2);
        expect(rows.map((r: any) => r.batchId)).toEqual(["A", "B"]);
        expect(eq(rows[0].baseQuantity, "20")).toBe(true);
        expect(eq(rows[1].baseQuantity, "4")).toBe(true);
        expect(rows[0].quantity).toBe("0.8333"); // display only (rounded)
        expect(rows[1].quantity).toBe("0.1667");
        expect(eq(rows[0].costAmountSYP, "200")).toBe(true); // 20 x 10
        expect(eq(rows[1].costAmountSYP, "48")).toBe(true); // 4 x 12
        expect(rows.every((r: any) => r.unitId === "unit-pack")).toBe(true); // SOLD unit
        expect(eq(h.stores.invoice[0].totalSYP, "24000")).toBe(true); // per ORDER LINE, not per split row
    });

    it("a 3-way 8/8/8 split keeps an exact base sum (no 0.9999 x 24 drift)", async () => {
        seed({
            qty: "1",
            price: "24000",
            batches: [
                { id: "A", quantity: "8", expiry: "2026-12-01" },
                { id: "B", quantity: "8", expiry: "2027-01-01" },
                { id: "C", quantity: "100", expiry: "2027-06-01" },
            ],
        });
        seedCustomer();
        const res = await post(body({ lines: [{ itemId: "item-1", approvedQuantity: "1" }] }));
        expect(res.status).toBe(200);
        const rows = h.stores.invoiceItem;
        expect(rows.map((r: any) => r.quantity)).toEqual(["0.3333", "0.3333", "0.3333"]);
        const baseSum = rows.reduce((s: any, r: any) => s.plus(r.baseQuantity), new Decimal(0));
        expect(baseSum.eq(24)).toBe(true);
        expect(eq(qty("C"), "92")).toBe(true);
    });

    it("a client-supplied factor is rejected by the strict schema (400, no writes)", async () => {
        seed({});
        seedCustomer();
        const res = await post(body({ soldUnitFactor: "1" }));
        expect(res.status).toBe(400);
        expect(h.log).toHaveLength(0);
    });

    it("a quantity that converts to ZERO base units is a 400 and writes nothing", async () => {
        seed({ factor: "0.0001", qty: "1" });
        seedCustomer();
        const res = await post(body({ lines: [{ itemId: "item-1", approvedQuantity: "0.0001" }] }));
        expect(res.status).toBe(400);
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
        expect(h.stores.invoice).toHaveLength(0);
        expect(eq(qty("batch-1"), "100")).toBe(true);
    });

    it("an inactive product, an inactive unit, or a unit of another product -> 409 PRODUCT_INACTIVE", async () => {
        seed({ productActive: false });
        seedCustomer();
        let res = await post(body());
        expect(res.status).toBe(409);
        expect(((await res.json()) as any).code).toBe("PRODUCT_INACTIVE");

        resetAll();
        seed({ unitActive: false });
        seedCustomer();
        res = await post(body());
        expect(res.status).toBe(409);

        resetAll();
        seed({});
        seedCustomer();
        h.stores.unit.find((u: any) => u.id === "unit-pack").productId = "some-other-product";
        res = await post(body());
        expect(res.status).toBe(409);
    });

    it("no N+1: a 50-line order (100 split invoice rows) uses a constant number of catalog reads", async () => {
        seedTenant();
        seedOrderRow();
        const lines: Array<{ itemId: string; approvedQuantity: string }> = [];
        for (let i = 0; i < 50; i++) {
            addProduct({
                productId: `p${i}`,
                baseUnitId: `ub${i}`,
                soldUnitId: `up${i}`,
                batches: [
                    { id: `a${i}`, quantity: "20", expiry: "2026-12-01" },
                    { id: `b${i}`, quantity: "100", expiry: "2027-06-01" },
                ],
            });
            addLine({ itemId: `item-${i}`, productId: `p${i}`, unitId: `up${i}`, qty: "1", price: "24000" });
            lines.push({ itemId: `item-${i}`, approvedQuantity: "1" });
        }
        seedCustomer();
        const started = Date.now();
        const res = await post(body({ lines }));
        expect(res.status).toBe(200);
        expect(h.stores.invoiceItem).toHaveLength(100);
        expect(eq(h.stores.invoice[0].totalSYP, "1200000")).toBe(true);
        expect(eq(qty("a0"), "0")).toBe(true);
        expect(eq(qty("b49"), "96")).toBe(true);
        // Batched readers: names + active flags only (2), names + factors + flags only (3).
        expect(h.reads["product.findMany"]).toBeLessThanOrEqual(2);
        expect(h.reads["productUnit.findMany"]).toBeLessThanOrEqual(3);
        // MOCK-LEVEL ONLY: this proves query COUNT, not real-latency behaviour against the 20s timeout.
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

// ---------------------------------------------------------------------------
describe("T5c approval — prices, exchange rate and USD", () => {
    it("USD line with a rate: converted at the approval-time rate and FROZEN on invoice and payment", async () => {
        seed({ currency: "USD", price: "2", rate: "15000" });
        seedCustomer();
        const res = await post(body({ payment: { mode: "FULL_CASH", paymentMethod: "CASH" } }));
        expect(res.status).toBe(200);
        const inv = h.stores.invoice[0];
        expect(eq(inv.exchangeRateUsed, "15000")).toBe(true);
        expect(eq(inv.totalSYP, "90000")).toBe(true); // 3 x (2 x 15000)
        expect(eq(inv.totalUSD, "6")).toBe(true);
        expect(eq(h.stores.invoiceItem[0].unitPriceSYP, "30000")).toBe(true);
        expect(eq(h.stores.invoiceItem[0].unitPriceUSD, "2")).toBe(true);
        expect(h.stores.payment).toHaveLength(1);
        expect(eq(h.stores.payment[0].amountSYP, "90000")).toBe(true);
        expect(eq(h.stores.payment[0].amountUSD, "6")).toBe(true);
        expect(eq(h.stores.payment[0].exchangeRate, "15000")).toBe(true);
    });

    it("USD line WITHOUT a rate -> 422 RATE_REQUIRED, nothing written, no customer created", async () => {
        seed({ currency: "USD", price: "2", rate: null });
        const res = await post(
            body({ customer: { mode: "NEW", name: "زبون جديد", phone: "0944123456" } })
        );
        expect(res.status).toBe(422);
        expect(((await res.json()) as any).code).toBe("RATE_REQUIRED");
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
        expect(h.stores.invoice).toHaveLength(0);
        expect(h.log.some((e) => e.model === "customer" && e.op === "create")).toBe(false);
    });

    it("SYP-only order WITHOUT a rate: every USD field is null (never 0 or 1)", async () => {
        seed({ rate: null });
        seedCustomer();
        const res = await post(body({ payment: { mode: "PARTIAL", paidAmountSYP: "1000", paymentMethod: "CASH" } }));
        expect(res.status).toBe(200);
        const inv = h.stores.invoice[0];
        expect(inv.exchangeRateUsed).toBeNull();
        expect(inv.totalUSD).toBeNull();
        expect(inv.paidAmountUSD).toBeNull();
        expect(inv.debtAmountUSD).toBeNull();
        expect(h.stores.invoiceItem[0].unitPriceUSD).toBeNull();
        expect(h.stores.payment[0].amountUSD).toBeNull();
        expect(h.stores.payment[0].exchangeRate).toBeNull();
    });

    it("an invalid tenant rate (0) is treated as no rate", async () => {
        seed({ rate: "0" });
        seedCustomer();
        const res = await post(body());
        expect(res.status).toBe(200);
        expect(h.stores.invoice[0].exchangeRateUsed).toBeNull();
    });

    it("the FROZEN snapshot price is used even if the live unit price changed", async () => {
        seed({ price: "1000", livePrice: "9999" });
        seedCustomer();
        const res = await post(body());
        expect(res.status).toBe(200);
        expect(eq(((await res.json()) as any).totalSYP, "3000")).toBe(true);
        expect(eq(h.stores.invoiceItem[0].unitPriceSYP, "1000")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
describe("T5c approval — customer", () => {
    it("the system cash customer is rejected (400 INVALID_CUSTOMER)", async () => {
        seed({});
        seedCustomer({ id: "cust-sys", isSystemGenerated: true });
        const res = await post(body({ customer: { mode: "EXISTING", customerId: "cust-sys" } }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).code).toBe("INVALID_CUSTOMER");
        expect(h.stores.invoice).toHaveLength(0);
    });

    it("an inactive customer and a customer of ANOTHER tenant are rejected", async () => {
        seed({});
        seedCustomer({ id: "cust-off", isActive: false });
        seedCustomer({ id: "cust-foreign", tenantId: "tenant-B" });
        let res = await post(body({ customer: { mode: "EXISTING", customerId: "cust-off" } }));
        expect(res.status).toBe(400);
        res = await post(body({ customer: { mode: "EXISTING", customerId: "cust-foreign" } }));
        expect(res.status).toBe(400);
        expect(h.stores.invoice).toHaveLength(0);
    });

    it("a merged-away customer id resolves to the survivor", async () => {
        seed({});
        seedCustomer({ id: "cust-1" });
        h.state.mergeMap = { "cust-old": "cust-1" };
        const res = await post(body({ customer: { mode: "EXISTING", customerId: "cust-old" } }));
        expect(res.status).toBe(200);
        expect(h.stores.invoice[0].customerId).toBe("cust-1");
    });

    it("NEW creates a normalized, active, non-system customer; matchedCustomerId is untouched", async () => {
        seed({ matchedCustomerId: "cust-hint" });
        const res = await post(
            body({ customer: { mode: "NEW", name: "تاجر جديد", phone: "+963 944 123 456", shopName: "محل" } })
        );
        expect(res.status).toBe(200);
        expect(h.stores.customer).toHaveLength(1);
        expect(h.stores.customer[0]).toMatchObject({
            tenantId: TENANT,
            name: "تاجر جديد",
            phone: "0944123456",
            shopName: "محل",
            offlineId: null,
            isActive: true,
            isSystemGenerated: false,
        });
        expect(h.stores.invoice[0].customerId).toBe(h.stores.customer[0].id);
        expect(h.stores.order.matchedCustomerId).toBe("cust-hint");
    });

    it("INSUFFICIENT_STOCK and INVALID_PAYMENT never create a NEW customer row", async () => {
        seed({ batches: [{ id: "batch-1", quantity: "10" }] });
        let res = await post(body({ customer: { mode: "NEW", name: "تاجر جديد", phone: "0944123456" } }));
        expect(res.status).toBe(409);
        expect(h.log.some((e) => e.model === "customer" && e.op === "create")).toBe(false);

        resetAll();
        seed({});
        res = await post(
            body({
                customer: { mode: "NEW", name: "تاجر جديد", phone: "0944123456" },
                payment: { mode: "PARTIAL", paidAmountSYP: "3000", paymentMethod: "CASH" },
            })
        );
        expect(res.status).toBe(400);
        expect(h.log.some((e) => e.model === "customer" && e.op === "create")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe("T5c approval — payment", () => {
    it("FULL_CASH: one payment row for the whole total, invoice paid", async () => {
        seed({});
        seedCustomer();
        const res = await post(body({ payment: { mode: "FULL_CASH", paymentMethod: "SHAM_CASH" } }));
        expect(res.status).toBe(200);
        expect(h.stores.payment).toHaveLength(1);
        expect(eq(h.stores.payment[0].amountSYP, "3000")).toBe(true);
        expect(h.stores.payment[0].paymentMethod).toBe("SHAM_CASH");
        expect(h.stores.payment[0].invoiceId).toBe(h.stores.invoice[0].id);
        expect(h.stores.invoice[0].isPaid).toBe(true);
        expect(eq(h.stores.invoice[0].debtAmountSYP, "0")).toBe(true);
    });

    it("PARTIAL: one payment row, debt = total - paid, invoice not fully paid", async () => {
        seed({});
        seedCustomer();
        const res = await post(body({ payment: { mode: "PARTIAL", paidAmountSYP: "1000", paymentMethod: "CASH" } }));
        expect(res.status).toBe(200);
        expect(h.stores.payment).toHaveLength(1);
        const inv = h.stores.invoice[0];
        expect(eq(inv.paidAmountSYP, "1000")).toBe(true);
        expect(eq(inv.debtAmountSYP, "2000")).toBe(true);
        expect(new Decimal(inv.totalSYP).minus(inv.paidAmountSYP).eq(inv.debtAmountSYP)).toBe(true); // ledger equation
        expect(inv.isPaid).toBe(false);
    });

    it("FULL_CREDIT ignores a stray paymentMethod and writes NO payment row", async () => {
        seed({});
        seedCustomer();
        const res = await post(body({ payment: { mode: "FULL_CREDIT", paymentMethod: "CASH" } }));
        expect(res.status).toBe(200);
        expect(h.stores.payment).toHaveLength(0);
        expect(eq(h.stores.invoice[0].debtAmountSYP, "3000")).toBe(true);
        expect(h.stores.invoice[0].isPaid).toBe(false);
    });

    it("invalid payments -> 400 INVALID_PAYMENT and nothing written", async () => {
        const invalid = [
            { mode: "PARTIAL", paidAmountSYP: "3000", paymentMethod: "CASH" }, // == total
            { mode: "PARTIAL", paidAmountSYP: "0", paymentMethod: "CASH" },
            { mode: "PARTIAL", paidAmountSYP: "1000" }, // no method
            { mode: "PARTIAL", paymentMethod: "CASH" }, // no amount
            { mode: "FULL_CASH" }, // no method
        ];
        for (const payment of invalid) {
            resetAll();
            seed({});
            seedCustomer();
            const res = await post(body({ payment }));
            expect(res.status, JSON.stringify(payment)).toBe(400);
            expect(((await res.json()) as any).code).toBe("INVALID_PAYMENT");
            expect(h.stores.invoice).toHaveLength(0);
            expect(h.stores.payment).toHaveLength(0);
        }
    });
});

// ---------------------------------------------------------------------------
describe("T5c approval — approved quantity and the retailer signal", () => {
    it("raising above the request is allowed; ONLY approvedQuantity is written on the item", async () => {
        seed({ qty: "3", batches: [{ id: "batch-1", quantity: "200" }] });
        seedCustomer();
        const before = { ...h.stores.items[0] };
        const res = await post(body({ lines: [{ itemId: "item-1", approvedQuantity: "5" }] }));
        expect(res.status).toBe(200);
        const item = h.stores.items[0];
        expect(item.approvedQuantity).toBe("5");
        expect(item.quantity).toBe(before.quantity); // the retailer's ORIGINAL request, frozen
        expect(item.priceWholesaleSnapshot).toBe(before.priceWholesaleSnapshot);
        expect(item.pricingCurrencySnapshot).toBe(before.pricingCurrencySnapshot);
        const updates = h.log.filter((e) => e.model === "b2BOrderRequestItem" && e.op === "update");
        expect(updates).toHaveLength(1); // exactly once per line
        expect(Object.keys(updates[0].data)).toEqual(["approvedQuantity"]);
        expect(eq(((await res.json()) as any).totalSYP, "5000")).toBe(true);
        expect(eq(qty("batch-1"), "80")).toBe(true); // 200 - 5 x 24
    });

    it("lowering is allowed and prices/deducts the APPROVED quantity, not the request", async () => {
        seed({ qty: "3" });
        seedCustomer();
        const res = await post(body({ lines: [{ itemId: "item-1", approvedQuantity: "2" }] }));
        expect(res.status).toBe(200);
        expect(eq(((await res.json()) as any).totalSYP, "2000")).toBe(true);
        expect(eq(qty("batch-1"), "52")).toBe(true); // 100 - 2 x 24
        expect(h.stores.items[0].quantity).toBe("3");
    });

    it("the submitted line set must match the order exactly (unknown / missing / duplicate -> 400)", async () => {
        seedTenant();
        seedOrderRow();
        addProduct({});
        addLine({ itemId: "item-1" });
        addLine({ itemId: "item-2", unitId: "unit-base", qty: "1", price: "10" });
        seedCustomer();
        const bad = [
            [{ itemId: "item-1", approvedQuantity: "1" }], // item-2 missing
            [
                { itemId: "item-1", approvedQuantity: "1" },
                { itemId: "item-1", approvedQuantity: "1" },
            ], // duplicate
            [
                { itemId: "item-1", approvedQuantity: "1" },
                { itemId: "zzz", approvedQuantity: "1" },
            ], // unknown
        ];
        for (const lines of bad) {
            const res = await post(body({ lines }));
            expect(res.status).toBe(400);
        }
        expect(h.stores.invoice).toHaveLength(0);
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
    });

    it("VerifiedRetailer: a later approval INCREMENTS the existing row", async () => {
        seed({});
        seedCustomer();
        h.stores.verifiedRetailer.push({ phone: "0944123456", verificationCount: 2 });
        const res = await post(body());
        expect(res.status).toBe(200);
        expect(h.stores.verifiedRetailer).toHaveLength(1);
        expect(h.stores.verifiedRetailer[0].verificationCount).toBe(3);
    });

    it("a retailer phone that cannot be normalized never blocks the approval (no signal row, a warning)", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        seed({ retailerPhone: "123" });
        seedCustomer();
        const res = await post(body());
        expect(res.status).toBe(200);
        expect(h.stores.invoice).toHaveLength(1);
        expect(h.stores.verifiedRetailer).toHaveLength(0);
        expect(warn).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe("T5c approval — auth and validation", () => {
    it("unauthenticated -> 401 UNAUTHORIZED, nothing touched", async () => {
        seed({});
        setSession(null);
        const res = await post(body());
        expect(res.status).toBe(401);
        expect(((await res.json()) as any).code).toBe("UNAUTHORIZED");
        expect(h.log).toHaveLength(0);
    });

    it("CASHIER -> 403 FORBIDDEN with zero writes (the tenant check is not even reached)", async () => {
        seed({});
        seedCustomer();
        setSession("CASHIER");
        const res = await post(body());
        expect(res.status).toBe(403);
        expect(((await res.json()) as any).code).toBe("FORBIDDEN");
        expect(h.log).toHaveLength(0);
        expect(h.mockWritable).not.toHaveBeenCalled();
        expect(h.stores.order.status).toBe("PENDING_REVIEW");
    });

    it("a locked tenant -> 403 TENANT_NOT_WRITABLE with zero writes", async () => {
        seed({});
        seedCustomer();
        h.mockWritable.mockRejectedValueOnce(new (SubscriptionLockedError as any)("EXPIRED"));
        const res = await post(body());
        expect(res.status).toBe(403);
        expect(((await res.json()) as any).code).toBe("TENANT_NOT_WRITABLE");
        expect(h.log).toHaveLength(0);
    });

    it("assertTenantWritable is called with the SESSION tenant", async () => {
        seed({});
        seedCustomer();
        await post(body());
        expect(h.mockWritable).toHaveBeenCalledWith(TENANT);
    });

    it("malformed JSON, empty body and oversized bodies -> 400 before any write", async () => {
        seed({});
        seedCustomer();
        for (const raw of ["{not json", "", "x".repeat(40 * 1024)]) {
            const res = await post(raw);
            expect(res.status).toBe(400);
        }
        expect(h.log).toHaveLength(0);
        expect(h.mockWritable).not.toHaveBeenCalled();
    });
});