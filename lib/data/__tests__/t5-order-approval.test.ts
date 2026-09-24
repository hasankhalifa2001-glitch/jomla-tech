/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";

/**
 * T5 — B2B Order Approval Queue → Approval.
 *
 * Regression suite for the launch-blocking gap this file was written against:
 * PATCH /api/orders/[id]/status used to ONLY flip B2BOrderRequest.status. No
 * commitFifoAllocation, no batch locks, no Invoice / InvoiceItem, no
 * ProductBatch decrement, no CustomerPayment, no resultingInvoiceId — so
 * approving an order had zero financial or inventory effect.
 *
 * REAL here (not mocked):
 *   - app/api/orders/[id]/status/route.ts — the handler under test.
 *   - lib/inventory/units.ts — so the sold-unit → base-unit conversion is the
 *     genuine one, asserted against an independent decimal.js reference.
 *   - lib/utils/money.ts — real decimal arithmetic for every figure.
 *   - lib/customers/resolve-active.ts and lib/auth/role-matrix.ts.
 *
 * MOCKED only where a real call needs a real database: the Prisma boundary
 * (`@/lib/db`'s raw client), batch locking, and the FIFO allocator (whose own
 * algorithm is covered by lib/inventory/__tests__/t3b-fifo.test.ts). The FIFO
 * mock returns a DETERMINISTIC two-batch split, so this file still exercises
 * how the route maps allocations → InvoiceItems → batch decrements.
 */

const {
  mockSessionState,
  mockAssertTenantWritable,
  callLog,
  fakeDb,
  lockSpy,
  fifoSpy,
  lockImpl,
  fifoImpl,
  productUnitModel,
} = vi.hoisted(() => {
  const callLog: string[] = [];

  function defaultOrderItem() {
    return {
      productId: "prod-1",
      unitId: "unit-carton",
      quantity: "3",
      priceWholesaleSnapshot: "50000.0000",
      pricingCurrencySnapshot: "SYP",
    };
  }

  function defaultAllocations() {
    return [
      {
        batchId: "batch-1",
        batchNumber: "B1",
        expiryDate: null,
        allocatedQty: "48.0000",
        deductQtyInBatchUnit: "48.0000",
        batchUnitId: "unit-base",
        batchUnitName: "قطعة",
      },
      {
        batchId: "batch-2",
        batchNumber: "B2",
        expiryDate: null,
        allocatedQty: "24.0000",
        deductQtyInBatchUnit: "24.0000",
        batchUnitId: "unit-base",
        batchUnitName: "قطعة",
      },
    ];
  }

  // Named as a standalone identifier (not reached as `.productUnit`) — this
  // codebase's PRODUCT_MODEL_RULES ban member access to `.product`/`.productUnit`
  // outside lib/data/products.ts, and every existing test follows the same
  // `fakeProductUnit`-style naming.
  const productUnitModel = {
    findUniqueOrThrow: vi.fn(async () => ({ conversionFactor: "24" })),
  };

  const fakeTx: any = {
    b2BOrderRequest: {
      findFirst: vi.fn(),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    b2BOrderRequestItem: { findMany: vi.fn(async () => [defaultOrderItem()]) },
    tenant: { findUnique: vi.fn(async () => ({ dailyExchangeRate: "15000.0000" })) },
    customer: {
      findFirst: vi.fn(async () => ({ isSystemGenerated: false })),
      create: vi.fn(async () => {
        callLog.push("customer.create");
        return { id: "cust-created" };
      }),
    },
    customerMergeLog: { findFirst: vi.fn(async () => null) },
    invoice: {
      create: vi.fn(async () => {
        callLog.push("invoice.create");
        return { id: "inv-1" };
      }),
    },
    invoiceItem: {
      create: vi.fn(async (args: any) => {
        callLog.push(`invoiceItem.create:${args?.data?.unitId}:${args?.data?.quantity}`);
        return {};
      }),
    },
    productBatch: {
      update: vi.fn(async (args: any) => {
        callLog.push(`batch-decrement:${args?.where?.id}:${args?.data?.quantity?.decrement}`);
        return {};
      }),
    },
    customerPayment: {
      create: vi.fn(async () => {
        callLog.push("customerPayment.create");
        return {};
      }),
    },
    productUnit: productUnitModel,
  };

  // Base implementations are extracted so beforeEach can reset the spies (and
  // their queued *Once values) and then restore these exact behaviours.
  const lockImpl = async (_tx: any, _tenantId: string, productIds: string[]) => {
    callLog.push(`lock:${productIds.join(",")}`);
    return new Map();
  };
  const lockSpy = vi.fn(lockImpl);

  const fifoImpl = async (_tx: any, args: any) => {
    callLog.push(`fifo:${args?.productId}:${args?.unitId}:${args?.requestedQty}`);
    return {
      productId: args?.productId,
      requestedUnitId: args?.unitId,
      requestedUnitName: "قطعة",
      requestedQty: args?.requestedQty,
      totalAllocatedQty: args?.requestedQty,
      remainingQty: "0",
      isSufficient: true,
      allocations: defaultAllocations(),
    };
  };
  const fifoSpy = vi.fn(fifoImpl);

  return {
    mockSessionState: {
      current: {
        user: {
          id: "admin-user-1",
          email: "admin@test.com",
          role: "ADMIN" as string,
          tenantId: "tenant-1",
        },
      },
    },
    mockAssertTenantWritable: vi.fn(async () => "ACTIVE"),
    callLog,
    fakeDb: {
      ...fakeTx,
      $transaction: vi.fn(async (cb: any) => cb(fakeTx)),
    },
    lockSpy,
    fifoSpy,
    lockImpl,
    fifoImpl,
    productUnitModel,
  };
});

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.current),
}));

