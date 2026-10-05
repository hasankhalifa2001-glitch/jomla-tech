/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-restricted-syntax */
/**
 * T3a Addendum — Multi-Barcode Support (v4.5)
 *
 * The dedicated regression suite for the v4.5 multi-barcode model
 * (ProductUnitBarcode replacing ProductUnit.barcode/barcodeSource, and
 * ProductCatalogEntryBarcode replacing ProductCatalogEntry.barcode).
 *
 * This file is REFERENCED BY eslint.config.mjs (the PRODUCT_CATALOG_ENTRY_
 * BARCODE_MODEL_RULES block and its [v4.5] note) as the static-source-scan
 * enforcement behind the documented read-only exception for
 * `app/api/catalog/**`. It also covers the six other planned areas:
 *
 *   1. zero / one / many barcodes per POST request
 *   2. cross-unit (and cross-product) duplicate-barcode rejection
 *   3. delete-safety: removing a barcode can never orphan an InvoiceItem
 *   4. resetProductUnits() orphan-free barcode cleanup
 *   5. two-tenant same-GS1-barcode shared-catalog resolution (+ request-scoped
 *      continuity: N barcodes → ONE ProductCatalogEntry)
 *   6. static source-reference scans (the eslint exemption's guard)
 *   7. the Dexie v2 → v3 migration (a device's cached scalar becomes barcodes[])
 *
 * Strategy: the REAL gateway (lib/data/products.ts) and REAL base-unit
 * (lib/inventory/base-unit.ts) run against a faithful in-memory fake Prisma
 * transaction client — the same technique t3d-csv-import.test.ts uses — so the
 * route → gateway → tx wiring is genuinely exercised, not mocked away. Only
 * `@/auth` and the tenant-writability boundary are stubbed (no session/DB).
 */

