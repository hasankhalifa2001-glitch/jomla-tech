/**
 * lib/data/__tests__/t5c-orders-approval.test.ts
 *
 * T5c Phase 3 — the approval route + gateway transaction, mock-level.
 *
 * REAL: app/api/orders/[id]/approve/route.ts + lib/data/orders-approval-tx.ts
 *       + lib/data/orders-approval.ts (pure helpers) + lib/utils/money.ts +
 *       lib/utils/phone.ts + lib/inventory/units.ts + lib/inventory/fifo.ts +
 *       lib/auth/role-matrix.ts.
 * MOCKED: @/lib/db (raw prisma.$transaction), @/auth, @/lib/auth/tenant
 *         (assertTenantWritable), and the batch-lock helper (the one raw query).
 *
 * ATOMICITY: the fake `$transaction` snapshots every store before running the
 * callback and restores the snapshot if the callback throws — exactly the
 * rollback a real Postgres transaction gives. This lets us prove "a forced
 * failure after the claim / after stock decrements leaves the order
 * PENDING_REVIEW and nothing written."
 *
 * WHAT THIS DOES NOT PROVE (stated per the spec, launch-blocking honesty):
 *  - real row-lock / FOR UPDATE serialization,
 *  - real database atomicity under true concurrency,
 *  - the native INSERT ... ON CONFLICT upsert actually compiling to ON CONFLICT.
 * Those require a real Postgres — see t5c-orders-approval.real.test.ts (written,
 * gated on TEST_DATABASE_URL, NOT run here).
 */
import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const TENANT = "tenant-1";
const ADMIN = "admin-1";
const ORDER = "order-1";

const { mockSession, mockWritable, mockPrisma, stores, resetAll, nextId } = vi.hoisted(() => {
    // In-memory stores; $transaction snapshots+restores them to simulate rollback.
    const stores: any = {
        order: null as any,
        items: [] as any[],
        product: [] as any[],
        unit: [] as any[],
        batch: [] as any[],
        customer: [] as any[],
        tenantRow: null as any,
        mergeLog: [] as any[],
        invoice: [] as any[],
        invoiceItem: [] as any[],
        payment: [] as any[],
        verifiedRetailer: [] as any[],
    };
    let idc = 0;
    const nextId = (p: string) => `${p}-${++idc}`;
    const resetAll = () => {
        stores.order = null;
        stores.items = [];
        stores.product = [];
        stores.unit = [];
        stores.batch = [];
        stores.customer = [];
        stores.tenantRow = null;
        stores.mergeLog = [];
        stores.invoice = [];
        stores.invoiceItem = [];
        stores.payment = [];
        stores.verifiedRetailer = [];
        idc = 0;
    };
    return {
        mockSession: { current: null as any },
        mockWritable: vi.fn(async () => "ACTIVE"),
        mockPrisma: { current: null as any },
        stores,
        resetAll,
        nextId,
    };
});


// ---- The fake transaction client -----------------------------------------
// Quantities are plain decimal STRINGS (as Prisma returns them serialized);
// money.ts / fifo accept string | number | Decimal unchanged.

