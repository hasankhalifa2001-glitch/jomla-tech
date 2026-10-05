/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Decimal from "decimal.js";
import {
  createBatchRow,
  UnitNotBelongingToProductError,
  InactiveEntryUnitError,
  InvalidBatchNumberError,
} from "../batch-creation";
import { InvalidCostInputError } from "../units";

/**
 * [Batch cost entry] T3a (single-batch screen) + T4g (multi-product receipt):
 * the merchant enters the TOTAL paid for the received quantity, and the
 * system derives ProductBatch.costPricePerBaseUnit.
 *
 * These cases target lib/inventory/batch-creation.ts's createBatchRow()
 * directly, because that shared helper is where the derivation happens.
 * Route-level concerns (CASHIER -> 403, full batchNumber -> 400, client-sent
 * costPricePerBaseUnit -> 400, receipt atomicity) belong in a separate
 * route test file; they are NOT covered here.
 *
 * Two cost shapes are accepted, exactly one per call:
 *   - totalCost            — the two interactive screens.
 *   - costPricePerBaseUnit — CSV import and product-creation initialBatch.
 */

// Mirrors the real gateway (a thin tenant-scoped passthrough).
vi.mock("@/lib/data/products", () => ({
  findProductUnitById: (tx: any, tenantId: string, unitId: string) =>
    tx.productUnit.findUnique({ where: { id: unitId, tenantId } }),
}));

const TENANT_ID = "tenant-1";
const PRODUCT_ID = "product-1";
const ENTRY_UNIT_ID = "unit-carton";
const BASE_UNIT_ID = "unit-piece";
const PACK_FACTOR = "6";

interface FakeTxOptions {
  /** Simulates a unit that belongs to some OTHER product. */
  entryUnitProductId?: string;
  /** Simulates a unit id that does not exist for this tenant. */
  unitMissing?: boolean;
  unitActive?: boolean;
  factor?: string;
}

function makeTx(options: FakeTxOptions = {}) {
  const created: any[] = [];
  const factor = options.factor ?? PACK_FACTOR;

  const tx = {
    productUnit: {
      findUnique: vi.fn(async ({ where }: any) =>
        !options.unitMissing && where.id === ENTRY_UNIT_ID
          ? {
            id: ENTRY_UNIT_ID,
            tenantId: TENANT_ID,
            productId: options.entryUnitProductId ?? PRODUCT_ID,
            unitName: "طرد",
            isActive: options.unitActive ?? true,
            conversionFactor: factor,
          }
          : null
      ),
      // getUnitConversionFactor() reads the ENTERED unit's own factor here.
      findUniqueOrThrow: vi.fn(async () => ({ conversionFactor: factor })),
    },
    product: {
      // requireBaseUnit() resolves the product's real base unit here.
      findUniqueOrThrow: vi.fn(async () => ({
        id: PRODUCT_ID,
        baseUnitId: BASE_UNIT_ID,
        baseUnit: {
          id: BASE_UNIT_ID,
          productId: PRODUCT_ID,
          unitName: "قطعة",
          conversionFactor: "1",
          isActive: true,
        },
      })),
    },
    productBatch: {
      create: vi.fn(async ({ data }: any) => {
        created.push(data);
        return { id: "batch-1", batchNumber: data.batchNumber };
      }),
    },
  };

  return { tx, created };
}

const baseInput = {
  tenantId: TENANT_ID,
  productId: PRODUCT_ID,
  entryUnitId: ENTRY_UNIT_ID,
  batchNumber: "2026-09-28-INV4471",
};