vi.mock("@/lib/auth/tenant", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, assertTenantWritable: mockAssertTenantWritable };
});

// The route is a category-5 call site: it reaches persistence through the RAW
// client, because lockBatchesForFifoAllocations() is typed to accept exactly
// Prisma.TransactionClient.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, prisma: fakeDb };
});

vi.mock("@/lib/inventory/batch-locking", () => ({
  lockBatchesForFifoAllocations: lockSpy,
}));

vi.mock("@/lib/inventory/fifo", () => ({
  commitFifoAllocation: fifoSpy,
}));

// requireBaseUnit is REAL in production, but here it would query Product /
// ProductUnit rows this fake tx does not model. The route only uses its id (the
// conversionFactor always comes from the ORDERED unit's own row via the real
// getUnitConversionFactor), so stubbing it cannot mask a conversion bug.
vi.mock("@/lib/inventory/base-unit", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    requireBaseUnit: vi.fn(async () => ({
      id: "unit-base",
      unitName: "قطعة",
      conversionFactor: "1",
    })),
  };
});

import { PATCH as orderStatusPatch } from "@/app/api/orders/[id]/status/route";

const TENANT_ID = "tenant-1";
const ADMIN_ID = "admin-user-1";
const ORDER_ID = "order-1";
const SURVIVOR = "cust-survivor";
// What fakeTx.customer.create resolves — the Customer the route builds from a
// first-time submission's retailer details when matchedCustomerId is null.
const NEW_CUSTOMER_ID = "cust-created";
const ITEM_TOTAL_SYP = "150000.0000";

