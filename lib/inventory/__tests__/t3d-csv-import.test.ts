/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { validateAndPreviewCsv, commitCsvImport } from "../csv-parser";

describe("T3d — Bulk CSV Import", () => {
  const tenantId = "tenant-test-1";

  // Mock DB collections
  let mockUnitsInDb: any[] = [];
  let mockProductsInDb: any[] = [];
  let mockBatchesInDb: any[] = [];

  const createMockDb = () => {
    const db: any = {
      product: {
        // [FIX — critical] Previously missing entirely. validateAndPreviewCsv()
        // calls `db.product.findMany(...)` unconditionally (to seed
        // existingProductUnitsByKey for the packaging-unit consistency
        // check) — with no mock for it, EVERY test in this file that calls
        // validateAndPreviewCsv threw `TypeError: db.product.findMany is
        // not a function` before any assertion logic ever ran. Mirrors the
        // real query's `include: { units: { select: { unitName,
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
        // [FIX — critical] Previously returned the raw product row from
        // mockProductsInDb with NO `units` field at all, even though the
        // real query commitCsvImport() issues here uses
        // `include: { units: { select: { unitName, conversionFactor } } }`.
        // commitCsvImport does `existingProduct.units.map(...)` immediately
        // after this call (to build the live candidate set for the
        // packaging-consistency re-check) — with `units` undefined, that
        // threw `TypeError: Cannot read properties of undefined (reading
        // 'map')` inside the per-row transaction, which the generic catch
        // block silently turned into a "failed to create product" result.
        // This is exactly why the "Name Collision" test's `createdProductsCount`
        // came back 0 instead of 1: the product WAS found (preview passed),
        // but commit's live re-validation crashed on the missing `units`.
        // Fixed by returning `units` the same way findMany above does.
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
            ...data,
          };
          mockProductsInDb.push(newProduct);
          return newProduct;
        }),
      },
      productUnit: {
        findMany: vi.fn(async ({ where }: any) => {
          return mockUnitsInDb
            .filter((u) => u.tenantId === where.tenantId)
            .map((u) => ({
              ...u,
              product: mockProductsInDb.find((p) => p.id === u.productId) || null,
            }));
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.tenantId_barcode) {
            const found = mockUnitsInDb.find(
              (u) =>
                u.tenantId === where.tenantId_barcode.tenantId &&
                u.barcode === where.tenantId_barcode.barcode
            );
            return found || null;
          }
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
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db)),
    };
    return db;
  };

  let mockDb: any;

  beforeEach(() => {
    mockUnitsInDb = [];
    mockProductsInDb = [];
    mockBatchesInDb = [];
    mockDb = createMockDb();
  });

  describe("1. Net-New Product & Unit Creation", () => {
    it("creates full Product -> ProductUnit -> ProductBatch chain with barcodeSource: null when all 4 required fields are valid", async () => {
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,priceWholesale,barcode
رز الشعلان,كيس 5كغ,1,20,BATCH-2026-01,150000,6210001234567`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(0);
      expect(preview.summary.newProductsCount).toBe(1);
      expect(preview.newProducts[0]).toMatchObject({
        name: "رز الشعلان",
        unitName: "كيس 5كغ",
        conversionFactor: "1",
        initialQuantity: "20",
        initialBatchNumber: "BATCH-2026-01",
        priceWholesale: "150000",
        pricingCurrency: "SYP",
        barcode: "6210001234567",
      });

      const commitResult = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
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
      expect(unit.barcode).toBe("6210001234567");
      expect(unit.barcodeSource).toBeNull(); // Mandatory T3d / T3a invariant
      expect(unit.isActive).toBe(true);

      expect(mockBatchesInDb).toHaveLength(1);
      const batch = mockBatchesInDb[0];
      expect(batch.productId).toBe(mockProductsInDb[0].id);
      expect(batch.unitId).toBe(unit.id);
      expect(batch.batchNumber).toBe("BATCH-2026-01");
      expect(batch.quantity).toBe("20");
    });

    it("rejects an unmatched barcode row missing ANY of the 4 required fields and names the missing fields", async () => {
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,priceWholesale,barcode
منتج 1,,1,10,B1,5000,BAR-01
منتج 2,حبة,,10,B2,5000,BAR-02
منتج 3,حبة,1,,B3,5000,BAR-03
منتج 4,حبة,1,10,,5000,BAR-04
منتج 5,,,,,5000,BAR-05`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(0);
      expect(preview.summary.rejectedRowsCount).toBe(5);

      expect(preview.rejectedRows[0].reason).toContain("اسم الوحدة");
      expect(preview.rejectedRows[1].reason).toContain("معامل التحويل");
      expect(preview.rejectedRows[2].reason).toContain("الكمية الأولية");
      expect(preview.rejectedRows[3].reason).toContain("رقم الدفعة الأولى");

      expect(preview.rejectedRows[4].reason).toContain("اسم الوحدة");
      expect(preview.rejectedRows[4].reason).toContain("معامل التحويل");
      expect(preview.rejectedRows[4].reason).toContain("الكمية الأولية");
      expect(preview.rejectedRows[4].reason).toContain("رقم الدفعة الأولى");
    });

    it("rejects an invalid currency (not SYP or USD) outright and accepts valid currencies", async () => {
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,priceWholesale,pricingCurrency,barcode
سمنة 1,علبة,1,10,B1,25,EUR,BAR-EUR
سمنة 2,علبة,1,10,B2,25,USD,BAR-USD
سمنة 3,علبة,1,10,B3,25000,SYP,BAR-SYP
سمنة 4,علبة,1,10,B4,25000,,BAR-DEFAULT`;

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
      // [FIX — test data] conversionFactor changed from "12" to "1". This
      // row creates a genuinely NEW product (no existing DB row, no
      // earlier-in-file row) with only ONE unit. Per T3a's confirmed
      // packaging-consistency rule (enforced live by
      // validatePackagingUnits() inside validateAndPreviewCsv — see that
      // function's own doc comment in csv-parser.ts), a lone unit on a
      // brand-new product MUST have conversionFactor === 1, since it is
      // by definition the product's only — and therefore base — unit. The
      // original factor of "12" had no accompanying base unit and was
      // correctly rejected by the parser, which is why
      // `newProductsCount` came back 0 instead of 1: the source code was
      // right, this test's fixture data was invalid. This test cares
      // about idempotent price-update behavior on re-import, not about
      // packaging-unit factors, so "1" is the correct, minimal fixture.
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,priceWholesale,barcode
حليب نادك,كرتونة,1,50,B-NADEC-1,80000,6281007001`;

      // Pass 1: Initial import
      const preview1 = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview1.summary.newProductsCount).toBe(1);
      expect(preview1.summary.priceUpdatesCount).toBe(0);

      await commitCsvImport(mockDb, tenantId, {
        newProducts: preview1.newProducts,
        priceUpdates: preview1.priceUpdates,
      });

      expect(mockProductsInDb).toHaveLength(1);
      expect(mockUnitsInDb).toHaveLength(1);
      expect(mockBatchesInDb).toHaveLength(1);
      expect(mockUnitsInDb[0].priceWholesale).toBe("80000");

      // Pass 2: Re-import same CSV with an updated price in the file
      const updatedCsv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,priceWholesale,barcode
حليب نادك,كرتونة,1,50,B-NADEC-1,85000,6281007001`;

      const preview2 = await validateAndPreviewCsv(mockDb, tenantId, updatedCsv);
      expect(preview2.summary.newProductsCount).toBe(0);
      expect(preview2.summary.priceUpdatesCount).toBe(1);
      expect(preview2.priceUpdates[0].newPriceWholesale).toBe("85000");

      const commit2 = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview2.newProducts,
        priceUpdates: preview2.priceUpdates,
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
      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,priceWholesale,barcode
زيت عافية,طرد 6 لتر,1,30,B-OIL-1,120000,621000999888
زيت عافية,طرد 6 لتر,1,30,B-OIL-1,125000,621000999888`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.rejectedRowsCount).toBe(0);
      expect(preview.summary.newProductsCount).toBe(1);
      expect(preview.summary.priceUpdatesCount).toBe(1);
      expect(preview.priceUpdates[0].newPriceWholesale).toBe("125000");

      const commitResult = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
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
            priceWholesale: "15000",
            initialBatchNumber: "B1",
            initialQuantity: "10",
            barcode: "621000111222",
          },
        ],
        priceUpdates: [],
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
      };
      mockProductsInDb.push(existingProduct);
      mockUnitsInDb.push({
        id: "unit-existing-1",
        tenantId,
        productId: existingProduct.id,
        unitName: "قطعة",
        conversionFactor: "1",
        priceWholesale: "5000",
        barcode: "621111111111",
        barcodeSource: null,
      });

      const csv = `name,category,unitName,conversionFactor,initialQuantity,initialBatchNumber,priceWholesale,barcode
بسكويت لوتس,حلويات,كرتونة,24,15,B-LOTUS-CARTON,110000,622222222222`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(1);

      const commitResult = await commitCsvImport(mockDb, tenantId, {
        newProducts: preview.newProducts,
        priceUpdates: preview.priceUpdates,
      });

      expect(commitResult.createdProductsCount).toBe(1);
      expect(mockProductsInDb).toHaveLength(1);

      expect(mockUnitsInDb).toHaveLength(2);
      const newUnit = mockUnitsInDb.find((u) => u.barcode === "622222222222");
      expect(newUnit).toBeDefined();
      expect(newUnit.productId).toBe(existingProduct.id);
      expect(newUnit.unitName).toBe("كرتونة");
      expect(newUnit.conversionFactor).toBe("24");

      const newBatch = mockBatchesInDb.find((b) => b.unitId === newUnit.id);
      expect(newBatch).toBeDefined();
      expect(newBatch.productId).toBe(existingProduct.id);
      expect(newBatch.quantity).toBe("15");
    });
  });

  describe("5. Decimal Precision Preservation", () => {
    it("preserves exact decimal strings for conversionFactor, quantity, and prices without floating-point conversion", async () => {
      // [FIX — test data] The original single-row CSV tried to create a
      // genuinely NEW product ("سكر أبيض") whose only unit had
      // conversionFactor "50.25" — same invalid-fixture problem as test 2
      // above: a lone unit on a brand-new product must be the base unit
      // (factor === 1), so validatePackagingUnits() correctly rejected it
      // at preview time, and `newProductsCount` came back 0 instead of 1.
      //
      // Rather than flattening conversionFactor to "1" (which would lose
      // the point of testing decimal-precision preservation on a
      // non-trivial factor), this test now seeds an EXISTING product for
      // "سكر أبيض" that already has its own base unit (factor "1") — the
      // same "additional packaging unit" shape as the Name Collision test
      // above. The CSV row then legitimately adds "شوال 50كغ" (factor
      // 50.25) as a second, non-base unit, which validatePackagingUnits()
      // allows once a base unit already exists elsewhere on the product.
      // This keeps the test's original intent (decimal.js-level precision
      // for a fractional conversionFactor, plus quantity/price/priceRetail)
      // while respecting the real packaging-consistency rule.
      const existingProduct = {
        id: "prod-sugar-1",
        tenantId,
        name: "سكر أبيض",
        category: null,
        isPublic: false,
      };
      mockProductsInDb.push(existingProduct);
      mockUnitsInDb.push({
        id: "unit-sugar-base",
        tenantId,
        productId: existingProduct.id,
        unitName: "كيلو",
        conversionFactor: "1",
        priceWholesale: "9000",
        barcode: null,
        barcodeSource: null,
      });

      const csv = `name,unitName,conversionFactor,initialQuantity,initialBatchNumber,priceWholesale,priceRetail,barcode
سكر أبيض,شوال 50كغ,50.25,123.4567,B-SUGAR-1,450000.75,480000.5,621333444555`;

      const preview = await validateAndPreviewCsv(mockDb, tenantId, csv);
      expect(preview.summary.newProductsCount).toBe(1);
      const np = preview.newProducts[0];
      expect(np.conversionFactor).toBe("50.25");
      expect(np.initialQuantity).toBe("123.4567");
      expect(np.priceWholesale).toBe("450000.75");
      expect(np.priceRetail).toBe("480000.5");

      await commitCsvImport(mockDb, tenantId, {
        newProducts: [np],
        priceUpdates: [],
      });

      // [FIX] Look up the newly created unit/batch explicitly by barcode /
      // unitId instead of assuming index [0] — mockUnitsInDb[0] and
      // mockBatchesInDb[0] are now the pre-seeded base unit (which has no
      // batch at all), not the row this test is actually verifying.
      const unit = mockUnitsInDb.find((u) => u.barcode === "621333444555");
      expect(unit).toBeDefined();
      expect(unit.conversionFactor).toBe("50.25");
      expect(unit.priceWholesale).toBe("450000.75");
      expect(unit.priceRetail).toBe("480000.5");

      const batch = mockBatchesInDb.find((b) => b.unitId === unit.id);
      expect(batch).toBeDefined();
      expect(batch.quantity).toBe("123.4567");
    });
  });
});