// ---------------------------------------------------------------------------
describe("createBatchRow — totalCost path (T3a + T4g)", () => {
  it("stores the derived per-base-unit cost and converted base quantity (6 طرد for 54,000)", async () => {
    const { tx, created } = makeTx();

    const row = await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "6",
      totalCost: "54000",
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      // ALWAYS the product's base unit — never the unit it was entered in.
      unitId: BASE_UNIT_ID,
      batchNumber: "2026-09-28-INV4471",
      quantity: "36.0000", // 6 x factor 6
      costPricePerBaseUnit: "1500.00000000", // 54,000 / 36
    });

    expect(row.baseQuantity).toBe("36.0000");
    expect(row.costPricePerBaseUnit).toBe("1500.00000000");
    expect(row.resolvedBaseUnitId).toBe(BASE_UNIT_ID);
    expect(row.resolvedBaseUnitName).toBe("قطعة");
    expect(row.enteredUnitName).toBe("طرد");
  });

  it("keeps 8 decimals for a non-terminating per-base cost (100 SYP over 3 pieces)", async () => {
    const { tx, created } = makeTx({ factor: "1" });

    const row = await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "3",
      totalCost: "100",
    });

    // 4 dp would have stored 33.3333.
    expect(created[0].costPricePerBaseUnit).toBe("33.33333333");
    expect(row.costPricePerBaseUnit).toBe("33.33333333");

    // For a small quantity, multiplying back and rounding to the column's
    // 4 dp reproduces the typed total exactly.
    const back = new Decimal(row.costPricePerBaseUnit)
      .times(row.baseQuantity)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    expect(back.toFixed(4)).toBe("100.0000");
  });

  it.each([
    { name: "small", qty: "3", factor: "1", total: "100" },
    { name: "carton x12", qty: "7", factor: "12", total: "123456" },
    { name: "250k pieces", qty: "250000", factor: "1", total: "1000000" },
    { name: "1M x3 pieces", qty: "1000000", factor: "3", total: "999999.99" },
  ])(
    "reconciles perBase x baseQuantity with the paid total within the rounding bound ($name)",
    async ({ qty, factor, total }) => {
      const { tx } = makeTx({ factor });

      const row = await createBatchRow(tx as any, {
        ...baseInput,
        quantityInEntryUnit: qty,
        totalCost: total,
      });

      // Independent reference, computed outside the application code.
      const baseQty = new Decimal(qty).times(factor);
      expect(row.baseQuantity).toBe(baseQty.toFixed(4));

      // Rounding perBase to 8 dp can be off by at most 0.5e-8 per unit, so
      // the reconstructed total is off by at most baseQty x 0.5e-8. (This is
      // why exact 4-dp equality is only guaranteed for small quantities.)
      const diff = new Decimal(row.costPricePerBaseUnit)
        .times(row.baseQuantity)
        .minus(total)
        .abs();
      const bound = baseQty.times("0.000000005").plus("0.000000001");
      expect(diff.lte(bound)).toBe(true);
    }
  );

  it("handles fractional quantity x fractional factor without drift (2.5 x 3.3 = 8.25)", async () => {
    const { tx, created } = makeTx({ factor: "3.3" });

    const row = await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "2.5",
      totalCost: "8250",
    });

    expect(created[0].quantity).toBe("8.2500");
    expect(row.costPricePerBaseUnit).toBe("1000.00000000");
  });

  it("works when the entry unit IS the base unit (factor = 1)", async () => {
    const { tx, created } = makeTx({ factor: "1" });

    await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "10",
      totalCost: "5000",
    });

    expect(created[0].quantity).toBe("10.0000");
    expect(created[0].costPricePerBaseUnit).toBe("500.00000000");
  });

  it("accepts a large but valid total (9,000,000,000 over 3 pieces)", async () => {
    const { tx, created } = makeTx({ factor: "1" });

    await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "3",
      totalCost: "9000000000",
    });

    expect(created[0].costPricePerBaseUnit).toBe("3000000000.00000000");
  });

  it("rejects a total whose per-base cost overflows Decimal(18,8)", async () => {
    const { tx, created } = makeTx({ factor: "1" });

    await expect(
      createBatchRow(tx as any, {
        ...baseInput,
        quantityInEntryUnit: "1",
        totalCost: "99999999999999",
      })
    ).rejects.toThrow(InvalidCostInputError);

    expect(created).toHaveLength(0);
  });

  it("rejects a base quantity that overflows Decimal(18,4) after conversion", async () => {
    const { tx, created } = makeTx({ factor: "6" });

    await expect(
      createBatchRow(tx as any, {
        ...baseInput,
        quantityInEntryUnit: "99999999999999", // passes its own 14-digit limit
        totalCost: "99999999999999",
      })
    ).rejects.toThrow(InvalidCostInputError);

    expect(created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("createBatchRow — input validation happens before any DB access", () => {
  it.each([
    { name: "total = 0", qty: "6", total: "0" },
    { name: "total negative", qty: "6", total: "-5" },
    { name: "total non-numeric", qty: "6", total: "abc" },
    { name: "total empty", qty: "6", total: "" },
    { name: "total with 5 decimals", qty: "6", total: "10.00001" },
    { name: "quantity = 0", qty: "0", total: "100" },
    { name: "quantity negative", qty: "-1", total: "100" },
    { name: "quantity with 5 decimals", qty: "1.00001", total: "100" },
    { name: "quantity empty", qty: "", total: "100" },
  ])("rejects: $name", async ({ qty, total }) => {
    const { tx, created } = makeTx();

    await expect(
      createBatchRow(tx as any, {
        ...baseInput,
        quantityInEntryUnit: qty,
        totalCost: total,
      })
    ).rejects.toThrow(InvalidCostInputError);

    expect(created).toHaveLength(0);
    expect(tx.productUnit.findUnique).not.toHaveBeenCalled();
    expect(tx.product.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("rejects when neither totalCost nor costPricePerBaseUnit is supplied", async () => {
    const { tx, created } = makeTx();

    await expect(
      createBatchRow(tx as any, { ...baseInput, quantityInEntryUnit: "6" } as any)
    ).rejects.toThrow(InvalidCostInputError);

    expect(created).toHaveLength(0);
  });

  // REQUIRES the small patch in createBatchRow: throw InvalidCostInputError
  // when both totalCost and costPricePerBaseUnit are defined (silent
  // precedence hides programming errors and forged payloads).
  it("rejects a payload carrying BOTH totalCost and costPricePerBaseUnit", async () => {
    const { tx, created } = makeTx();

    const forgedInput: any = {
      ...baseInput,
      quantityInEntryUnit: "6",
      totalCost: "54000",
      costPricePerBaseUnit: "999",
    };

    await expect(createBatchRow(tx as any, forgedInput)).rejects.toThrow(InvalidCostInputError);
    expect(created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("createBatchRow — costPricePerBaseUnit path (CSV import / product creation)", () => {
  it("stores a per-base-unit figure verbatim while still converting the quantity", async () => {
    const { tx, created } = makeTx({ factor: "24" });

    const row = await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "15",
      costPricePerBaseUnit: "85000",
    });

    // 15 x 24 = 360 base units; cost taken as-is, never divided by the factor.
    expect(created[0].quantity).toBe("360.0000");
    expect(created[0].costPricePerBaseUnit).toBe("85000");
    expect(row.costPricePerBaseUnit).toBe("85000");
  });

  it("keeps up to 8 decimals verbatim", async () => {
    const { tx, created } = makeTx({ factor: "1" });

    await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "1",
      costPricePerBaseUnit: "33.33333333",
    });

    expect(created[0].costPricePerBaseUnit).toBe("33.33333333");
  });

  it.each([
    { name: "9 decimals", value: "1.123456789" },
    { name: "zero", value: "0" },
    { name: "negative", value: "-1" },
    { name: "11 integer digits", value: "12345678901" },
    { name: "non-numeric", value: "abc" },
  ])("rejects an invalid per-base cost: $name", async ({ value }) => {
    const { tx, created } = makeTx({ factor: "1" });

    await expect(
      createBatchRow(tx as any, {
        ...baseInput,
        quantityInEntryUnit: "1",
        costPricePerBaseUnit: value,
      })
    ).rejects.toThrow(InvalidCostInputError);

    expect(created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("createBatchRow — guards every batch-creating screen shares", () => {
  it("rejects an entry unit belonging to a different product", async () => {
    const { tx, created } = makeTx({ entryUnitProductId: "product-other" });

    await expect(
      createBatchRow(tx as any, { ...baseInput, quantityInEntryUnit: "1", totalCost: "100" })
    ).rejects.toThrow(UnitNotBelongingToProductError);

    expect(created).toHaveLength(0);
  });

  it("rejects an entry unit that does not exist for this tenant", async () => {
    const { tx, created } = makeTx({ unitMissing: true });

    await expect(
      createBatchRow(tx as any, { ...baseInput, quantityInEntryUnit: "1", totalCost: "100" })
    ).rejects.toThrow(UnitNotBelongingToProductError);

    expect(created).toHaveLength(0);
  });

  it("rejects a deactivated entry unit", async () => {
    const { tx, created } = makeTx({ unitActive: false });

    await expect(
      createBatchRow(tx as any, { ...baseInput, quantityInEntryUnit: "1", totalCost: "100" })
    ).rejects.toThrow(InactiveEntryUnitError);

    expect(created).toHaveLength(0);
  });

  it("scopes every lookup and the write to the tenant", async () => {
    const { tx, created } = makeTx();

    await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "6",
      totalCost: "54000",
    });

    // Entry unit lookup (via findProductUnitById).
    expect(tx.productUnit.findUnique).toHaveBeenCalledWith({
      where: { id: ENTRY_UNIT_ID, tenantId: TENANT_ID },
    });
    // Entered unit's own factor (getUnitConversionFactor).
    expect(tx.productUnit.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ENTRY_UNIT_ID, tenantId: TENANT_ID } })
    );
    // Base unit resolution (requireBaseUnit).
    expect(tx.product.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PRODUCT_ID, tenantId: TENANT_ID } })
    );
    // The row itself.
    expect(created[0].tenantId).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
describe("createBatchRow — expiry date", () => {
  it("stores null when no expiry date is given", async () => {
    const { tx, created } = makeTx();

    await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "6",
      totalCost: "54000",
    });

    expect(created[0].expiryDate).toBeNull();
  });

  it("stores a Date when an expiry date is given", async () => {
    const { tx, created } = makeTx();

    await createBatchRow(tx as any, {
      ...baseInput,
      quantityInEntryUnit: "6",
      totalCost: "54000",
      expiryDate: "2026-12-31",
    });

    expect(created[0].expiryDate).toEqual(new Date("2026-12-31"));
  });
});

// ---------------------------------------------------------------------------
describe("createBatchRow — batchNumber input", () => {
  const { batchNumber: _unused, ...inputWithoutBatchNumber } = baseInput;

  beforeEach(() => {
    // Only Date is faked so async/await keeps working. Noon UTC keeps the
    // calendar day 2026-09-28 in every timezone from UTC-11 to UTC+11
    // (including Asia/Damascus), so this test does not depend on the CI's TZ.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds {server-date}-{suffix} from batchNumberSuffix", async () => {
    const { tx, created } = makeTx();

    const row = await createBatchRow(tx as any, {
      ...inputWithoutBatchNumber,
      batchNumberSuffix: "  INV4471  ",
      quantityInEntryUnit: "6",
      totalCost: "54000",
    });

    expect(created[0].batchNumber).toBe("2026-09-28-INV4471");
    expect(row.batchNumber).toBe("2026-09-28-INV4471");
  });

  it("rejects a blank suffix before touching the DB", async () => {
    const { tx, created } = makeTx();

    await expect(
      createBatchRow(tx as any, {
        ...inputWithoutBatchNumber,
        batchNumberSuffix: "   ",
        quantityInEntryUnit: "6",
        totalCost: "54000",
      })
    ).rejects.toThrow(InvalidBatchNumberError);

    expect(created).toHaveLength(0);
    expect(tx.productUnit.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no date prefix", value: "INV4471" },
    { name: "date without suffix", value: "2026-09-28" },
    { name: "empty", value: "" },
  ])("rejects an already-constructed batchNumber with $name", async ({ value }) => {
    const { tx, created } = makeTx();

    await expect(
      createBatchRow(tx as any, {
        ...baseInput,
        batchNumber: value,
        quantityInEntryUnit: "6",
        totalCost: "54000",
      })
    ).rejects.toThrow(InvalidBatchNumberError);

    expect(created).toHaveLength(0);
  });

  it("rejects when both batchNumber and batchNumberSuffix are passed", async () => {
    const { tx, created } = makeTx();

    const both: any = {
      ...baseInput,
      batchNumberSuffix: "X",
      quantityInEntryUnit: "6",
      totalCost: "54000",
    };

    await expect(createBatchRow(tx as any, both)).rejects.toThrow();
    expect(created).toHaveLength(0);
  });
});