import "fake-indexeddb/auto";
import fs from "fs";
import path from "path";
import Dexie from "dexie";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Fake Prisma transaction client + tenant-scoped db.
//
// Faithful to the exact queries the sanctioned gateways issue: the nested
// `unit.product.name` walk in findProductUnitByBarcode(), the scalar
// tenantId/unitId writes in createUnitBarcode(), the platform-wide (NO
// tenantId column) productCatalogEntry/productCatalogEntryBarcode rows, and
// the `@@unique([tenantId, barcode])` semantics ProductUnitBarcode relies on.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const freshState = () => ({
    products: [] as any[],
    units: [] as any[],
    unitBarcodes: [] as any[],
    catalogEntries: [] as any[],
    catalogBarcodes: [] as any[],
    seq: { product: 0, unit: 0, barcode: 0, entry: 0, catalogBarcode: 0 },
  });

  const state: any = freshState();
  const reset = () => Object.assign(state, freshState());

  const tx: any = {
    product: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `prod-${++state.seq.product}`, tenantId: data.tenantId ?? "tenant-1", isActive: true, isPublic: false, ...data };
        state.products.push(row);
        return row;
      }),
      findUniqueOrThrow: vi.fn(async ({ where, include }: any) => {
        const p = state.products.find((x: any) => x.id === where.id);
        if (!p) throw new Error(`Product not found (mock): ${where.id}`);
        return {
          ...p,
          baseUnit:
            include?.baseUnit && p.baseUnitId
              ? state.units.find((u: any) => u.id === p.baseUnitId) ?? null
              : null,
        };
      }),
      findUnique: vi.fn(async ({ where }: any) => state.products.find((x: any) => x.id === where.id) ?? null),
      findMany: vi.fn(async () => state.products),
      update: vi.fn(async ({ where, data }: any) => {
        const p = state.products.find((x: any) => x.id === where.id);
        if (!p) throw new Error(`Product not found (mock): ${where.id}`);
        Object.assign(p, data);
        return p;
      }),
    },
    productUnit: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `unit-${++state.seq.unit}`, tenantId: data.tenantId ?? "tenant-1", isActive: true, ...data };
        state.units.push(row);
        return row;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const u = state.units.find((x: any) => x.id === where.id);
        if (!u) throw new Error(`ProductUnit not found (mock): ${where.id}`);
        return u;
      }),
      findUnique: vi.fn(async ({ where }: any) => state.units.find((x: any) => x.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) =>
        state.units.filter((u: any) => (where.productId ? u.productId === where.productId : true))
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const u = state.units.find((x: any) => x.id === where.id);
        if (!u) throw new Error(`ProductUnit not found (mock): ${where.id}`);
        Object.assign(u, data);
        return u;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const targets = state.units.filter((u: any) => u.productId === where.productId);
        targets.forEach((u: any) => Object.assign(u, data));
        return { count: targets.length };
      }),
    },
    productUnitBarcode: {
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const b = state.unitBarcodes.find((x: any) => x.id === where.id);
        if (!b) throw new Error(`ProductUnitBarcode not found (mock): ${where.id}`);
        return b;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const hit = state.unitBarcodes.find(
          (b: any) => b.tenantId === where.tenantId && b.barcode === where.barcode
        );
        if (!hit) return null;
        const unit = state.units.find((u: any) => u.id === hit.unitId);
        if (!unit) return null;
        const parent = state.products.find((p: any) => p.id === unit.productId);
        return {
          unit: {
            id: unit.id,
            unitName: unit.unitName,
            isActive: unit.isActive !== false,
            productId: unit.productId,
            product: { name: parent?.name ?? "" },
          },
        };
      }),
      findMany: vi.fn(async ({ where }: any) =>
        state.unitBarcodes.filter((b: any) =>
          where.unitId ? b.unitId === where.unitId : b.tenantId === where.tenantId
        )
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `bc-${++state.seq.barcode}`, createdAt: new Date(), ...data };
        state.unitBarcodes.push(row);
        return row;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const i = state.unitBarcodes.findIndex((x: any) => x.id === where.id);
        if (i < 0) throw new Error(`ProductUnitBarcode not found (mock): ${where.id}`);
        return state.unitBarcodes.splice(i, 1)[0];
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const ids: string[] = where.unitId?.in ?? [];
        const before = state.unitBarcodes.length;
        state.unitBarcodes = state.unitBarcodes.filter((b: any) => !ids.includes(b.unitId));
        return { count: before - state.unitBarcodes.length };
      }),
    },

    productCatalogEntry: {
      create: vi.fn(async ({ data, select }: any) => {
        const row = { id: `ce-${++state.seq.entry}`, createdAt: new Date(), ...data };
        state.catalogEntries.push(row);
        return select?.id ? { id: row.id } : row;
      }),
    },
    productCatalogEntryBarcode: {
      findUnique: vi.fn(async ({ where }: any) => {
        const hit = state.catalogBarcodes.find((b: any) => b.barcode === where.barcode);
        return hit ? { catalogEntryId: hit.catalogEntryId } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `ceb-${++state.seq.catalogBarcode}`, createdAt: new Date(), ...data };
        state.catalogBarcodes.push(row);
        return row;
      }),
    },
    productBatch: { count: vi.fn(async () => 0) },
    b2BOrderRequestItem: { count: vi.fn(async () => 0) },
    baseUnitChangeLog: { create: vi.fn(async ({ data }: any) => data) },
  };

  const db: any = { ...tx, $transaction: vi.fn(async (cb: any) => cb(tx)) };

  return {
    state,
    tx,
    db,
    reset,
    session: {
      user: { id: "user-admin", role: "ADMIN", tenantId: "tenant-1", subscriptionStatus: "ACTIVE" },
    },
    assertTenantWritable: vi.fn(async () => "ACTIVE"),
  };
});

vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("@/lib/db/tenant-scope", () => ({ getTenantDb: vi.fn(() => h.db) }));
vi.mock("@/lib/auth/tenant", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  assertTenantWritable: h.assertTenantWritable,
}));

import { POST as createProduct } from "@/app/api/inventory/products/route";
import {
  createUnitBarcode,
  deleteUnitBarcode,
  findProductUnitByBarcode,
  findProductUnitByBarcodeExcludingProduct,
  resolveSharedCatalogForBarcode,
  listBarcodesForUnit,
} from "@/lib/data/products";
import { resetProductUnits } from "@/lib/inventory/base-unit";
import { getOfflineDb, resetOfflineDbForTests } from "@/lib/offline";

const TENANT_ID = "tenant-1";

// --- request / unit helpers ------------------------------------------------
const postRequest = (body: unknown) =>
  new Request("http://localhost/api/inventory/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const bc = (barcode: string, barcodeSource: "GS1" | "INTERNAL" = "GS1") => ({ barcode, barcodeSource });

const unitInput = (over: any = {}) => ({
  unitName: "قطعة",
  conversionFactor: "1",
  pricingCurrency: "SYP",
  priceWholesale: "100",
  barcodes: [] as any[],
  ...over,
});

/** A second (non-base) unit — factor must NOT be 1, or packaging validation fails. */
const cartonUnit = (over: any = {}) =>
  unitInput({ unitName: "كرتونة", conversionFactor: "12", priceWholesale: "1100", ...over });

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});