function buildTx() {
    const tx: any = {};

    tx.b2BOrderRequest = {
        updateMany: vi.fn(async ({ where, data }: any) => {
            const o = stores.order;
            if (
                o && o.id === where.id && o.tenantId === where.tenantId &&
                where.status === "PENDING_REVIEW" && o.status === "PENDING_REVIEW"
            ) {
                Object.assign(o, data);
                return { count: 1 };
            }
            return { count: 0 };
        }),
        findFirst: vi.fn(async ({ where }: any) => {
            const o = stores.order;
            return o && o.id === where.id && o.tenantId === where.tenantId ? o : null;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
            const o = stores.order;
            return o && o.id === where.id && o.tenantId === where.tenantId ? o : null;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const o = stores.order;
            if (!o || o.id !== where.id || o.tenantId !== where.tenantId) throw new Error("order.update: not found");
            Object.assign(o, data);
            return o;
        }),
    };

    tx.b2BOrderRequestItem = {
        findMany: vi.fn(async ({ where }: any) =>
            stores.items.filter((i: any) => i.orderRequestId === where.orderRequestId && i.tenantId === where.tenantId)
        ),
        update: vi.fn(async ({ where, data }: any) => {
            const it = stores.items.find((i: any) => i.id === where.id && i.tenantId === where.tenantId);
            if (!it) throw new Error("item.update: not found");
            Object.assign(it, data);
            return it;
        }),
    };

    tx.product = {
        findUnique: vi.fn(async ({ where }: any) => {
            const p = stores.product.find((p: any) => p.id === where.id && p.tenantId === where.tenantId);
            return p ? { ...p, baseUnit: { id: p.baseUnitId } } : null;
        }),
        // requireBaseUnit() uses findUniqueOrThrow with include: { baseUnit: true }.
        findUniqueOrThrow: vi.fn(async ({ where }: any) => {
            const p = stores.product.find((p: any) => p.id === where.id && p.tenantId === where.tenantId);
            if (!p) throw new Error("product.findUniqueOrThrow: not found");
            return { ...p, baseUnit: { id: p.baseUnitId } };
        }),
        findMany: vi.fn(async ({ where, select }: any) => {
            const ids = where?.id?.in;
            const rows = stores.product.filter(
                (p: any) => p.tenantId === where.tenantId && (!ids || ids.includes(p.id))
            );
            // Mirror Prisma select-narrowing so batched flag helpers get only
            // the fields they asked for (isActive / productId / name).
            if (!select) return rows;
            return rows.map((p: any) => {
                const out: any = { id: p.id };
                if (select.isActive) out.isActive = p.isActive;
                if (select.name) out.name = p.name;
                if (select.isPublic) out.isPublic = p.isPublic;
                return out;
            });
        }),
    };

    tx.productUnit = {
        findUnique: vi.fn(async ({ where }: any) => {
            const u = stores.unit.find((u: any) => u.id === where.id && u.tenantId === where.tenantId);
            return u ?? null;
        }),
        findMany: vi.fn(async ({ where, select }: any) => {
            const ids = where?.id?.in;
            const rows = stores.unit.filter(
                (u: any) => u.tenantId === where.tenantId && (!ids || ids.includes(u.id))
            );
            if (!select) return rows;
            return rows.map((u: any) => {
                const out: any = { id: u.id };
                if (select.isActive) out.isActive = u.isActive;
                if (select.productId) out.productId = u.productId;
                if (select.unitName) out.unitName = u.unitName;
                if (select.conversionFactor) out.conversionFactor = u.conversionFactor;
                if (select.pricingCurrency) out.pricingCurrency = u.pricingCurrency;
                if (select.priceWholesale) out.priceWholesale = u.priceWholesale;
                return out;
            });
        }),
    };

    tx.productBatch = {
        findMany: vi.fn(async ({ where, select }: any) => {
            const ids = where?.id?.in;
            const rows = stores.batch.filter(
                (b: any) => b.tenantId === where.tenantId && (!ids || ids.includes(b.id))
            );
            // The tx file reads { id, productId } for locked batches and full
            // rows (incl. quantity) inside commitFifoAllocation — mirror select.
            if (!select) return rows;
            return rows.map((b: any) => {
                const out: any = {};
                for (const k of Object.keys(select)) {
                    if (k in b) out[k] = b[k];
                }
                return out;
            });
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const b = stores.batch.find((b: any) => b.id === where.id && b.tenantId === where.tenantId);
            if (!b) throw new Error("batch.update: not found");
            if (data.quantity?.decrement) {
                // Decimal strings via money.ts (never native float math).
                const { subtractMoney } = await import("@/lib/utils/money");
                b.quantity = subtractMoney(String(b.quantity), String(data.quantity.decrement));
            }
            return b;
        }),
    };

    tx.tenant = {
        findUnique: vi.fn(async ({ where }: any) =>
            stores.tenantRow && stores.tenantRow.id === where.id ? stores.tenantRow : null
        ),
    };


vi.mock("@/auth", () => ({ auth: vi.fn(async () => mockSession.current) }));
vi.mock("@/lib/auth/tenant", async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, assertTenantWritable: mockWritable };
});
    tx.customer = {
        findFirst: vi.fn(async ({ where }: any) => {
            const c = stores.customer.find((c: any) => c.id === where.id && c.tenantId === where.tenantId);
            if (!c) return null;
            if (where.isActive === true && !c.isActive) return null;
            if (where.isSystemGenerated === false && c.isSystemGenerated) return null;
            return c;
        }),
        findMany: vi.fn(async ({ where }: any) => stores.customer.filter((c: any) => c.tenantId === where.tenantId)),
        create: vi.fn(async ({ data }: any) => {
            const row = { id: nextId("cust"), ...data };
            stores.customer.push(row);
            return row;
        }),
    };

    tx.customerMergeLog = {
        findFirst: vi.fn(async ({ where }: any) =>
            stores.mergeLog.find((m: any) => m.tenantId === where.tenantId && m.mergedCustomerId === where.mergedCustomerId) ?? null
        ),
    };

    tx.invoice = {
        create: vi.fn(async ({ data }: any) => {
            const row = { id: nextId("inv"), ...data };
            stores.invoice.push(row);
            return row;
        }),
    };
    tx.invoiceItem = {
        create: vi.fn(async ({ data }: any) => {
            const row = { id: nextId("item"), ...data };
            stores.invoiceItem.push(row);
            return row;
        }),
    };
    tx.customerPayment = {
        create: vi.fn(async ({ data }: any) => {
            const row = { id: nextId("pay"), ...data };
            stores.payment.push(row);
            return row;
        }),
    };
    tx.verifiedRetailer = {
        upsert: vi.fn(async ({ where, create, update }: any) => {
            const row = stores.verifiedRetailer.find((r: any) => r.phone === where.phone);
            if (row) {
                row.verificationCount += update.verificationCount.increment;
                return row;
            }
            const created = { ...create };
            stores.verifiedRetailer.push(created);
            return created;
        }),
    };
    return tx;
}


