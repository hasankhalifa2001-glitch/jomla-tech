/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * lib/data/__tests__/v47-receipts-gateway.test.ts
 *
 * [v4.7, Round A] The receiving gateway (lib/data/receipts.ts's
 * createReceiptWithBatches) — THE one path that writes a ProductReceipt.
 *
 * Pins:
 *  1. Atomicity: a failure on any line rolls back the receipt AND every batch
 *     (simulated with a snapshot/rollback $transaction fake — the REAL
 *     rollback semantics belong to Postgres; see t2a's own note on that).
 *  2. Validation: purchase date (required/valid/not future/not too old),
 *     suffix, line quantity/total rules — all DB-free, before any write.
 *  3. Conversion: the ENTERED unit's own factor converts the quantity
 *     (3 packs × factor 24 → 72 stored, never 3).
 *  4. totalCostSYP is EXACTLY the typed total, independent of the rounded
 *     costPricePerBaseUnit.
 *  5. Overflow guards: every decimal column written (quantity/initialQuantity
 *     18,4; totalCostSYP 18,4; costPricePerBaseUnit 18,8) rejects oversize
 *     values with a clear Arabic InvalidCostInputError — never a raw
 *     Postgres numeric-overflow 500.
 *  6. One batchNumber identity across every creation path (source scan).
 *  7. Static scans: productReceipt.create only in the gateway + seed; no
 *     initialQuantity/totalCostSYP inside any update payload; no nested
 *     writes in the receiving writers.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import {
  createReceiptWithBatches,
  ReceiptNotFoundForTenantError,
  purchaseDateSchema,
  supplierNameSchema,
} from "@/lib/data/receipts";
import { getBusinessDate, MAX_BACKDATE_DAYS } from "@/lib/inventory/date-utils";

// Mirrors the real gateway (a thin tenant-scoped passthrough).
vi.mock("@/lib/data/products", () => ({
  findProductUnitById: (tx: any, tenantId: string, unitId: string) =>
    tx.productUnit.findUnique({ where: { id: unitId, tenantId } }),
}));

const TENANT_ID = "tenant-1";
const USER_ID = "admin-1";
const PRODUCT_ID = "product-1";
const ENTRY_UNIT_ID = "unit-carton";
const BASE_UNIT_ID = "unit-piece";
const RECEIPT_DATE = "2026-01-15"; // fixed PAST date: valid under any real clock

/**
 * Fake tenant-scoped client whose $transaction snapshots both tables and
 * restores them on a throw — the same observable behaviour as a real
 * rollback, so "no receipt and no batches after a mid-loop failure" is
 * assertable without a database.
 */
function makeDb(options: { factor?: string; failOnBatchCreate?: number } = {}) {
  const factor = options.factor ?? "24";
  const receipts: any[] = [];
  const batches: any[] = [];

  const tx = {
    productReceipt: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `receipt-${receipts.length + 1}`, ...data };
        receipts.push(row);
        return row;
      }),
      // Tenant-verified lookup used by the existingReceiptId (CSV later-row)
      // path: the receipt must exist FOR THIS TENANT, or the gateway throws
      // ReceiptNotFoundForTenantError before writing anything.
      findFirst: vi.fn(async ({ where }: any) =>
        receipts.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null
      ),
    },
    productUnit: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === ENTRY_UNIT_ID
          ? {
              id: ENTRY_UNIT_ID,
              tenantId: TENANT_ID,
              productId: PRODUCT_ID,
              unitName: "كرتونة",
              isActive: true,
              conversionFactor: factor,
            }
          : null
      ),
      // getUnitConversionFactor() reads the ENTERED unit's own factor here.
      findUniqueOrThrow: vi.fn(async () => ({ conversionFactor: factor })),
    },
    product: {
      // requireBaseUnit() resolves the product's real base unit (factor 1).
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
        if (options.failOnBatchCreate && batches.length + 1 === options.failOnBatchCreate) {
          throw new Error(`forced failure on line ${batches.length + 1}`);
        }
        const row = { id: `batch-${batches.length + 1}`, ...data };
        batches.push(row);
        return row;
      }),
    },
  };

  const db = {
    receipts,
    batches,
    tx,
    $transaction: vi.fn(async (cb: (t: any) => Promise<any>) => {
      const receiptSnapshot = receipts.slice();
      const batchSnapshot = batches.slice();
      try {
        return await cb(tx);
      } catch (err) {
        receipts.length = 0;
        receipts.push(...receiptSnapshot);
        batches.length = 0;
        batches.push(...batchSnapshot);
        throw err;
      }
    }),
  };

  return { db, receipts, batches };
}