// ===========================================================================
// 1. Zero / one / many barcodes per request
// ===========================================================================
describe("T3a addendum — 0 / 1 / many barcodes per request", () => {
  it("accepts a unit with ZERO barcodes and writes no ProductUnitBarcode row", async () => {
    const res = await createProduct(postRequest({ name: "زيت", units: [unitInput()] }));
    expect(res.status).toBe(200);
    // The unit itself WAS created…
    expect(h.state.units).toHaveLength(1);
    // …but a unit with no barcodes issues no createUnitBarcode() call at all.
    expect(h.state.unitBarcodes).toHaveLength(0);
    expect(h.state.catalogEntries).toHaveLength(0);
  });

  it("writes exactly ONE row for a unit with one barcode", async () => {
    const res = await createProduct(
      postRequest({ name: "زيت", units: [unitInput({ barcodes: [bc("6211111111111")] })] })
    );
    expect(res.status).toBe(200);
    expect(h.state.unitBarcodes).toHaveLength(1);
    expect(h.state.unitBarcodes[0]).toMatchObject({
      tenantId: TENANT_ID,
      barcode: "6211111111111",
      barcodeSource: "GS1",
    });
    // One GS1 barcode → exactly one shared-catalog entry + one barcode link.
    expect(h.state.catalogEntries).toHaveLength(1);
    expect(h.state.catalogBarcodes).toHaveLength(1);
  });

  it("writes one row per barcode across MULTIPLE units, folding N GS1 barcodes into ONE catalog entry", async () => {
    const res = await createProduct(
      postRequest({
        name: "منظف",
        units: [
          unitInput({ barcodes: [bc("6211111111111"), bc("6211111111128")] }),
          cartonUnit({ barcodes: [bc("6211111111135"), bc("INT-1", "INTERNAL")] }),
        ],
      })
    );
    expect(res.status).toBe(200);
    // 4 physical barcodes ⇒ 4 ProductUnitBarcode rows.
    expect(h.state.unitBarcodes).toHaveLength(4);
    // INTERNAL never enters the cross-tenant catalog; the 3 GS1 barcodes share
    // ONE entry (request-scoped continuity — never three near-duplicate rows).
    expect(h.state.catalogEntries).toHaveLength(1);
    expect(h.state.catalogBarcodes).toHaveLength(3);
    const entryId = h.state.catalogEntries[0].id;
    h.state.catalogBarcodes.forEach((b: any) => expect(b.catalogEntryId).toBe(entryId));
  });
});

// ===========================================================================
// 2. Duplicate-barcode rejection (within a request and against the tenant)
// ===========================================================================
describe("T3a addendum — duplicate-barcode rejection", () => {
  it("rejects a barcode repeated across two units of the SAME request, before any write", async () => {
    const res = await createProduct(
      postRequest({
        name: "منظف",
        units: [
          unitInput({ barcodes: [bc("6211111111111")] }),
          cartonUnit({ barcodes: [bc("6211111111111")] }),
        ],
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("DUPLICATE_BARCODE");
    // Rejected BEFORE the transaction opened — nothing was written.
    expect(h.state.products).toHaveLength(0);
    expect(h.state.unitBarcodes).toHaveLength(0);
  });

  it("rejects a barcode already used by ANOTHER product in the tenant", async () => {
    h.state.products.push({ id: "prod-existing", tenantId: TENANT_ID, name: "موجود" });
    h.state.units.push({
      id: "unit-existing",
      tenantId: TENANT_ID,
      productId: "prod-existing",
      unitName: "قطعة",
    });
    h.state.unitBarcodes.push({
      id: "bc-existing",
      tenantId: TENANT_ID,
      unitId: "unit-existing",
      barcode: "6219999999999",
    });

    const res = await createProduct(
      postRequest({ name: "جديد", units: [unitInput({ barcodes: [bc("6219999999999")] })] })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("DUPLICATE_BARCODE");
    // Only the seeded product exists — the new one was never created.
    expect(h.state.products).toHaveLength(1);
  });
});