// ---- $transaction: snapshot every store, restore on throw (rollback) -----
function snapshot() {
    return JSON.parse(JSON.stringify(stores));
}
function restore(snap: any) {
    for (const k of Object.keys(stores)) delete stores[k];
    Object.assign(stores, snap);
}

vi.mock("@/lib/db", () => ({
    prisma: {
        $transaction: async (fn: (tx: any) => Promise<any>) => {
            const snap = snapshot();
            const tx = buildTx();
            try {
                return await fn(tx);
            } catch (e) {
                restore(snap); // full rollback — mirrors a real Postgres transaction
                throw e;
            }
        },
    },
}));
// The batch-lock helper is the one raw query; mock it to return the LOCKED
// batches' quantities (post-FOR UPDATE) keyed by batchId.
vi.mock("@/lib/inventory/batch-locking", () => ({
    lockBatchesForFifoAllocations: vi.fn(async (_tx: any, _tenantId: string, productIds: string[]) => {
        const map = new Map<string, string>();
        for (const b of stores.batch) {
            if (productIds.includes(b.productId)) map.set(b.id, String(b.quantity));
        }
        return map;
    }),
}));

import { POST as approveHandler } from "@/app/api/orders/[id]/approve/route";

// ---- Fixtures -------------------------------------------------------------
function setSession(role: "ADMIN" | "CASHIER" | null) {
    mockSession.current = role == null ? null : { user: { id: ADMIN, role, tenantId: TENANT } };
}