const baseInput = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  purchaseDate: RECEIPT_DATE,
  batchNumberSuffix: "INV4471",
};

function line(overrides: Record<string, unknown> = {}) {
  return {
    productId: PRODUCT_ID,
    entryUnitId: ENTRY_UNIT_ID,
    quantity: "3",
    totalCost: "100000",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe("1. Atomicity — a failure on ANY line leaves no receipt and no batches", () => {
  it("forced failure on the 3rd line rolls back the receipt and the first two batches", async () => {
    const { db } = makeDb({ factor: "1", failOnBatchCreate: 3 });

    await expect(
      db.$transaction((tx: any) =>
        createReceiptWithBatches(tx, {
          ...baseInput,
          lines: [line(), line(), line()],
        })
      )
    ).rejects.toThrow("forced failure on line 3");

    // The receipt was created FIRST, then batches 1 and 2 — the rollback
    // restores every table: zero receipts, zero batches, no partial state.
    expect(db.receipts).toHaveLength(0);
    expect(db.batches).toHaveLength(0);
  });

  it("writes the receipt BEFORE any batch, once, with every batch carrying its id", async () => {
    const { db } = makeDb({ factor: "1" });

    const result = await db.$transaction((tx: any) =>
      createReceiptWithBatches(tx, {
        ...baseInput,
        lines: [line(), line({ quantity: "5", totalCost: "50" })],
      })
    );

    expect(db.receipts).toHaveLength(1);
    expect(db.batches).toHaveLength(2);
    expect(result.receiptCreated).toBe(true);
    expect(result.receiptId).toBe(db.receipts[0].id);
    for (const b of db.batches) expect(b.receiptId).toBe(db.receipts[0].id);
    // Stored on the receipt exactly as validated (@db.Date = UTC midnight):
    expect(db.receipts[0].purchaseDate.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(db.receipts[0].tenantId).toBe(TENANT_ID);
    expect(db.receipts[0].createdByUserId).toBe(USER_ID);
    // supplierName absent → stored as null, never undefined/"":
    expect(db.receipts[0].supplierName).toBeNull();
  });

  it("existingReceiptId (CSV later rows) creates NO second receipt", async () => {
    const { db } = makeDb({ factor: "1" });
    // Row 1 of this same CSV file committed its receipt in its OWN
    // transaction; this later row adopts it through existingReceiptId.
    db.receipts.push({ id: "receipt-from-row-1", tenantId: TENANT_ID });

    const result = await db.$transaction((tx: any) =>
      createReceiptWithBatches(tx, {
        ...baseInput,
        existingReceiptId: "receipt-from-row-1",
        lines: [line()],
      })
    );

    expect(db.receipts).toHaveLength(1); // only row 1 receipt - NO SECOND
    expect(result.receiptCreated).toBe(false);
    expect(result.receiptId).toBe("receipt-from-row-1");
    expect(db.batches[0].receiptId).toBe("receipt-from-row-1");
  });

  it("existingReceiptId belonging to ANOTHER tenant is rejected (cross-tenant isolation)", async () => {
    const { db } = makeDb({ factor: "1" });
    db.receipts.push({ id: "receipt-of-tenant-2", tenantId: "tenant-2" });

    await expect(
      db.$transaction((tx: any) =>
        createReceiptWithBatches(tx, {
          ...baseInput,
          existingReceiptId: "receipt-of-tenant-2",
          lines: [line()],
        })
      )
    ).rejects.toThrow(ReceiptNotFoundForTenantError);

    // Nothing written: no batch under the foreign receipt, no new receipt.
    expect(db.batches).toHaveLength(0);
    expect(db.receipts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("2. Validation — DB-free, before any write", () => {
  /** Runs the gateway with a real fake-tx and asserts rejection + zero writes. */
  async function expectRejected(input: any, messagePart: string) {
    const { db } = makeDb();
    await expect(createReceiptWithBatches(db.tx as any, input)).rejects.toThrow(messagePart);
    expect(db.tx.productReceipt.create).not.toHaveBeenCalled();
    expect(db.tx.productBatch.create).not.toHaveBeenCalled();
  }

  it("rejects a purchase date in the future", async () => {
    await expectRejected(
      { ...baseInput, purchaseDate: "2999-01-01", lines: [line()] },
      "لا يمكن تسجيل استلام بتاريخ في المستقبل."
    );
  });

  it("rejects a purchase date older than MAX_BACKDATE_DAYS (730 days)", async () => {
    await expectRejected(
      { ...baseInput, purchaseDate: "1999-01-01", lines: [line()] },
      "730"
    );
    expect(MAX_BACKDATE_DAYS).toBe(730);
  });

  it("rejects a malformed / impossible purchase date", async () => {
    await expectRejected(
      { ...baseInput, purchaseDate: "2026-02-30", lines: [line()] },
      "تاريخ الشراء غير صالح."
    );
  });

  it("rejects a missing purchase date", async () => {
    const { purchaseDate: _dropped, ...without } = baseInput;
    const { db } = makeDb();
    await expect(
      createReceiptWithBatches(db.tx as any, { ...without, lines: [line()] } as any)
    ).rejects.toThrow();
    expect(db.tx.productReceipt.create).not.toHaveBeenCalled();
  });

  it("rejects non-padded / out-of-range date shapes before any comparison", () => {
    for (const bad of ["2026-6-15", "15-06-2026", "2026-13-01", "2026-06-15x", ""]) {
      expect(() => purchaseDateSchema.parse(bad)).toThrow();
    }
  });

  it("rejects an empty batch-number suffix", async () => {
    await expectRejected(
      { ...baseInput, batchNumberSuffix: "   ", lines: [line()] },
      "الجزء الخاص برقم الدفعة مطلوب"
    );
  });

  it("rejects a zero-quantity line", async () => {
    await expectRejected(
      { ...baseInput, lines: [line({ quantity: "0" })] },
      "الكمية يجب أن تكون أكبر من صفر"
    );
  });

  it("rejects a ZERO-TOTAL line and says WHY (zero-cost lines are not accepted)", async () => {
    await expectRejected(
      { ...baseInput, lines: [line({ totalCost: "0" })] },
      "لا يمكن قبول سطر بتكلفة صفر"
    );
  });

  it("rejects a line sending BOTH cost inputs, and a line sending neither", async () => {
    await expectRejected(
      { ...baseInput, lines: [line({ totalCost: "10", costPricePerBaseUnit: "5" })] },
      "بالظبط واحد منهما"
    );
    await expectRejected(
      { ...baseInput, lines: [line({ totalCost: undefined })] },
      "بالظبط واحد منهما"
    );
  });

  it("supplier: trimmed, empty collapses away, bounded at 120 chars", () => {
    expect(supplierNameSchema.parse("  مورد الشام  ")).toBe("مورد الشام");
    expect(supplierNameSchema.parse(undefined)).toBeUndefined();
    expect(supplierNameSchema.parse("")).toBe(""); // gateway maps "" → null
    expect(() => supplierNameSchema.parse("x".repeat(121))).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("3. Conversion — the ENTERED unit's own factor, never the base unit's (1)", () => {
  it("3 packs (factor 24) → initialQuantity/quantity 72 stored, never 3", async () => {
    const { db } = makeDb({ factor: "24" });

    const result = await db.$transaction((tx: any) =>
      createReceiptWithBatches(tx, {
        ...baseInput,
        lines: [line({ quantity: "3", totalCost: "100000" })],
      })
    );

    const stored = db.batches[0];
    // The entered unit's factor (24) did the conversion:
    expect(stored.quantity).toBe("72.0000");
    expect(stored.initialQuantity).toBe("72.0000");
    // If the BASE unit's factor (1) had been used, these would be "3.0000":
    expect(stored.quantity).not.toBe("3.0000");
    expect(stored.initialQuantity).not.toBe("3.0000");
    // Always scoped to the base unit, never the entered unit:
    expect(stored.unitId).toBe(BASE_UNIT_ID);
    // The per-unit derivation also used factor 24 (100000 / 72):
    expect(stored.costPricePerBaseUnit).toBe("1388.88888889");
    expect(result.created[0].baseQuantity).toBe("72.0000");
  });
});

// ---------------------------------------------------------------------------
describe("4. totalCostSYP — EXACTLY the typed total, independent of per-unit rounding", () => {
  it("100,000 SYP over 3 pieces stores totalCostSYP 100000.0000 verbatim", async () => {
    const { db } = makeDb({ factor: "1" });

    await db.$transaction((tx: any) =>
      createReceiptWithBatches(tx, {
        ...baseInput,
        lines: [line({ quantity: "3", totalCost: "100000" })],
      })
    );

    const stored = db.batches[0];
    // The typed total, byte-for-byte:
    expect(stored.totalCostSYP).toBe("100000.0000");
    // ...while the stored per-unit figure is the ROUNDED derivation:
    expect(stored.costPricePerBaseUnit).toBe("33333.33333333");
    // 33333.33333333 × 3 = 99999.99999999 ≠ the typed total at full
    // precision — the total is NEVER re-derived from the rounded price.
    expect(new Decimal(stored.costPricePerBaseUnit).times(3).toString()).toBe("99999.99999999");
    expect(stored.totalCostSYP).not.toBe("99999.99999999");
  });

  it("holds even where a re-derivation would visibly differ (1 SYP / 30000)", async () => {
    const { db } = makeDb({ factor: "1" });

    await db.$transaction((tx: any) =>
      createReceiptWithBatches(tx, {
        ...baseInput,
        lines: [line({ quantity: "30000", totalCost: "1" })],
      })
    );

    const stored = db.batches[0];
    expect(stored.totalCostSYP).toBe("1.0000");
    // perBase (8 dp) × qty rounds to "0.9999" — had the total been
    // re-derived from the rounded price, this is what it would have stored:
    expect(new Decimal(stored.costPricePerBaseUnit).times(30000).toFixed(4)).toBe("0.9999");
    expect(stored.totalCostSYP).not.toBe("0.9999");
  });

  it("CSV path: totalCostSYP = costPrice × baseQuantity, one multiply, one 4-dp round", async () => {
    const { db } = makeDb({ factor: "1" });

    await db.$transaction((tx: any) =>
      createReceiptWithBatches(tx, {
        ...baseInput,
        lines: [
          {
            productId: PRODUCT_ID,
            entryUnitId: ENTRY_UNIT_ID,
            quantity: "2",
            costPricePerBaseUnit: "1500.5",
          },
        ],
      })
    );

    const stored = db.batches[0];
    expect(stored.totalCostSYP).toBe("3001.0000");
    // The column's per-base price stored verbatim (not re-derived):
    expect(stored.costPricePerBaseUnit).toBe("1500.5");
  });
});

// ---------------------------------------------------------------------------
describe("5. Overflow guards — every decimal column, both paths, clear Arabic", () => {
  it("quantity/initialQuantity (18,4): converted value beyond the column is rejected", async () => {
    const { db } = makeDb({ factor: "24" });
    await expect(
      db.$transaction((tx: any) =>
        createReceiptWithBatches(tx, {
          ...baseInput,
          lines: [line({ quantity: "99999999999999", totalCost: "100000000" })],
        })
      )
    ).rejects.toMatchObject({
      code: "INVALID_COST_INPUT",
      message: expect.stringContaining("الكمية بعد التحويل إلى الوحدة الأساسية كبيرة جداً"),
    });
    // Validation failed inside the transaction → rollback, no partial state.
    expect(db.batches).toHaveLength(0);
    expect(db.receipts).toHaveLength(0);
  });

  it("totalCostSYP (18,4): CSV multiplication product beyond the column is rejected", async () => {
    const { db } = makeDb({ factor: "1" });
    await expect(
      db.$transaction((tx: any) =>
        createReceiptWithBatches(tx, {
          ...baseInput,
          lines: [
            {
              productId: PRODUCT_ID,
              entryUnitId: ENTRY_UNIT_ID,
              quantity: "100000",
              costPricePerBaseUnit: "9999999999.99999999",
            },
          ],
        })
      )
    ).rejects.toMatchObject({
      code: "INVALID_COST_INPUT",
      message: expect.stringContaining("إجمالي تكلفة السطر كبير جداً"),
    });
    expect(db.batches).toHaveLength(0);
  });

  it("costPricePerBaseUnit (18,8): an 11-integer-digit CSV price is rejected at the schema, with clear Arabic", async () => {
    // The gateway's receiptLineSchema carries COST_PER_BASE_UNIT_REGEX
    // (10 int + 8 dec = exactly the column), so an 11-digit integer fails
    // validation BEFORE createBatchRow — a ZodError the CSV row-level
    // catch turns into an import-report line (and the routes a 400), never
    // a Postgres overflow.
    const { db } = makeDb({ factor: "1" });
    await expect(
      db.$transaction((tx: any) =>
        createReceiptWithBatches(tx, {
          ...baseInput,
          lines: [
            {
              productId: PRODUCT_ID,
              entryUnitId: ENTRY_UNIT_ID,
              quantity: "1",
              costPricePerBaseUnit: "99999999999",
            },
          ],
        })
      )
    ).rejects.toThrow("حتى 8 خانات عشرية");
    expect(db.batches).toHaveLength(0);
    expect(db.receipts).toHaveLength(0);
  });

  it("costPricePerBaseUnit (18,8): an interactive derivation beyond the column is rejected", async () => {
    const { db } = makeDb({ factor: "1" });
    await expect(
      db.$transaction((tx: any) =>
        createReceiptWithBatches(tx, {
          ...baseInput,
          lines: [line({ quantity: "0.0001", totalCost: "99999999999999.9999" })],
        })
      )
    ).rejects.toMatchObject({
      code: "INVALID_COST_INPUT",
      message: expect.stringContaining("سعر الوحدة الأساسية الناتج كبير جداً"),
    });
    expect(db.receipts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Source-scan helpers: comments stripped so prose documenting a function is
// never counted as a call to it.
// ---------------------------------------------------------------------------
function readSource(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx === -1) return line;
      // Keep "://" (URLs) inside a line-comment candidate.
      if (line.slice(idx + 2).includes("://")) return line;
      return line.slice(0, idx);
    })
    .join("\n");
}

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git", "%TEMP%"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name))
      // Normalised separators so allow-lists written with "/" match on Windows.
      out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
  }
  return out;
}

// ---------------------------------------------------------------------------
describe("6. One batchNumber identity across every creation path", () => {
  it("gateway builds {businessDate}-{suffix} ONCE and shares it across all lines", async () => {
    const { db } = makeDb({ factor: "1" });

    const result = await db.$transaction((tx: any) =>
      createReceiptWithBatches(tx, {
        ...baseInput,
        batchNumberSuffix: "  INV9  ",
        lines: [line(), line({ quantity: "5", totalCost: "50" })],
      })
    );

    const expected = `${getBusinessDate()}-INV9`;
    expect(result.batchNumber).toBe(expected);
    expect(db.batches[0].batchNumber).toBe(expected);
    expect(db.batches[1].batchNumber).toBe(expected);
  });

  it("every creation path routes through the gateway; none builds a date prefix itself", () => {
    const paths = [
      "app/api/inventory/batches/route.ts",
      "app/api/inventory/batches/receipt/route.ts",
      "app/api/inventory/products/route.ts",
      "lib/inventory/csv-parser.ts",
    ];
    for (const rel of paths) {
      const code = stripComments(readSource(rel));
      expect(code, `${rel} must call the receiving gateway`).toContain("createReceiptWithBatches(");
      expect(
        code,
        `${rel} must not construct a batchNumber/date prefix on its own`
      ).not.toMatch(/constructBatchNumber\s*\(|buildServerDatePrefix\s*\(/);
    }
    // seed.ts is the documented exception (demo data): it writes its own
    // fixed-prefix receipt with a plain top-level create, never an API path.
    expect(stripComments(readSource("prisma/seed.ts"))).toContain("productReceipt.create");
  });
});

// ---------------------------------------------------------------------------
describe("7. Static scans — write-once + no nested writes + single receipt writer", () => {
  it("productReceipt.create appears ONLY in the gateway and seed.ts", () => {
    const allowed = new Set(["lib/data/receipts.ts", "prisma/seed.ts"]);
    const offenders = walkSourceFiles(process.cwd()).filter((rel) =>
      /productReceipt\s*\.\s*create\s*\(/.test(stripComments(readSource(rel)))
    );
    expect(offenders.filter((rel) => !allowed.has(rel))).toEqual([]);
    // ...and both sanctioned writers really are present:
    for (const rel of allowed) {
      expect(stripComments(readSource(rel))).toMatch(/productReceipt\s*\.\s*create\s*\(/);
    }
  });

  it("initialQuantity / totalCostSYP NEVER appear in an update/updateMany/upsert data payload", () => {
    const offenders: string[] = [];
    for (const rel of walkSourceFiles(process.cwd())) {
      const code = stripComments(readSource(rel));
      const call = /\b(update|updateMany|upsert)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = call.exec(code)) !== null) {
        // Locate the `data:` payload of this call (bounded brace match)...
        const dataIdx = code.indexOf("data", m.index);
        if (dataIdx === -1 || dataIdx - m.index > 500) continue;
        const braceStart = code.indexOf("{", dataIdx);
        if (braceStart === -1) continue;
        let depth = 0;
        let end = braceStart;
        for (; end < Math.min(code.length, braceStart + 3000); end++) {
          if (code[end] === "{") depth++;
          else if (code[end] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        const payload = code.slice(braceStart, end);
        if (/\binitialQuantity\b|\btotalCostSYP\b/.test(payload)) {
          offenders.push(`${rel} @ byte ${m.index} (${m[1]})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the receiving writers contain no nested writes (data: { create|update|upsert|... })", () => {
    const receivingWriters = [
      "lib/data/receipts.ts",
      "lib/inventory/batch-creation.ts",
      "lib/inventory/csv-parser.ts",
      "app/api/inventory/batches/route.ts",
      "app/api/inventory/batches/receipt/route.ts",
      "app/api/inventory/batches/[id]/route.ts",
      "app/api/inventory/products/route.ts",
      "app/api/inventory/import/commit/route.ts",
    ];
    const nested =
      /\bdata\s*:\s*\{[^{}]*\b(create|createMany|update|updateMany|upsert|set|disconnect)\s*:/;
    for (const rel of receivingWriters) {
      expect(nested.test(stripComments(readSource(rel))), `${rel} has a nested write`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// [v4.7, Round A — Phase 5] Tenant isolation. ProductReceipt is a
// tenant-scoped model, so getTenantDb()'s extension must inject tenantId into
// every read/list/mutate against it; the source-scan registration test mirrors
// the same guard t4e-addendum-merge.test.ts places on CustomerMergeLogItem, and
// the DMMF check proves the model actually carries the tenantId scalar +
// Tenant relation the extension scopes on. (The functional cross-tenant
// rejection of a foreign existingReceiptId is pinned in section 1 above.)
// ---------------------------------------------------------------------------
describe("8. Tenant isolation — ProductReceipt is a tenant-scoped model", () => {
  it("is registered in TENANT_SCOPED_MODELS in lib/db/tenant-scope.ts", () => {
    expect(stripComments(readSource("lib/db/tenant-scope.ts"))).toContain('"ProductReceipt"');
  });

  it("carries the tenantId scalar + Tenant relation the extension scopes on (DMMF)", () => {
    const models = (Prisma.dmmf as any).datamodel.models as {
      name: string;
      fields: { name: string; kind: string; type: string }[];
    }[];
    const receipt = models.find((m) => m.name === "ProductReceipt");
    expect(receipt).toBeDefined();
    const field = (name: string) => receipt!.fields.find((f) => f.name === name);
    expect(field("tenantId")?.kind).toBe("scalar");
    expect(field("tenant")?.type).toBe("Tenant");
  });
});