function makeRequest(body: unknown) {
  return new Request(`http://localhost/api/orders/${ORDER_ID}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: ORDER_ID });

function setSession(role: "ADMIN" | "CASHIER") {
  mockSessionState.current = {
    user: { id: ADMIN_ID, email: "admin@test.com", role, tenantId: TENANT_ID },
  };
}

function orderItem(overrides: Record<string, unknown> = {}) {
  return {
    productId: "prod-1",
    unitId: "unit-carton",
    quantity: "3",
    priceWholesaleSnapshot: "50000.0000",
    pricingCurrencySnapshot: "SYP",
    ...overrides,
  };
}

function allocationsFor(totalBaseQty: string) {
  return [
    {
      batchId: "batch-1",
      batchNumber: "B1",
      expiryDate: null,
      allocatedQty: totalBaseQty,
      deductQtyInBatchUnit: totalBaseQty,
      batchUnitId: "unit-base",
      batchUnitName: "قطعة",
    },
  ];
}

/** Re-establishes the happy-path dependencies for an APPROVED review. */
function arrangeApprovableOrder(
  options: {
    matchedCustomerId?: string | null;
    retailerName?: string | null;
    retailerPhone?: string | null;
    retailerShopName?: string | null;
    items?: any[];
    rate?: string;
    isSystemGenerated?: boolean;
  } = {}
) {
  fakeDb.b2BOrderRequest.findFirst.mockResolvedValueOnce({
    id: ORDER_ID,
    status: "PENDING_REVIEW",
    matchedCustomerId:
      options.matchedCustomerId === undefined ? SURVIVOR : options.matchedCustomerId,
    // B2BOrderRequest carries the retailer's details directly — "most
    // first-time submitters have no Customer row yet" (T5 spec), so these are
    // what the route builds a new Customer from when matchedCustomerId null.
    retailerName: options.retailerName === undefined ? "أحمد الجملة" : options.retailerName,
    retailerPhone: options.retailerPhone === undefined ? "0999123456" : options.retailerPhone,
    retailerShopName:
      options.retailerShopName === undefined ? "بقالة السلام" : options.retailerShopName,
  });
  fakeDb.b2BOrderRequestItem.findMany.mockResolvedValueOnce([
    ...(options.items ?? [orderItem()]),
  ]);
  fakeDb.tenant.findUnique.mockResolvedValueOnce({
    dailyExchangeRate: options.rate ?? "15000.0000",
  });
  fakeDb.customer.findFirst.mockResolvedValueOnce({
    isSystemGenerated: options.isSystemGenerated ?? false,
  });
}

const invoiceData = () => fakeDb.invoice.create.mock.calls[0][0].data;
const invoiceItemsData = () =>
  fakeDb.invoiceItem.create.mock.calls.map((c: any) => c[0].data);
const decrements = () =>
  fakeDb.productBatch.update.mock.calls.map((c: any) => ({
    id: c[0].where.id,
    qty: c[0].data.quantity.decrement,
  }));
const paymentData = () => fakeDb.customerPayment.create.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  setSession("ADMIN");

  // clearAllMocks() clears CALLS but leaves queued *Once values and any
  // mockImplementation behind, so the read-side mocks and the two inventory
  // spies are explicitly reset and then re-primed. Without this, an
  // unconsumed *Once from one test can silently answer the next test's call.
  fakeDb.b2BOrderRequest.findFirst.mockReset();
  fakeDb.b2BOrderRequest.updateMany.mockReset();
  fakeDb.b2BOrderRequestItem.findMany.mockReset();
  fakeDb.tenant.findUnique.mockReset();
  fakeDb.customer.findFirst.mockReset();
  fakeDb.customer.create.mockReset();
  fakeDb.customerMergeLog.findFirst.mockReset();
  lockSpy.mockReset();
  fifoSpy.mockReset();
  productUnitModel.findUniqueOrThrow.mockReset();

  lockSpy.mockImplementation(lockImpl);
  fifoSpy.mockImplementation(fifoImpl);
  productUnitModel.findUniqueOrThrow.mockResolvedValue({ conversionFactor: "24" });

  fakeDb.b2BOrderRequest.findFirst.mockResolvedValue(null);
  fakeDb.b2BOrderRequest.updateMany.mockResolvedValue({ count: 1 });
  fakeDb.b2BOrderRequestItem.findMany.mockResolvedValue([orderItem()]);
  fakeDb.tenant.findUnique.mockResolvedValue({ dailyExchangeRate: "15000.0000" });
  fakeDb.customer.findFirst.mockResolvedValue({ isSystemGenerated: false });
  fakeDb.customer.create.mockResolvedValue({ id: NEW_CUSTOMER_ID });
  fakeDb.customerMergeLog.findFirst.mockResolvedValue(null);
});

/** A FIFO resolution shape, for per-test overrides of the allocator. */
function fifoResult(requestedQty: string, allocations: any[], extra: Record<string, unknown> = {}) {
  return {
    productId: "prod-1",
    requestedUnitId: "unit-base",
    requestedUnitName: "قطعة",
    requestedQty,
    totalAllocatedQty: requestedQty,
    remainingQty: "0",
    isSufficient: true,
    allocations,
    ...extra,
  };
}

describe("T5 — approving a B2B order does the real work (regression: it used to only flip status)", () => {
  it("creates the Invoice, one InvoiceItem per FIFO allocation, decrements stock, and links resultingInvoiceId", async () => {
    arrangeApprovableOrder();

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      orderId: ORDER_ID,
      status: "APPROVED",
      invoiceId: "inv-1",
      itemsCount: 2,
    });

    // 1. Batches locked ONCE, for every product on the order, BEFORE any
    //    allocation or write (T1's global ORDER BY id ASC rule).
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(lockSpy.mock.calls[0][1]).toBe(TENANT_ID);
    expect(lockSpy.mock.calls[0][2]).toEqual(["prod-1"]);
    expect(callLog.indexOf("lock:prod-1")).toBeLessThan(callLog.indexOf("invoice.create"));

    // 2. The ordered quantity (3 cartons) was converted using the ORDERED
    //    unit's own factor (24) → 72 base units, and the allocator was asked
    //    for the product's BASE unit id — never the ordered unit's.
    expect(fifoSpy).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT_ID,
      productId: "prod-1",
      unitId: "unit-base",
      requestedQty: "72",
    });

    // 3. The Invoice — the row the ledger and every statement read.
    expect(fakeDb.invoice.create).toHaveBeenCalledTimes(1);
    expect(invoiceData()).toMatchObject({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      customerId: SURVIVOR,
      exchangeRateUsed: "15000.0000",
      totalSYP: ITEM_TOTAL_SYP,
      totalUSD: "10.0000",
      paidAmountSYP: "0.0000",
      debtAmountSYP: ITEM_TOTAL_SYP,
      isPaid: false,
      status: "COMPLETED",
      isSynced: true,
    });

    // 4. One InvoiceItem per FIFO allocation, in the SOLD unit, at the frozen
    //    snapshot price: 48 base = 2 cartons, 24 base = 1 carton.
    expect(fakeDb.invoiceItem.create).toHaveBeenCalledTimes(2);
    expect(invoiceItemsData()).toEqual([
      expect.objectContaining({
        unitId: "unit-carton",
        batchId: "batch-1",
        quantity: "2.0000",
        unitPriceSYP: "50000.0000",
        unitPriceUSD: "3.3333",
      }),
      expect.objectContaining({
        unitId: "unit-carton",
        batchId: "batch-2",
        quantity: "1.0000",
        unitPriceSYP: "50000.0000",
        unitPriceUSD: "3.3333",
      }),
    ]);

    // 5. Stock decremented in BASE units, against the allocated batches only.
    expect(decrements()).toEqual([
      { id: "batch-1", qty: "48.0000" },
      { id: "batch-2", qty: "24.0000" },
    ]);

    // 6. No payment captured → no CustomerPayment row.
    expect(fakeDb.customerPayment.create).not.toHaveBeenCalled();

    // 7. The request points at its invoice — the field that previously had no
    //    writer anywhere in the codebase.
    expect(fakeDb.b2BOrderRequest.update).toHaveBeenCalledWith({
      where: { id: ORDER_ID, tenantId: TENANT_ID },
      data: { resultingInvoiceId: "inv-1" },
    });
  });
});

describe("T5 — approval pricing and unit conversion", () => {
  it("converts the ordered quantity via its OWN unit's factor (independent reference: 2.5 × 3.3 = 8.25)", async () => {
    arrangeApprovableOrder({ items: [orderItem({ unitId: "unit-frac", quantity: "2.5" })] });
    productUnitModel.findUniqueOrThrow.mockResolvedValueOnce({ conversionFactor: "3.3" });
    fifoSpy.mockResolvedValueOnce(fifoResult("8.25", allocationsFor("8.25")));

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    expect(res.status).toBe(200);

    // The reference below is computed here, never read back out of the route.
    expect(fifoSpy.mock.calls[0][1].requestedQty).toBe(
      new Decimal("2.5").times(new Decimal("3.3")).toString()
    );
    expect(fifoSpy.mock.calls[0][1].requestedQty).toBe("8.25");

    // Sold-unit figure on the InvoiceItem (8.25 base ÷ 3.3) and the base-unit
    // figure applied to the batch stay distinct, exactly as on a synced sale.
    expect(invoiceItemsData()[0].quantity).toBe("2.5000");
    expect(decrements()).toEqual([{ id: "batch-1", qty: "8.25" }]);
  });

  it("prices a USD-denominated snapshot into both currencies", async () => {
    arrangeApprovableOrder({
      items: [
        orderItem({ priceWholesaleSnapshot: "10.0000", pricingCurrencySnapshot: "USD" }),
      ],
    });

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    expect(res.status).toBe(200);

    // 3 × 10 USD = 30 USD ⇒ 450,000 SYP at the tenant's 15,000 rate.
    expect(invoiceItemsData()[0].unitPriceUSD).toBe("10.0000");
    expect(invoiceItemsData()[0].unitPriceSYP).toBe("150000.0000");
    expect(invoiceData().totalSYP).toBe("450000.0000");
    expect(invoiceData().totalUSD).toBe("30.0000");
  });
});

describe("T5 — optional payment capture on approval", () => {
  it("records a CustomerPayment for a partial payment and reduces the invoice debt", async () => {
    arrangeApprovableOrder();

    const res = await orderStatusPatch(
      makeRequest({
        status: "APPROVED",
        paidAmountSYP: "50000.0000",
        paymentMethod: "CASH",
        receiptNo: "  R-1  ",
        notes: "دفعة أولى",
      }),
      { params }
    );
    expect(res.status).toBe(200);

    expect(invoiceData()).toMatchObject({
      paidAmountSYP: "50000.0000",
      paidAmountUSD: "3.3333",
      debtAmountSYP: "100000.0000",
      debtAmountUSD: "6.6667",
      isPaid: false,
    });

    expect(fakeDb.customerPayment.create).toHaveBeenCalledTimes(1);
    expect(paymentData()).toMatchObject({
      tenantId: TENANT_ID,
      customerId: SURVIVOR,
      // 1:1 with the invoice via CustomerPayment.invoiceId @unique.
      invoiceId: "inv-1",
      amountSYP: "50000.0000",
      amountUSD: "3.3333",
      exchangeRate: "15000.0000",
      paymentMethod: "CASH",
      receiptNo: "R-1",
      notes: "دفعة أولى",
      isSynced: true,
    });
  });

  it("marks a fully-paid order isPaid with zero debt", async () => {
    arrangeApprovableOrder();

    const res = await orderStatusPatch(
      makeRequest({
        status: "APPROVED",
        paidAmountSYP: ITEM_TOTAL_SYP,
        paymentMethod: "BANK_TRANSFER",
      }),
      { params }
    );
    expect(res.status).toBe(200);

    expect(invoiceData()).toMatchObject({
      paidAmountSYP: "150000.0000",
      debtAmountSYP: "0.0000",
      debtAmountUSD: "0.0000",
      isPaid: true,
    });
    expect(paymentData().amountSYP).toBe("150000.0000");
  });

  it("rejects a paid amount larger than the order total — no invoice, no payment, no stock movement", async () => {
    arrangeApprovableOrder();

    const res = await orderStatusPatch(
      makeRequest({
        status: "APPROVED",
        paidAmountSYP: "200000.0000",
        paymentMethod: "CASH",
      }),
      { params }
    );
    expect(res.status).toBe(400);

    // The whole transaction rolled back: the claim, the allocation and every
    // write inside it are gone together.
    expect(fakeDb.invoice.create).not.toHaveBeenCalled();
    expect(fakeDb.invoiceItem.create).not.toHaveBeenCalled();
    expect(fakeDb.customerPayment.create).not.toHaveBeenCalled();
    expect(fakeDb.productBatch.update).not.toHaveBeenCalled();
    expect(fifoSpy).not.toHaveBeenCalled();
  });

  it("requires a payment method whenever a paid amount is supplied (validation, before any transaction)", async () => {
    arrangeApprovableOrder();

    const res = await orderStatusPatch(
      makeRequest({ status: "APPROVED", paidAmountSYP: "50000.0000" }),
      { params }
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toBe("يجب تحديد طريقة الدفع عند تسجيل مبلغ مدفوع.");
    expect(fakeDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("T5 — approval guards (no silent, partial or duplicated effects)", () => {
  it("creates a real Customer from the order's retailer details when matchedCustomerId is null, and invoices it", async () => {
    // The ordinary first-time-submission case: the retailer has no Customer
    // row yet, so matchedCustomerId is null and the request itself carries the
    // details the new Customer must be built from. T5 spec: "customerId is
    // either the order's matchedCustomerId or a newly created real Customer
    // (never the system-generated cash customer, since a B2B invoice is
    // expected to carry debt in the ordinary case)".
    arrangeApprovableOrder({
      matchedCustomerId: null,
      retailerName: "  أحمد الجملة ",
      retailerPhone: " 0999123456 ",
      retailerShopName: " بقالة السلام ",
    });

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "APPROVED", invoiceId: "inv-1" });

    // 1. A top-level Customer write inside the transaction: a real (never
    //    system-generated) Customer built from the order's own retailer fields,
    //    trimmed.
    expect(fakeDb.customer.create).toHaveBeenCalledTimes(1);
    expect(fakeDb.customer.create.mock.calls[0][0]).toEqual({
      data: {
        tenantId: TENANT_ID,
        name: "أحمد الجملة",
        phone: "0999123456",
        shopName: "بقالة السلام",
        isSystemGenerated: false,
      },
      select: { id: true },
    });

    // 2. The claim freezes that new id onto the order as matchedCustomerId.
    expect(fakeDb.b2BOrderRequest.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, tenantId: TENANT_ID, status: "PENDING_REVIEW" },
      data: {
        status: "APPROVED",
        matchedCustomerId: NEW_CUSTOMER_ID,
        reviewedByUserId: ADMIN_ID,
        reviewedAt: expect.any(Date),
      },
    });

    // 3. The resulting Invoice is charged to the NEW customer...
    expect(invoiceData().customerId).toBe(NEW_CUSTOMER_ID);

    // 4. ...and the rest of the flow ran as on any approval: the Customer was
    //    created before any FIFO/Invoice work, stock moved, and the invoice was
    //    linked back onto the request.
    expect(callLog.indexOf("customer.create")).toBeLessThan(callLog.indexOf("invoice.create"));
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(decrements()).toEqual([
      { id: "batch-1", qty: "48.0000" },
      { id: "batch-2", qty: "24.0000" },
    ]);
    expect(fakeDb.b2BOrderRequest.update).toHaveBeenCalledWith({
      where: { id: ORDER_ID, tenantId: TENANT_ID },
      data: { resultingInvoiceId: "inv-1" },
    });
  });

  it("charges the optional CustomerPayment to the newly created customer too", async () => {
    arrangeApprovableOrder({ matchedCustomerId: null });

    const res = await orderStatusPatch(
      makeRequest({ status: "APPROVED", paidAmountSYP: "50000.0000", paymentMethod: "CASH" }),
      { params }
    );
    expect(res.status).toBe(200);

    expect(fakeDb.customerPayment.create).toHaveBeenCalledTimes(1);
    expect(paymentData()).toMatchObject({
      customerId: NEW_CUSTOMER_ID,
      invoiceId: "inv-1",
      amountSYP: "50000.0000",
      paymentMethod: "CASH",
    });
    expect(invoiceData().customerId).toBe(NEW_CUSTOMER_ID);
  });

  it("refuses to approve when the order carries no retailer name to build a Customer from — nothing is written", async () => {
    // retailerName is NOT NULL in the Prisma schema, but an EMPTY string is
    // still possible: the public POST /api/store/orders submission endpoint is
    // an unvalidated placeholder (no zod schema yet), so nothing rejects a
    // blank name at submission time. This is the only remaining case where
    // Invoice.customerId genuinely cannot be satisfied.
    arrangeApprovableOrder({ matchedCustomerId: null, retailerName: "   " });

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.message).toContain("قبل ربطه بزبون");
    // Guarded BEFORE the claim and before any Customer/Invoice write, so the
    // order is still reviewable.
    expect(fakeDb.customer.create).not.toHaveBeenCalled();
    expect(fakeDb.b2BOrderRequest.updateMany).not.toHaveBeenCalled();
    expect(fakeDb.invoice.create).not.toHaveBeenCalled();
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it("refuses to park a debt on the tenant's system-generated cash customer", async () => {
    arrangeApprovableOrder({ isSystemGenerated: true });

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("النقدي العام");

    expect(fakeDb.invoice.create).not.toHaveBeenCalled();
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it("rejects a second, concurrent approval (claim count 0) without creating a second invoice", async () => {
    arrangeApprovableOrder();
    // The row was already claimed by the other admin between our read and our
    // claim — exactly the race the conditional updateMany exists to catch.
    fakeDb.b2BOrderRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    expect(res.status).toBe(400);

    expect(fakeDb.invoice.create).not.toHaveBeenCalled();
    expect(fifoSpy).not.toHaveBeenCalled();
    expect(fakeDb.productBatch.update).not.toHaveBeenCalled();
  });

  it("refuses to approve when the tenant has no daily exchange rate", async () => {
    arrangeApprovableOrder({ rate: "" });

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("سعر الصرف اليومي");

    expect(fakeDb.invoice.create).not.toHaveBeenCalled();
  });

  it("allocates a shortfall against the last candidate batch instead of blocking (mirrors the sync engine)", async () => {
    arrangeApprovableOrder();
    fifoSpy.mockResolvedValueOnce(
      fifoResult("72", allocationsFor("48.0000"), {
        remainingQty: "24.0000",
        isSufficient: false,
      })
    );

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    expect(res.status).toBe(200);

    // The shortfall is drawn from the same last batch the allocator offered,
    // in base units — 2 + 1 cartons = the 3 ordered.
    expect(invoiceItemsData().map((d: any) => d.quantity)).toEqual(["2.0000", "1.0000"]);
    expect(decrements()).toEqual([
      { id: "batch-1", qty: "48.0000" },
      { id: "batch-1", qty: "24.0000" },
    ]);
  });

  it("rejects a CASHIER before touching anything", async () => {
    setSession("CASHIER");

    const res = await orderStatusPatch(makeRequest({ status: "APPROVED" }), { params });
    expect(res.status).toBe(403);

    expect(fakeDb.$transaction).not.toHaveBeenCalled();
    expect(fakeDb.invoice.create).not.toHaveBeenCalled();
  });
});

describe("T5 — the rejection path does no financial or inventory work", () => {
  it("stores the reason and writes nothing else", async () => {
    fakeDb.b2BOrderRequest.findFirst.mockResolvedValueOnce({
      id: ORDER_ID,
      status: "PENDING_REVIEW",
      matchedCustomerId: SURVIVOR,
    });

    const res = await orderStatusPatch(
      makeRequest({ status: "REJECTED", rejectionReason: "  السعر مرتفع  " }),
      { params }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: "REJECTED",
      invoiceId: null,
      itemsCount: 0,
    });

    expect(fakeDb.b2BOrderRequest.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, tenantId: TENANT_ID, status: "PENDING_REVIEW" },
      data: {
        status: "REJECTED",
        rejectionReason: "السعر مرتفع",
        reviewedByUserId: ADMIN_ID,
        reviewedAt: expect.any(Date),
      },
    });

    expect(fakeDb.invoice.create).not.toHaveBeenCalled();
    expect(fakeDb.invoiceItem.create).not.toHaveBeenCalled();
    expect(fakeDb.productBatch.update).not.toHaveBeenCalled();
    expect(fakeDb.customerPayment.create).not.toHaveBeenCalled();
    expect(lockSpy).not.toHaveBeenCalled();
    expect(fifoSpy).not.toHaveBeenCalled();
  });

  it("refuses to attach payment data to a rejection", async () => {
    const res = await orderStatusPatch(
      makeRequest({ status: "REJECTED", paidAmountSYP: "1000.0000", paymentMethod: "CASH" }),
      { params }
    );
    expect(res.status).toBe(400);
    expect(fakeDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("T5 — static source scans (this fix cannot silently regress)", () => {
  const source = () =>
    fs.readFileSync(
      path.resolve(process.cwd(), "app/api/orders/[id]/status/route.ts"),
      "utf-8"
    );

  it("contains the full approval pipeline, not merely a status write", () => {
    const src = source();
    expect(src).toContain("lockBatchesForFifoAllocations(tx, tenantId, productIds)");
    expect(src).toContain("commitFifoAllocation(tx, {");
    expect(src).toContain("toBaseUnit(item.quantity.toString(), soldUnitFactor)");
    expect(src).toContain("tx.invoice.create(");
    expect(src).toContain("tx.invoiceItem.create(");
    expect(src).toContain("data: { quantity: { decrement: alloc.deductQtyInBaseUnit } },");
    expect(src).toContain("resultingInvoiceId: invoice.id");
    expect(src).toContain('status: "COMPLETED"');
  });

  it("claims the row with a race-safe conditional update, and the old status-only write is gone", () => {
    const src = source();

    expect(src).toMatch(
      /tx\.b2BOrderRequest\.updateMany\(\{\s*where: \{ id, tenantId, status: "PENDING_REVIEW" \}/
    );
    expect(src).toContain("claimed.count !== 1");

    // The pre-fix implementation resolved the customer and then wrote ONLY
    // status/matchedCustomerId/reviewed* — that exact payload must not exist
    // anywhere any more.
    expect(src).not.toContain("matchedCustomerId: resolvedCustomerId");
  });
});