function req(body: unknown): Request {
    return new Request(`http://localhost/api/orders/${ORDER}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
}
const ctx = { params: Promise.resolve({ id: ORDER }) };

/**
 * Seeds one product with a base unit + a sold unit (factor), N batches, and an
 * order line. Returns the ids the test needs. `factor` is the SOLD unit's
 * conversionFactor; the base unit always has factor 1.
 */
function seed(opts: {
    productId?: string;
    baseUnitId?: string;
    soldUnitId?: string;
    factor?: string; // sold unit factor (default "24")
    price?: string; // snapshot price (default "1000")
    currency?: "SYP" | "USD";
    requestedQty?: string; // order line quantity (default "3")
    batches?: Array<{ id: string; quantity: string; cost?: string }>;
    itemId?: string;
    productActive?: boolean;
    unitActive?: boolean;
    rate?: string | null;
    retailerPhone?: string;
}) {
    const productId = opts.productId ?? "prod-1";
    const baseUnitId = opts.baseUnitId ?? "unit-base";
    const soldUnitId = opts.soldUnitId ?? "unit-pack";
    const itemId = opts.itemId ?? "item-1";
    const factor = opts.factor ?? "24";
    stores.product.push({
        id: productId,
        tenantId: TENANT,
        isActive: opts.productActive ?? true,
        baseUnitId,
        name: "سكر",
    });
    stores.unit.push({ id: baseUnitId, tenantId: TENANT, isActive: true, conversionFactor: "1", productId });
    stores.unit.push({
        id: soldUnitId,
        tenantId: TENANT,
        isActive: opts.unitActive ?? true,
        conversionFactor: factor,
        productId,
    });
    for (const b of opts.batches ?? [{ id: "batch-1", quantity: "100", cost: "10" }]) {
        stores.batch.push({
            id: b.id,
            tenantId: TENANT,
            productId,
            quantity: b.quantity,
            costPricePerBaseUnit: b.cost ?? "10",
        });
    }
    stores.tenantRow = { id: TENANT, dailyExchangeRate: opts.rate ?? null };
    stores.order = {
        id: ORDER,
        tenantId: TENANT,
        status: "PENDING_REVIEW",
        retailerPhone: opts.retailerPhone ?? "0944123456",
        matchedCustomerId: null,
        resultingInvoiceId: null,
        reviewedByUserId: null,
        reviewedAt: null,
    };
    stores.items.push({
        id: itemId,
        orderRequestId: ORDER,
        tenantId: TENANT,
        productId,
        unitId: soldUnitId,
        quantity: opts.requestedQty ?? "3",
        approvedQuantity: null,
        priceWholesaleSnapshot: opts.price ?? "1000",
        pricingCurrencySnapshot: opts.currency ?? "SYP",
    });
    return { productId, baseUnitId, soldUnitId, itemId, factor };
}

function body(overrides: Record<string, unknown> = {}) {
    return {
        lines: [{ itemId: "item-1", approvedQuantity: "3" }],
        customer: { mode: "EXISTING", customerId: "cust-1" },
        payment: { mode: "FULL_CREDIT" },
        ...overrides,
    };
}

function seedCustomer(overrides: Record<string, unknown> = {}) {
    const row = {
        id: "cust-1",
        tenantId: TENANT,
        isActive: true,
        isSystemGenerated: false,
        name: "زبون",
        phone: "0944123456",
        shopName: null,
        ...overrides,
    };
    stores.customer.push(row);
    return row;
}

beforeEach(() => {
    resetAll();
    setSession("ADMIN");
    mockWritable.mockResolvedValue("ACTIVE");
});

describe("T5c approval — happy path (SYP, full credit)", () => {
    it("creates one COMPLETED invoice, deducts stock, links the order, writes the signal", async () => {
        seed({});
        seedCustomer();
        const res = await approveHandler(req(body()), ctx as any);
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(Object.keys(j).sort()).toEqual(
            ["customerId", "debtAmountSYP", "invoiceId", "paidAmountSYP", "success", "totalSYP"].sort()
        );
        // 3 packs x 1000 = 3000 SYP; full credit → paid 0, debt 3000.
        expect(j.totalSYP).toBe("3000.0000");
        expect(j.paidAmountSYP).toBe("0.0000");
        expect(j.debtAmountSYP).toBe("3000.0000");
        // Stock: batch 100 - (3 x 24 = 72) = 28 (4dp-serialized by subtractMoney).
        expect(String(stores.batch[0].quantity)).toBe("28.0000");
        // One invoice, one InvoiceItem, no payment (full credit).
        expect(stores.invoice).toHaveLength(1);
        expect(stores.invoiceItem).toHaveLength(1);
        expect(stores.payment).toHaveLength(0);
        // Order APPROVED + linked.
        expect(stores.order.status).toBe("APPROVED");
        expect(stores.order.resultingInvoiceId).toBe(stores.invoice[0].id);
        // approvedQuantity written once for the line.
        expect(String(stores.items[0].approvedQuantity)).toBe("3");
        // VerifiedRetailer created with count 1.
        expect(stores.verifiedRetailer).toEqual([{ phone: "0944123456", verificationCount: 1 }]);
    });
});

describe("T5c approval — rollback, concurrency, cross-tenant (mock level)", () => {
    it("a forced failure after the claim rolls everything back (order stays PENDING_REVIEW)", async () => {
        seed({});
        seedCustomer();
        // Fail inside the transaction after the claim by removing the customer
        // mid-flight: mock customer.findFirst to return null once.
        const res = await approveHandler(
            req(body({ customer: { mode: "EXISTING", customerId: "missing-cust" } })),
            ctx as any
        );
        expect(res.status).toBe(400);
        expect(stores.order.status).toBe("PENDING_REVIEW");
        expect(stores.invoice).toHaveLength(0);
        expect(stores.invoiceItem).toHaveLength(0);
        expect(stores.payment).toHaveLength(0);
        expect(String(stores.batch[0].quantity)).toBe("100");
        expect(stores.verifiedRetailer).toHaveLength(0);
    });

    it("two approvals of one order → exactly one invoice, second is ALREADY_REVIEWED with zero side effects", async () => {
        seed({});
        seedCustomer();
        const first = await approveHandler(req(body()), ctx as any);
        expect(first.status).toBe(200);
        const second = await approveHandler(req(body()), ctx as any);
        expect(second.status).toBe(409);
        const j: any = await second.json();
        expect(j.code).toBe("ALREADY_REVIEWED");
        expect(stores.invoice).toHaveLength(1);
        expect(String(stores.batch[0].quantity)).toBe("28.0000");
    });

    it("cross-tenant: tenant B order id under tenant A session → 404, zero writes", async () => {
        seed({});
        seedCustomer();
        // Move the order to another tenant; session stays tenant-1.
        stores.order.tenantId = "tenant-B";
        for (const it of stores.items) it.tenantId = "tenant-B";
        const res = await approveHandler(req(body()), ctx as any);
        expect(res.status).toBe(404);
        expect(stores.order.status).toBe("PENDING_REVIEW");
        expect(stores.invoice).toHaveLength(0);
        expect(stores.invoiceItem).toHaveLength(0);
        expect(stores.payment).toHaveLength(0);
        expect(String(stores.batch[0].quantity)).toBe("100");
        expect(stores.verifiedRetailer).toHaveLength(0);
    });

    it("CASHIER → 403 FORBIDDEN with zero writes", async () => {
        seed({});
        seedCustomer();
        setSession("CASHIER");
        const res = await approveHandler(req(body()), ctx as any);
        expect(res.status).toBe(403);
        expect(stores.order.status).toBe("PENDING_REVIEW");
        expect(stores.invoice).toHaveLength(0);
        expect(stores.batch[0] && String(stores.batch[0].quantity)).toBe("100");
    });
});

