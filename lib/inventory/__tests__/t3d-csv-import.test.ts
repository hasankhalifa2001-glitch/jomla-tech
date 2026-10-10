/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { validateAndPreviewCsv, commitCsvImport } from "../csv-parser";
// [v4.4, Sections 10.2 + T4g] Used to assert the server-date prefix the
// parser (not the CSV column) supplies for every newly created batch.
import { buildServerDatePrefix } from "../batch-number";
import { addLocalDays, localDayKey } from "@/lib/utils/syria-time";

describe("T3d — Bulk CSV Import", () => {
  const tenantId = "tenant-test-1";

  // Shared header for the compact fixtures in sections 6–8.
  const HEADER =
    "name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource";

  // [v4.7] commitCsvImport's shared receipt parameters — ONE receipt per
  // import file. purchaseDate is 30 days BEFORE the current business date —
  // a real, past business date that always sits inside the gateway's
  // MAX_BACKDATE_DAYS (730) window, so the suite holds whenever it runs.
  // (A fixed date like "2020-01-01" now violates the backdate rule — the
  // gateway would reject every batch-creating row.)
  const TEST_RECEIPT = {
    userId: "admin-user-1",
    purchaseDate: localDayKey(addLocalDays(new Date(), -30)),
    supplierName: null as string | null,
  };

  // Mock DB collections
  let mockUnitsInDb: any[] = [];
  let mockProductsInDb: any[] = [];
  let mockBatchesInDb: any[] = [];
  // [v4.5] The barcode model replaced ProductUnit.barcode/barcodeSource, so the
  // mock needs a real table for it — a unit's barcodes no longer live on the
  // unit row itself. Splitting them this way is what lets these tests catch the
  // class of bug that shipped in the pre-fix parser: a lookup that reads a
  // scalar off the unit can never see data that only exists here.
  let mockBarcodesInDb: any[] = [];
  // [v4.5] The shared cross-tenant catalog — needed because commitCsvImport()
  // now reconciles every GS1 barcode through the same
  // resolveSharedCatalogForBarcode() gateway the two product routes use.
  let mockCatalogEntriesInDb: any[] = [];
  let mockCatalogBarcodesInDb: any[] = [];
  // [v4.7] ProductReceipt rows written by the receiving gateway — one per
  // import file (existingReceiptId reuse means later rows never add one).
  let mockReceiptsInDb: any[] = [];

  const createMockDb = () => {
    // [v4.5] A unit's barcode rows, resolved at call time so a mock read always
    // reflects the current state exactly like a real query would.
    const barcodesFor = (unitId: string) =>
      mockBarcodesInDb.filter((b) => b.unitId === unitId);

    const db: any = {
      // [v4.7] The receiving gateway writes ONE receipt per import file;
      // createReceiptWithBatches() calls this top-level create first, then
      // every batch of the file carries the returned id.
      productReceipt: {
        create: vi.fn(async ({ data }: any) => {
          mockReceiptsInDb.push(data);
          return { id: `receipt-${mockReceiptsInDb.length}` };
        }),
      },
      product: {
        // Mirrors the real query's `include: { units: { select: { unitName,
        // conversionFactor } } }` shape: each returned product carries its
        // own `units` array, derived here from mockUnitsInDb so it always
        // reflects the current state at call time (matching a real DB read).
        findMany: vi.fn(async ({ where }: any) => {
          return mockProductsInDb
            .filter((p) => p.tenantId === where.tenantId)
            .map((p) => ({
              ...p,
              units: mockUnitsInDb
                .filter((u) => u.productId === p.id)
                .map((u) => ({
                  unitName: u.unitName,
                  conversionFactor: u.conversionFactor,
                })),
            }));
        }),
        // commitCsvImport does `existingProduct.units.map(...)` right after
        // this call, so `units` must be returned the same way findMany does.
        findFirst: vi.fn(async ({ where }: any) => {
          const found = mockProductsInDb.find((p) => {
            const tenantMatch = p.tenantId === where.tenantId;
            let nameMatch = true;
            if (where.name?.equals) {
              nameMatch =
                where.name.mode === "insensitive"
                  ? p.name.toLowerCase() === where.name.equals.toLowerCase()
                  : p.name === where.name.equals;
            }
            let catMatch = true;
            if (where.category === null) {
              catMatch = p.category === null || p.category === undefined;
            } else if (where.category?.equals) {
              catMatch =
                where.category.mode === "insensitive"
                  ? (p.category || "").toLowerCase() === where.category.equals.toLowerCase()
                  : p.category === where.category.equals;
            }
            return tenantMatch && nameMatch && catMatch;
          });
          if (!found) return null;
          return {
            ...found,
            units: mockUnitsInDb
              .filter((u) => u.productId === found.id)
              .map((u) => ({
                unitName: u.unitName,
                conversionFactor: u.conversionFactor,
              })),
          };
        }),
        create: vi.fn(async ({ data }: any) => {
          const newProduct = {
            id: `prod-${mockProductsInDb.length + 1}`,
            // [v4.7] A product created through createProductWithBaseUnit() gets
            // its tenantId from the Prisma Client Extension in the real DB,
            // which a plain mock object cannot emulate. Inject it here (exactly
            // like productUnit.create below) so requireBaseUnit()'s
            // tenant-scoped product.findUniqueOrThrow() and the packaging-check
            // reads can find the row.
            tenantId: data.tenantId || tenantId,
            ...data,
          };
          mockProductsInDb.push(newProduct);
          return newProduct;
        }),
        // [v4.4 — exposed by T4g's fixed CSV fixtures] These two methods are
        // used by the shared production helpers every batch-creation path
        // routes through (lib/inventory/base-unit.ts's requireBaseUnit() and
        // lib/data/products.ts's assertProductBelongsToTenant()/
        // commitBaseUnitLink()). Mocking them (rather than weakening the
        // production code) keeps this file's assertions on the real write path.
        findUniqueOrThrow: vi.fn(async ({ where, include }: any) => {
          const found = mockProductsInDb.find(
            (p) =>
              p.id === where.id &&
              (where.tenantId ? p.tenantId === where.tenantId : true)
          );
          if (!found) {
            throw new Error(`Product not found (mock): ${JSON.stringify(where)}`);
          }
          // requireBaseUnit() asks for `include: { baseUnit: true }` and
          // treats a null/absent baseUnit as MissingBaseUnitError.
          const baseUnit = include?.baseUnit
            ? mockUnitsInDb.find((u) => u.id === found.baseUnitId) || null
            : undefined;
          return include?.baseUnit ? { ...found, baseUnit } : { ...found };
        }),
        // commitBaseUnitLink() writes Product.baseUnitId through this. The
        // real query's `select: { id, baseUnitId }` shape is honoured so the
        // caller receives exactly what it destructures.
        update: vi.fn(async ({ where, data, select }: any) => {
          const product = mockProductsInDb.find((p) => p.id === where.id);
          if (!product) {
            throw new Error(`Product not found (mock): ${where.id}`);
          }
          Object.assign(product, data);
          if (select?.id && select?.baseUnitId) {
            return { id: product.id, baseUnitId: product.baseUnitId ?? null };
          }
          return product;
        }),
      },
      productUnit: {
        findMany: vi.fn(async ({ where }: any) => {
          return mockUnitsInDb
            .filter((u) => u.tenantId === where.tenantId)
            .map((u) => ({
              ...u,
              product: mockProductsInDb.find((p) => p.id === u.productId) || null,
              // [v4.5] Mirrors the real query's `include: { barcodes: {...} }`.
              // Without this, listAllUnitsForTenantWithProductName() would
              // build an EMPTY barcode map and every re-imported row would be
              // misread as brand-new — which is exactly the silent
              // duplicate-product bug this mock now makes impossible to miss.
              barcodes: barcodesFor(u.id),
            }));
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          // [v4.5] The old `where.tenantId_barcode` branch is gone on purpose:
          // that compound unique key lived on ProductUnit.barcode, which no
          // longer exists. A tenant-wide barcode lookup is now an indexed read
          // on productUnitBarcode (mocked separately below).
          if (where.id) {
            return mockUnitsInDb.find((u) => u.id === where.id) || null;
          }
          return null;
        }),
        findFirst: vi.fn(async ({ where }: any) => {
          return (
            mockUnitsInDb.find((u) => {
              const idMatch = where.id ? u.id === where.id : true;
              const tenantMatch = where.tenantId ? u.tenantId === where.tenantId : true;
              return idMatch && tenantMatch;
            }) || null
          );
        }),
        create: vi.fn(async ({ data }: any) => {
          const newUnit = {
            id: `unit-${mockUnitsInDb.length + 1}`,
            tenantId: data.tenantId || tenantId,
            ...data,
          };
          mockUnitsInDb.push(newUnit);
          return newUnit;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const unit = mockUnitsInDb.find((u) => u.id === where.id);
          if (unit) {
            Object.assign(unit, data);
            return unit;
          }
          throw new Error("Unit not found");
        }),
        // [v4.4 — exposed by T4g's fixed CSV fixtures] getUnitConversionFactor()
        // and commitBaseUnitLink() both read through this. Matching is
        // deliberately tolerant of a missing stored tenantId: a ProductUnit
        // created by createProductWithBaseUnit() in the real database gets its
        // tenantId from the Prisma Client Extension, which a plain mock object
        // cannot emulate.
        findUniqueOrThrow: vi.fn(async ({ where }: any) => {
          const found = mockUnitsInDb.find(
            (u) =>
              u.id === where.id &&
              (where.tenantId
                ? u.tenantId
                  ? u.tenantId === where.tenantId
                  : true
                : true)
          );
          if (!found) {
            throw new Error(`ProductUnit not found (mock): ${JSON.stringify(where)}`);
          }
          return {
            ...found,
            conversionFactor: found.conversionFactor ?? "1",
            priceWholesale: found.priceWholesale ?? "0",
          };
        }),
      },
      productBatch: {
        create: vi.fn(async ({ data }: any) => {
          const newBatch = {
            id: `batch-${mockBatchesInDb.length + 1}`,
            ...data,
          };
          mockBatchesInDb.push(newBatch);
          return newBatch;
        }),
      },
      // [v4.5] THE barcode model. Faithful to the real queries the sanctioned
      // gateways issue, because a loose mock here would hide a real bug:
      //  * findProductUnitByBarcode() selects `unit`, not a scalar — its
      //    `select: { unit: { select: {...} } }` walk is reproduced exactly,
      //    including the nested `product.name` hop.
      //  * createUnitBarcode() writes tenantId/unitId as plain scalars.
      productUnitBarcode: {
        findFirst: vi.fn(async ({ where }: any) => {
          const hit = mockBarcodesInDb.find(
            (b) => b.tenantId === where.tenantId && b.barcode === where.barcode
          );
          if (!hit) return null;
          const unit = mockUnitsInDb.find((u) => u.id === hit.unitId);
          if (!unit) return null;
          const parent = mockProductsInDb.find((p) => p.id === unit.productId);
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
          mockBarcodesInDb.filter((b) => b.tenantId === where.tenantId)
        ),
        create: vi.fn(async ({ data }: any) => {
          const row = {
            id: `bc-${mockBarcodesInDb.length + 1}`,
            createdAt: new Date(),
            ...data,
          };
          mockBarcodesInDb.push(row);
          return row;
        }),
        delete: vi.fn(async ({ where }: any) => {
          const idx = mockBarcodesInDb.findIndex((b) => b.id === where.id);
          if (idx < 0) throw new Error(`ProductUnitBarcode not found (mock): ${where.id}`);
          const [removed] = mockBarcodesInDb.splice(idx, 1);
          return removed;
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
          const before = mockBarcodesInDb.length;
          mockBarcodesInDb = mockBarcodesInDb.filter((b) => b.tenantId !== where.tenantId);
          return { count: before - mockBarcodesInDb.length };
        }),
      },
      // [v4.5] The shared catalog, platform-wide (no tenantId column at all —
      // matching the real model). Both gateways are exercised by the GS1 rows.
      productCatalogEntryBarcode: {
        findUnique: vi.fn(async ({ where }: any) => {
          const hit = mockCatalogBarcodesInDb.find((b) => b.barcode === where.barcode);
          return hit ? { catalogEntryId: hit.catalogEntryId } : null;
        }),
        create: vi.fn(async ({ data }: any) => {
          const row = {
            id: `ceb-${mockCatalogBarcodesInDb.length + 1}`,
            createdAt: new Date(),
            ...data,
          };
          mockCatalogBarcodesInDb.push(row);
          return row;
        }),
      },
      productCatalogEntry: {
        create: vi.fn(async ({ data, select }: any) => {
          const entry = {
            id: `entry-${mockCatalogEntriesInDb.length + 1}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          mockCatalogEntriesInDb.push(entry);
          return select?.id ? { id: entry.id } : entry;
        }),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db)),
    };
    return db;
  };

  let mockDb: any;

  beforeEach(() => {
    mockUnitsInDb = [];
    mockProductsInDb = [];
    mockBatchesInDb = [];
    mockBarcodesInDb = [];
    mockCatalogEntriesInDb = [];
    mockCatalogBarcodesInDb = [];
    mockReceiptsInDb = [];
    mockDb = createMockDb();
  });

  describe("1. Net-New Product & Unit Creation", () => {
    it("creates full Product -> ProductUnit -> ProductBatch chain with its barcodes as ProductUnitBarcode rows when all 5 required fields are valid", async () => {
      // [v4.4, Sections 10.2 + T4g] costPrice is the FIFTH required field for
      // any row that creates a new ProductBatch, and the initialBatchNumber
      // column carries the merchant-supplied SUFFIX only — never a full,
      // pre-formatted batch number.
      // [v4.5] The barcode columns are now the delimited `barcodes` plus the
      // MANDATORY `barcodeSource`. The source is stated by the merchant, never
      // inferred from the digits (T3a §5) — so a row that carries a barcode
      // without one is rejected outright, which this file's third test covers.
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
رز الشعلان,كيس 5كغ,1,20,BATCH-2026-01,120000,150000,6210001234567,GS1`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(0);
      expect(preview.summary.newProductsCount).toBe(1);
      expect(preview.newProducts[0]).toMatchObject({
        name: "رز الشعلان",
        unitName: "كيس 5كغ",
        conversionFactor: "1",
        initialQuantity: "20",
        initialBatchNumber: "BATCH-2026-01",
        costPrice: "120000",
        priceWholesale: "150000",
        pricingCurrency: "SYP",
        barcodes: [{ barcode: "6210001234567", barcodeSource: "GS1" }],
      });

      const commitResult = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
        receipt: TEST_RECEIPT,
      });

      expect(commitResult.createdProductsCount).toBe(1);
      expect(commitResult.failedNewProducts).toHaveLength(0);

      expect(mockProductsInDb).toHaveLength(1);
      expect(mockProductsInDb[0].name).toBe("رز الشعلان");

      expect(mockUnitsInDb).toHaveLength(1);
      const unit = mockUnitsInDb[0];
      expect(unit.productId).toBe(mockProductsInDb[0].id);
      expect(unit.unitName).toBe("كيس 5كغ");
      expect(unit.conversionFactor).toBe("1");
      expect(unit.priceWholesale).toBe("150000");
      expect(unit.pricingCurrency).toBe("SYP");
      // [v4.5] The barcode is a SEPARATE row in its own table, not a scalar on
      // the unit — and the source stored is the one the merchant stated, not
      // one derived from the value.
      expect(mockBarcodesInDb).toHaveLength(1);
      expect(mockBarcodesInDb[0]).toMatchObject({
        tenantId,
        unitId: unit.id,
        barcode: "6210001234567",
        barcodeSource: "GS1",
      });
      expect(unit.isActive).toBe(true);

      expect(mockBatchesInDb).toHaveLength(1);
      const batch = mockBatchesInDb[0];
      expect(batch.productId).toBe(mockProductsInDb[0].id);
      // A brand-new product's only unit IS its base unit, so the batch sits on
      // it. (Contrast with test 4/5, where the batch sits on the EXISTING base
      // unit, not on the newly added packaging unit.)
      expect(batch.unitId).toBe(unit.id);
      // [v4.4, Section 10.2] The column's raw value is NEVER written
      // verbatim — the stored batchNumber always carries the server-date
      // prefix, built through the same shared constructBatchNumber() the
      // single-batch and multi-product screens use.
      expect(batch.batchNumber).not.toBe("BATCH-2026-01");
      expect(batch.batchNumber).toBe(`${buildServerDatePrefix()}-BATCH-2026-01`);
      expect(batch.batchNumber).toMatch(/^\d{4}-\d{2}-\d{2}-BATCH-2026-01$/);
      // Base quantity stored at 4dp (the Decimal(18,4) column), via the shared
      // createBatchRow() writer every creation path now routes through.
      expect(batch.quantity).toBe("20.0000");
      // [v4.4, T4g] Required, non-nullable — stored from creation onward.
      expect(batch.costPricePerBaseUnit).toBe("120000");
    });

    it("rejects an unmatched barcode row missing ANY of the 5 required fields and names the missing fields", async () => {
      // [v4.4, Sections 10.2 + T4g] The required set is now unitName,
      // conversionFactor, initialQuantity, initialBatchNumber AND costPrice —
      // the last two named in the import report exactly like the rest.
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
منتج 1,,1,10,B1,9000,5000,BAR-01,GS1
منتج 2,حبة,,10,B2,9000,5000,BAR-02,GS1
منتج 3,حبة,1,,B3,9000,5000,BAR-03,GS1
منتج 4,حبة,1,10,,9000,5000,BAR-04,GS1
منتج 5,حبة,1,10,B5,,5000,BAR-05,GS1
منتج 6,,,,,,5000,BAR-06,GS1`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(0);
      expect(preview.summary.rejectedRowsCount).toBe(6);

      expect(preview.rejectedRows[0].reason).toContain("اسم الوحدة");
      expect(preview.rejectedRows[1].reason).toContain("معامل التحويل");
      expect(preview.rejectedRows[2].reason).toContain("الكمية الأولية");
      expect(preview.rejectedRows[3].reason).toContain("رقم الدفعة الأولى");
      // [v4.4, T4g] A net-new-batch row with no cost price is rejected and
      // named, using the identical rejection pathway as the other fields.
      expect(preview.rejectedRows[4].reason).toContain("سعر التكلفة");
      expect(preview.rejectedRows[4].reason).not.toContain("رقم الدفعة الأولى");

      expect(preview.rejectedRows[5].reason).toContain("اسم الوحدة");
      expect(preview.rejectedRows[5].reason).toContain("معامل التحويل");
      expect(preview.rejectedRows[5].reason).toContain("الكمية الأولية");
      expect(preview.rejectedRows[5].reason).toContain("رقم الدفعة الأولى");
      expect(preview.rejectedRows[5].reason).toContain("سعر التكلفة");
    });

    it("[v4.5] rejects a row that carries barcodes WITHOUT the mandatory barcodeSource, and never infers the source from the digits", async () => {
      // The two rows differ ONLY in the barcodeSource cell. Row 1 supplies a
      // perfectly GS1-shaped 13-digit barcode but no source: it must be
      // rejected, because the source is never guessed from the value's digit
      // pattern (T3a §5 — the rule this whole gate exists for). Row 2 supplies
      // the same barcode WITH a source and is accepted, proving the rejection
      // is about the missing classification and not the barcode itself.
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
منتج بلا مصدر,حبة,1,10,B1,9000,5000,6210007778889,
منتج بمصدر,حبة,1,10,B2,9000,5000,6210007778890,INTERNAL`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);

      expect(preview.summary.rejectedRowsCount).toBe(1);
      expect(preview.rejectedRows[0].reason).toContain("مصدر الباركود (GS1 أو INTERNAL)");
      expect(preview.summary.newProductsCount).toBe(1);
      // The accepted row stores the source the merchant chose — INTERNAL here,
      // even though the value looks exactly like a GS1 code.
      expect(preview.newProducts[0].barcodes).toEqual([
        { barcode: "6210007778890", barcodeSource: "INTERNAL" },
      ]);
    });

    it("[v4.5] splits a delimited barcodes cell into one row per barcode and de-duplicates values repeated inside that cell", async () => {
      // `;` is the separator (matching both product modals' splitter), and the
      // repeated value proves the in-cell Set de-duplication: one physical
      // barcode listed twice must not become two identical rows.
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
زيت دوار الشمس,طرد 6 لتر,1,30,B-OIL-1,95000,120000,621000999001;621000999002;621000999001,GS1`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(1);
      expect(preview.newProducts[0].barcodes).toEqual([
        { barcode: "621000999001", barcodeSource: "GS1" },
        { barcode: "621000999002", barcodeSource: "GS1" },
      ]);

      await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
        receipt: TEST_RECEIPT,
      });

      // One row per DISTINCT barcode — not three, and not one.
      expect(mockBarcodesInDb).toHaveLength(2);
      expect(mockBarcodesInDb.map((b) => b.barcode).sort()).toEqual([
        "621000999001",
        "621000999002",
      ]);
      // Both GS1 barcodes of ONE row must resolve to ONE shared-catalog entry,
      // never two near-duplicate entries (T3a §6's request-scoped continuity).
      expect(mockCatalogEntriesInDb).toHaveLength(1);
      expect(mockCatalogBarcodesInDb).toHaveLength(2);
      expect(
        new Set(mockCatalogBarcodesInDb.map((b) => b.catalogEntryId)).size
      ).toBe(1);
    });

    it("[v4.5] stores ZERO barcode rows for a row whose barcodes cell is empty — and still creates the product and unit", async () => {
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
سكر ناعم,كيلو,1,25,B-SUGAR-1,8000,11000,,`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(0);
      expect(preview.summary.newProductsCount).toBe(1);
      expect(preview.newProducts[0].barcodes).toEqual([]);

      const commitResult = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
        receipt: TEST_RECEIPT,
      });

      expect(commitResult.createdProductsCount).toBe(1);
      expect(mockProductsInDb).toHaveLength(1);
      expect(mockUnitsInDb).toHaveLength(1);
      expect(mockBarcodesInDb).toHaveLength(0);
      // An INTERNAL/GS1 classification must never be invented for a row that
      // declared no barcode at all.
      expect(mockCatalogEntriesInDb).toHaveLength(0);
    });

    it("rejects an invalid currency (not SYP or USD) outright and accepts valid currencies", async () => {
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,pricingCurrency,barcodes,barcodeSource
سمنة 1,علبة,1,10,B1,9000,25,EUR,BAR-EUR,GS1
سمنة 2,علبة,1,10,B2,9000,25,USD,BAR-USD,GS1
سمنة 3,علبة,1,10,B3,9000,25000,SYP,BAR-SYP,GS1
سمنة 4,علبة,1,10,B4,9000,25000,,BAR-DEFAULT,GS1`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(1);
      expect(preview.rejectedRows[0].reason).toContain('عملة التسعير "EUR" غير صالحة');

      expect(preview.summary.newProductsCount).toBe(3);
      expect(preview.newProducts[0].pricingCurrency).toBe("USD");
      expect(preview.newProducts[1].pricingCurrency).toBe("SYP");
      expect(preview.newProducts[2].pricingCurrency).toBe("SYP");
    });
  });

  describe("2. Idempotency & Re-importing the same CSV", () => {
    it("re-importing the same CSV twice never duplicates products or batches, updating priceWholesale only", async () => {
      // conversionFactor is "1": a lone unit on a brand-new product must be the
      // base unit (validatePackagingUnits), so any other factor would be
      // rejected at preview. This test is about idempotent price updates.
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
حليب نادك,كرتونة,1,50,B-NADEC-1,60000,80000,6281007001,GS1`;

      // Pass 1: Initial import
      const preview1 = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview1.summary.newProductsCount).toBe(1);
      expect(preview1.summary.priceUpdatesCount).toBe(0);

      await commitCsvImport(mockDb, tenantId, {
        newProducts: preview1.newProducts,
        priceUpdates: preview1.priceUpdates,
        receipt: TEST_RECEIPT,
      });

      expect(mockProductsInDb).toHaveLength(1);
      expect(mockUnitsInDb).toHaveLength(1);
      expect(mockBatchesInDb).toHaveLength(1);
      expect(mockUnitsInDb[0].priceWholesale).toBe("80000");

      // Pass 2: Re-import same CSV with an updated price in the file
      const updatedCsv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
حليب نادك,كرتونة,1,50,B-NADEC-1,60000,85000,6281007001,GS1`;

      const preview2 = await validateAndPreviewCsv(mockDb, tenantId, updatedCsv);
      expect(preview2.summary.newProductsCount).toBe(0);
      expect(preview2.summary.priceUpdatesCount).toBe(1);
      expect(preview2.priceUpdates[0].newPriceWholesale).toBe("85000");

      const commit2 = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview2.newProducts,
        priceUpdates: preview2.priceUpdates,
        receipt: TEST_RECEIPT,
      });

      expect(commit2.createdProductsCount).toBe(0);
      expect(commit2.updatedPricesCount).toBe(1);

      expect(mockProductsInDb).toHaveLength(1);
      expect(mockUnitsInDb).toHaveLength(1);
      expect(mockBatchesInDb).toHaveLength(1);
      expect(mockUnitsInDb[0].priceWholesale).toBe("85000");
    });
  });

  describe("3. In-File Duplicate Barcodes & Sequential Processing", () => {
    it("handles multiple rows in the same CSV sharing the same new barcode sequentially: creates on 1st row, updates price on 2nd", async () => {
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
زيت عافية,طرد 6 لتر,1,30,B-OIL-1,95000,120000,621000999888,GS1
زيت عافية,طرد 6 لتر,1,30,B-OIL-1,95000,125000,621000999888,GS1`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(0);
      expect(preview.summary.newProductsCount).toBe(1);
      expect(preview.summary.priceUpdatesCount).toBe(1);
      expect(preview.priceUpdates[0].newPriceWholesale).toBe("125000");

      const commitResult = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
        receipt: TEST_RECEIPT,
      });

      expect(commitResult.createdProductsCount).toBe(1);
      expect(commitResult.updatedPricesCount).toBe(1);
      expect(commitResult.failedNewProducts).toHaveLength(0);

      expect(mockProductsInDb).toHaveLength(1);
      expect(mockUnitsInDb).toHaveLength(1);
      expect(mockBatchesInDb).toHaveLength(1);
      expect(mockUnitsInDb[0].priceWholesale).toBe("125000");
    });

    it("translates database-level unique violation (P2002) into a merchant-friendly message", async () => {
      mockDb.productUnit.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6.0.0",
        })
      );

      const commitResult = await commitCsvImport(mockDb, tenantId, {
        newProducts: [
          {
            lineNumber: 2,
            name: "شامبو",
            unitName: "علبة",
            conversionFactor: "1",
            costPrice: "10000",
            priceWholesale: "15000",
            initialBatchNumber: "B1",
            initialQuantity: "10",
            // [v4.5] Barcodes are a list on the request and their own rows in
            // the database — never a scalar on the unit.
            barcodes: [{ barcode: "621000111222", barcodeSource: "GS1" }],
          },
        ],
        priceUpdates: [],
        receipt: TEST_RECEIPT,
      });

      expect(commitResult.createdProductsCount).toBe(0);
      expect(commitResult.failedNewProducts).toHaveLength(1);
      expect(commitResult.failedNewProducts[0].reason).toContain(
        "تعارض في الباركود (621000111222) — تم إنشاؤه مسبقاً"
      );
    });
  });

  describe("4. Name Collision & Additional Packaging Units", () => {
    it("attaches new packaging unit to existing Product when (tenantId, name, category) matches, without duplicating Product", async () => {
      const existingProduct = {
        id: "prod-existing-1",
        tenantId,
        name: "بسكويت لوتس",
        category: "حلويات",
        isPublic: false,
        // A real product ALWAYS has a designated base unit, and the
        // additional-unit commit path calls requireBaseUnit() before it can
        // convert the row's quantity.
        baseUnitId: "unit-existing-1",
      };
      mockProductsInDb.push(existingProduct);
      mockUnitsInDb.push({
        id: "unit-existing-1",
        tenantId,
        productId: existingProduct.id,
        unitName: "قطعة",
        conversionFactor: "1",
        priceWholesale: "5000",
      });
      // [v4.5] That unit's barcode is its own ProductUnitBarcode row now — not
      // a scalar on the unit.
      mockBarcodesInDb.push({
        id: "bc-existing-1",
        tenantId,
        unitId: "unit-existing-1",
        barcode: "621111111111",
        barcodeSource: "GS1",
        createdAt: new Date(),
      });

      const csv = `name,category,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
بسكويت لوتس,حلويات,كرتونة,24,15,B-LOTUS-CARTON,85000,110000,622222222222,GS1`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(1);

      const commitResult = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
        receipt: TEST_RECEIPT,
      });

      expect(commitResult.createdProductsCount).toBe(1);
      expect(mockProductsInDb).toHaveLength(1);

      expect(mockUnitsInDb).toHaveLength(2);
      // [v4.5] Resolve the newly created unit through its barcode ROW — the
      // barcode no longer lives on the unit.
      const newUnitBarcode = mockBarcodesInDb.find((b) => b.barcode === "622222222222");
      expect(newUnitBarcode).toBeDefined();
      const newUnit = mockUnitsInDb.find((u) => u.id === newUnitBarcode.unitId);
      expect(newUnit).toBeDefined();
      expect(newUnit.productId).toBe(existingProduct.id);
      expect(newUnit.unitName).toBe("كرتونة");
      expect(newUnit.conversionFactor).toBe("24");
      // The pre-existing unit's own barcode is untouched by the new row.
      expect(mockBarcodesInDb).toHaveLength(2);
      expect(mockBarcodesInDb.find((b) => b.barcode === "621111111111")).toBeDefined();

      // [v4.0] ProductBatch.unitId is ALWAYS the product's BASE unit, never
      // the packaging unit the merchant typed the quantity in.
      const newBatch = mockBatchesInDb.find((b) => b.unitId === "unit-existing-1");
      expect(newBatch).toBeDefined();
      expect(newBatch.productId).toBe(existingProduct.id);
      // 15 كرتونة × conversionFactor 24 = 360 in the base unit (قطعة); the
      // shared writer stores base quantities at 4dp (the Decimal(18,4) column).
      expect(newBatch.quantity).toBe("360.0000");
      // [v4.4, T4g] The cost price is stored per BASE unit, taken as-is from
      // the column — never divided by the entry unit's conversionFactor (24).
      expect(newBatch.costPricePerBaseUnit).toBe("85000");
      expect(newBatch.batchNumber).toMatch(/^\d{4}-\d{2}-\d{2}-B-LOTUS-CARTON$/);
    });
  });

  describe("5. Decimal Precision Preservation", () => {
    it("preserves exact decimal strings for conversionFactor, quantity, and prices without floating-point conversion", async () => {
      // A lone unit on a brand-new product must be the base unit (factor 1),
      // so this test seeds an EXISTING product with its own base unit and adds
      // "شوال 50كغ" (factor 50.25) as an additional packaging unit. That keeps
      // the intent — decimal.js-level precision for a fractional factor plus
      // quantity/price — while respecting the packaging rule.
      const existingProduct = {
        id: "prod-sugar-1",
        tenantId,
        name: "سكر أبيض",
        category: null,
        isPublic: false,
        baseUnitId: "unit-sugar-base",
      };
      mockProductsInDb.push(existingProduct);
      mockUnitsInDb.push({
        id: "unit-sugar-base",
        tenantId,
        productId: existingProduct.id,
        unitName: "كيلو",
        conversionFactor: "1",
        priceWholesale: "9000",
      });

      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,costPrice,priceWholesale,barcodes,barcodeSource
سكر أبيض,شوال 50كغ,50.25,123.4567,B-SUGAR-1,9876.5432,450000.75,621333444555,GS1`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(1);
      const np = preview.newProducts[0];
      expect(np.conversionFactor).toBe("50.25");
      expect(np.initialQuantity).toBe("123.4567");
      expect(np.costPrice).toBe("9876.5432");
      expect(np.priceWholesale).toBe("450000.75");

      await commitCsvImport(mockDb, tenantId, {
        newProducts: [np],
        priceUpdates: [],
        receipt: TEST_RECEIPT,
      });

      // The NEW unit is resolved through its barcode row.
      const unitBarcode = mockBarcodesInDb.find((b) => b.barcode === "621333444555");
      expect(unitBarcode).toBeDefined();
      const unit = mockUnitsInDb.find((u) => u.id === unitBarcode.unitId);
      expect(unit).toBeDefined();
      expect(unit.conversionFactor).toBe("50.25");
      expect(unit.priceWholesale).toBe("450000.75");

      // [v4.0] The batch lives on the product's BASE unit, not on the new
      // packaging unit the quantity was typed in.
      const batch = mockBatchesInDb.find((b) => b.unitId === "unit-sugar-base");
      expect(batch).toBeDefined();
      expect(batch.productId).toBe(existingProduct.id);
      // 123.4567 × 50.25 = 6203.699175 (base unit: كيلو); stored at 4dp as the
      // Decimal(18,4) column requires, via the shared createBatchRow() writer.
      expect(batch.quantity).toBe("6203.6992");
      // Cost is per BASE unit, stored as-is with exact decimal-string precision.
      expect(batch.costPricePerBaseUnit).toBe("9876.5432");
    });
  });

  describe("6. Additional validation coverage", () => {
    it("rejects costPrice of zero, negative, or non-numeric, naming the field", async () => {
      const csv = `${HEADER}
م1,حبة,1,10,B1,0,5000,,
م2,حبة,1,10,B2,-5,5000,,
م3,حبة,1,10,B3,abc,5000,,`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(0);
      expect(preview.summary.rejectedRowsCount).toBe(3);
      for (const r of preview.rejectedRows) {
        expect(r.reason).toContain("سعر التكلفة");
      }
    });

    it("treats a whitespace-only initialBatchNumber as missing", async () => {
      const csv = `${HEADER}
م,حبة,1,10,   ,9000,5000,,`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(1);
      expect(preview.rejectedRows[0].reason).toContain("رقم الدفعة الأولى");
    });

    it("accepts a valid expiryDate and stores it on the batch", async () => {
      const csv = `${HEADER},expiryDate
لبن,علبة,1,10,B-EXP,9000,12000,,,2027-12-31`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(0);
      expect(preview.newProducts[0].expiryDate).toBe("2027-12-31");

      await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
        receipt: TEST_RECEIPT,
      });

      expect(mockBatchesInDb).toHaveLength(1);
      expect(mockBatchesInDb[0].expiryDate).toBeInstanceOf(Date);
      expect(mockBatchesInDb[0].expiryDate.toISOString().slice(0, 10)).toBe("2027-12-31");
    });

    it("rejects a malformed or impossible expiryDate", async () => {
      const csv = `${HEADER},expiryDate
م1,علبة,1,10,B1,9000,12000,,,31/12/2027
م2,علبة,1,10,B2,9000,12000,,,2027-02-30`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(0);
      expect(preview.summary.rejectedRowsCount).toBe(2);
      expect(preview.rejectedRows[0].reason).toContain("YYYY-MM-DD");
      expect(preview.rejectedRows[1].reason).toContain("غير صالح");
    });
  });

  describe("7. Multi-barcode rows against an existing unit", () => {
    const seedExistingUnit = () => {
      mockProductsInDb.push({
        id: "prod-x",
        tenantId,
        name: "مدار",
        category: null,
        isPublic: false,
        baseUnitId: "unit-x",
      });
      mockUnitsInDb.push({
        id: "unit-x",
        tenantId,
        productId: "prod-x",
        unitName: "علبة",
        conversionFactor: "1",
        priceWholesale: "5000",
        pricingCurrency: "SYP",
      });
      mockBarcodesInDb.push({
        id: "bc-x",
        tenantId,
        unitId: "unit-x",
        barcode: "621111111111",
        barcodeSource: "GS1",
        createdAt: new Date(),
      });
    };

    it("rejects a row mixing an existing barcode with a new one instead of silently dropping the new one", async () => {
      seedExistingUnit();
      const csv = `${HEADER}
مدار,علبة,1,10,B1,4000,6000,621111111111;699999999999,GS1`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.priceUpdatesCount).toBe(0);
      expect(preview.summary.rejectedRowsCount).toBe(1);
      expect(preview.rejectedRows[0].reason).toContain("لا ينتمي");
      expect(preview.rejectedRows[0].reason).toContain("699999999999");
    });

    it("still treats a row carrying only the existing barcode as a plain price update", async () => {
      seedExistingUnit();
      const csv = `${HEADER}
مدار,علبة,1,10,B1,4000,6000,621111111111,`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(0);
      expect(preview.summary.priceUpdatesCount).toBe(1);
      expect(preview.priceUpdates[0].newPriceWholesale).toBe("6000");
      // No native JS number in a monetary field.
      expect(typeof preview.priceUpdates[0].currentPriceWholesale).toBe("string");
    });
  });

  describe("8. Commit-stage failure handling", () => {
    const validNewProduct = async () => {
      const csv = `${HEADER}
شامبو,علبة,1,10,B1,9000,15000,621000111222,GS1`;
      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(1);
      return preview.newProducts;
    };

    it("translates a P2002 raised by productUnitBarcode.create into the friendly barcode-conflict message", async () => {
      const newProducts = await validNewProduct();
      mockDb.productUnitBarcode.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6.0.0",
        })
      );

      const result = await commitCsvImport(mockDb, tenantId, { newProducts, priceUpdates: [] ,
        receipt: TEST_RECEIPT});

      expect(result.createdProductsCount).toBe(0);
      expect(result.failedNewProducts).toHaveLength(1);
      expect(result.failedNewProducts[0].reason).toContain("تعارض في الباركود (621000111222)");
      // The raw Prisma code is never surfaced to the merchant.
      expect(result.failedNewProducts[0].reason).not.toContain("P2002");
    });

    it("does not count a row as created when the transaction fails after the callback ran", async () => {
      const newProducts = await validNewProduct();
      mockDb.$transaction.mockImplementationOnce(async (cb: any) => {
        await cb(mockDb);
        throw new Error("commit failed");
      });

      const result = await commitCsvImport(mockDb, tenantId, { newProducts, priceUpdates: [] ,
        receipt: TEST_RECEIPT});

      expect(result.createdProductsCount).toBe(0);
      expect(result.failedNewProducts).toHaveLength(1);
    });
  });
});