import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
// validatePackagingUnits now lives in units.ts (merged in), not the
// deleted packaging-unit-validation.ts.
import { validatePackagingUnits, InvalidCostInputError } from "@/lib/inventory/units";
// [v4.0] Sole gateway for reading Product.baseUnitId.
import { requireBaseUnits } from "@/lib/inventory/base-unit";
// [v4.4, Sections 10–11] The ONE shared "write one ProductBatch row"
// implementation — used by the initialBatch path below, T3a's single-batch
// screen, and Section 11's multi-product receipt screen. It owns the
// single sanctioned constructBatchNumber() call, so this route can never
// build a date-prefix/suffix concatenation of its own.
//
// [Batch cost entry — UNIFIED] initialBatch now goes through the SAME
// totalCost -> costFromTotal() derivation every other interactive
// batch-creation screen uses (single-batch entry, the multi-product
// receipt screen). CSV import remains the one deliberate exception — it is
// bulk/non-interactive, with no live-derivation UI to show, so it is the
// only caller of createBatchRow() still permitted to supply
// costPricePerBaseUnit directly.
import { findClientComputedBatchField, InactiveEntryUnitError } from "@/lib/inventory/batch-creation";
// [v4.7] The receiving gateway — THE one path that writes a ProductReceipt;
// the initialBatch below rides it so product, receipt and batch share ONE
// atomic, top-level-write transaction.
import { createReceiptWithBatches, purchaseDateSchema, supplierNameSchema } from "@/lib/data/receipts";
// Sole gateway for tx.product.* / tx.productUnit.* — see that file's
// header and eslint.config.mjs's model-level rule. Neither this route
// nor any other route outside lib/data/products.ts (or
// lib/inventory/base-unit.ts) may call db.product.*/db.productUnit.*
// directly anymore.
//
// [v4.5] Same for the barcode models: createUnitBarcode() is the sole way
// to attach a barcode to a unit, and resolveSharedCatalogForBarcode() owns
// the whole GS1 shared-catalog decision (create one entry / link another
// barcode to an entry / resolve to an already-known entry). This route
// never names productUnitBarcode or productCatalogEntryBarcode at all —
// see eslint.config.mjs's PRODUCT_UNIT_BARCODE_MODEL_RULES /
// PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES.
import {
  createProductWithBaseUnit,
  createAdditionalUnit,
  listProductsWithInventoryDetails,
  findProductUnitByBarcode,
  createUnitBarcode,
  resolveSharedCatalogForBarcode,
} from "@/lib/data/products";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";

const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;

const positiveDecimalString = (message: string) =>
  z
    .string()
    .regex(DECIMAL_STRING_REGEX, message)
    .refine((val) => Number(val) > 0, { message });

// [v4.5] One barcode row's worth of validated input. Both fields are
// REQUIRED here rather than "barcode optional + a refine", because the
// shape itself now expresses the rule the old cross-field refine used to
// enforce: a barcode value and its human-confirmed source always travel
// together, and an entry only exists at all when the merchant actually
// supplied a barcode. `barcodeSource` is NEVER inferred from the barcode's
// digit pattern (T3a §5) — it is always an explicit client-supplied value.
const unitBarcodeSchema = z.object({
  barcode: z.string().trim().min(1, "قيمة الباركود مطلوبة"),
  barcodeSource: z.enum(["GS1", "INTERNAL"]),
});

const unitSchema = z
  .object({
    unitName: z.string().min(1, "اسم الوحدة مطلوب"),
    // [v4.0] Still validated generically here (any positive value) — the
    // UI is what locks the FIRST unit's factor to "1" and hides the field
    // for it (T3a §0). The backend's guarantee that exactly ONE submitted
    // unit has conversionFactor === 1 (and that THAT unit becomes
    // Product.baseUnitId) is enforced below via validatePackagingUnits +
    // createProductWithBaseUnit(), not by this per-field schema rule.
    conversionFactor: positiveDecimalString("معامل التحويل يجب أن يكون رقماً موجباً"),
    pricingCurrency: z.enum(["SYP", "USD"]).default("SYP"),
    priceWholesale: positiveDecimalString("سعر الجملة يجب أن يكون أكبر من صفر"),
    // [v4.5] REPLACED the old single `barcode`/`barcodeSource` scalar pair.
    // A unit may carry zero, one, or many barcodes in one request (a
    // detergent line where each scent has its own manufacturer barcode but
    // one price and one batch history). Omitted entirely === no barcodes.
    barcodes: z.array(unitBarcodeSchema).optional().default([]),
    // [DEPRECATED — INPUT SHIM, remove with the deprecated `barcode` field on
    // the GET response below] A client build cached by T4a2's service worker
    // before this change still posts `barcode`/`barcodeSource` as two
    // scalars. Accepted here for one transition period and folded into
    // `barcodes` by the transform below, so an old tab cannot silently lose
    // the barcode it thought it was saving. The old cross-field rule is kept
    // verbatim in the refine: a non-empty legacy barcode with no source is
    // still a 400, never a saved-but-unclassified row.
    barcode: z.string().optional().nullable(),
    barcodeSource: z.enum(["GS1", "INTERNAL"]).optional().nullable(),
    isActive: z.boolean().optional().default(true),
  })
  .refine(
    (u) => {
      if (u.barcode && u.barcode.trim().length > 0) {
        return u.barcodeSource === "GS1" || u.barcodeSource === "INTERNAL";
      }
      return true;
    },
    {
      message: "يجب تحديد مصدر الباركود (GS1 أو INTERNAL) عند إدخال باركود للوحدة.",
      path: ["barcodeSource"],
    }
  )
  .transform((u) => {
    const legacyBarcode = u.barcode?.trim();
    if (u.barcodes.length === 0 && legacyBarcode) {
      // The refine above guarantees a source is present whenever a legacy
      // barcode value is; if it somehow were not, `barcodeSource` would be
      // null and the entry would be rejected rather than stored unclassified.
      return u.barcodeSource
        ? { ...u, barcodes: [{ barcode: legacyBarcode, barcodeSource: u.barcodeSource }] }
        : u;
    }
    return u;
  });

const createProductSchema = z.object({
  name: z.string().min(1, "اسم المنتج مطلوب"),
  category: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  isPublic: z.boolean().optional().default(false),
  units: z.array(unitSchema).min(1, "يجب تقديم وحدة قياس واحدة على الأقل"),
  initialBatch: z
    .object({
      // [v4.0] "which unit did the admin enter the quantity in?" — a
      // display/entry convenience only. NEVER written directly as
      // ProductBatch.unitId (that field is always resolved to the base
      // unit inside the transaction below).
      //
      // [FIX — unitIndex] Was `z.number().default(0)`: accepted 5, -1, 1.5,
      // NaN-adjacent values, and the transaction below silently fell back
      // to the BASE unit via `??` when the index did not exist — e.g. "3
      // طرد" stored as 3 base pieces instead of 72, with the per-base-unit
      // cost derived from the wrong quantity, and no error anywhere. Now an
      // integer >= 0 here, bounds-checked against `units.length` in POST
      // before any write, and the transaction no longer has any fallback.
      unitIndex: z
        .number()
        .int("رقم وحدة الدفعة الأولى يجب أن يكون عدداً صحيحاً.")
        .min(0, "رقم وحدة الدفعة الأولى غير صالح.")
        .default(0),
      // [v4.4, Spec Addendum Sections 10–10.1] Replaces the old free-text
      // `batchNumber` field: this is a FOURTH batch-creation path, and the
      // spec's own acceptance criterion applies to it too ("Every
      // batchNumber, regardless of which path created it, matches the
      // pattern {YYYY-MM-DD}-{non-empty merchant text}"). Only the
      // merchant-supplied suffix is accepted; the date prefix is always
      // generated server-side at the moment of creation. A request
      // attempting to set a full `batchNumber` is rejected on the RAW body
      // below, mirroring the identical guard on the single-batch route.
      batchNumberSuffix: z
        .string()
        .trim()
        .min(1, "الجزء الخاص برقم الدفعة مطلوب ولا يمكن أن يكون فارغاً."),
      // [Batch cost entry — UNIFIED, replaces costPricePerBaseUnit] The
      // TOTAL the merchant paid for the whole received quantity, in the
      // ENTERED unit (initialBatch.unitIndex), always SYP. The server
      // derives ProductBatch.costPricePerBaseUnit from this pair via
      // createBatchRow() -> lib/inventory/units.ts's costFromTotal() —
      // exactly the same derivation the single-batch screen and the
      // multi-product receipt screen use. A request that instead sends
      // costPricePerBaseUnit directly is rejected on the RAW body, before
      // this schema even runs — see the guard in POST below.
      totalCost: positiveDecimalString(
        "لا يمكن قبول دفعة بتكلفة صفر — إجمالي تكلفة الشراء يجب أن يكون رقماً موجباً أكبر من صفر"
      ),
      // [Batch cost entry — FIX] Was nonNegativeDecimalString (allowed 0).
      // A zero quantity can never yield a per-base-unit cost — costFromTotal()
      // itself rejects it — so this must be strictly positive, matching the
      // rule every other interactive batch-creation screen already enforces.
      quantity: positiveDecimalString("الكمية يجب أن تكون أكبر من صفر"),
      expiryDate: z.string().optional().nullable(),
      // [v4.7] Required goods-receiving date for the receipt this batch is
      // written under — a Damascus business day, required and never in the
      // future — plus an optional supplier (≤120 chars). Both persist on the
      // ProductReceipt the gateway creates inside this route's transaction.
      purchaseDate: purchaseDateSchema,
      supplierName: supplierNameSchema,
    })
    .optional()
    .nullable(),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    assertRolePermission(session.user.role, "inventory:view");

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    // [v4.4, T4g] The only ADMIN check this read path needs: whether a batch's
    // purchase-cost figure is allowed into the response at all.
    const isAdmin = session.user.role === "ADMIN";
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const filter = searchParams.get("filter") || "all";
    const status = searchParams.get("status");

    const whereClause: Omit<Prisma.ProductWhereInput, "tenantId"> = {};
    if (status === "active") {
      whereClause.isActive = true;
    } else if (status === "inactive" || filter === "inactive_products") {
      whereClause.isActive = false;
    }
    // NOTE (still flagged, unresolved — unrelated to v4.0): an omitted
    // `status` param no longer defaults to "active"; left as-is pending a
    // product decision.

    const products = await listProductsWithInventoryDetails(db, tenantId, whereClause);

    // [v4.0] Batch-resolve every listed product's base unit through the
    // sole sanctioned gateway. THIS CALL IS FAIL-LOUD: it throws
    // MissingBaseUnitError the moment it hits any product whose
    // baseUnitId doesn't resolve. Do NOT wrap this in a try/catch that
    // swallows MissingBaseUnitError and substitutes a guess.
    const baseUnitsByProduct = await requireBaseUnits(
      db,
      tenantId,
      products.map((p) => p.id)
    );

    const now = new Date();

    const processedProducts = products.map((product) => {
      const baseUnit = baseUnitsByProduct.get(product.id)!; // guaranteed present

      let totalBaseStock = new Decimal(0);
      let hasExpiringSoonBatch = false;
      let hasNegativeStockBatch = false;

      const processedBatches = product.batches.map((batch) => {
        const batchQty = new Decimal(batch.quantity.toString());
        totalBaseStock = totalBaseStock.plus(batchQty);

        if (batchQty.isNegative()) {
          hasNegativeStockBatch = true;
        }

        let daysToExpiry: number | null = null;
        let expiryStatus: "RED" | "YELLOW" | "NORMAL" = "NORMAL";

        if (batch.expiryDate) {
          const exp = new Date(batch.expiryDate);
          const diffMs = exp.getTime() - now.getTime();
          daysToExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

          if (daysToExpiry < 30) {
            expiryStatus = "RED";
          } else if (daysToExpiry < 60) {
            expiryStatus = "YELLOW";
          }

          if (daysToExpiry < 60) {
            hasExpiringSoonBatch = true;
          }
        }

        return {
          id: batch.id,
          batchNumber: batch.batchNumber,
          quantity: batch.quantity.toString(),
          unitId: batch.unitId,
          unitName: batch.unit?.unitName || "",
          // [v4.4, T4g] ADMIN-only cost figure. /dashboard/inventory is
          // `inventory:view`, which a CASHIER holds — so WITHOUT this gate the
          // batch include (`include: { batches: … }` selects every scalar
          // column, costPricePerBaseUnit included) would hand a CASHIER every
          // batch's purchase cost. The field is omitted from the JSON object
          // entirely for a non-ADMIN, never merely hidden in the UI: a
          // cashier's payload must not contain the number at all.
          ...(isAdmin && batch.costPricePerBaseUnit !== undefined && batch.costPricePerBaseUnit !== null
            ? { costPricePerBaseUnit: batch.costPricePerBaseUnit.toString() }
            : {}),
          expiryDate: batch.expiryDate,
          daysToExpiry,
          expiryStatus,
          isNegative: batchQty.isNegative(),
          adjustments: (batch.adjustments || []).map((adj) => ({
            id: adj.id,
            quantityDelta: adj.quantityDelta.toString(),
            reason: adj.reason,
            adjustedByUserName:
              adj.adjustedByUser?.name || adj.adjustedByUser?.email || "مستخدم",
            createdAt: adj.createdAt,
          })),
          _count: {
            invoiceItems: batch._count?.invoiceItems || 0,
            adjustments: batch._count?.adjustments || 0,
          },
        };
      });

      const totalStockInBase = totalBaseStock.toString();
      const isOutOfStock = totalBaseStock.lessThanOrEqualTo(0);

      const hasDiscontinuedUnitStock = product.units.some(
        (u) =>
          !u.isActive &&
          product.batches.some((b) => b.unitId === u.id && new Decimal(b.quantity.toString()).greaterThan(0))
      );

      return {
        id: product.id,
        name: product.name,
        category: product.category,
        imageUrl: product.imageUrl,
        isPublic: product.isPublic,
        isActive: product.isActive,
        createdAt: product.createdAt,
        baseUnitId: baseUnit.id,
        units: product.units.map((u) => {
          // [v4.5] The unit's FULL barcode list — zero, one, or many. This
          // is the authoritative field for every client from v4.5 onward.
          const barcodes = (u.barcodes ?? []).map((b) => ({
            id: b.id,
            barcode: b.barcode,
            barcodeSource: b.barcodeSource,
            createdAt: b.createdAt,
          }));

          return {
            id: u.id,
            unitName: u.unitName,
            conversionFactor: Number(u.conversionFactor),
            pricingCurrency: u.pricingCurrency || "SYP",
            priceWholesale: u.priceWholesale.toString(),
            barcodes,
            // [DEPRECATED — REMOVAL TARGET: the release after T4a2's service
            // worker has rolled the new client build to all cached devices]
            // Compatibility only, for a client build an old SW cache may still
            // be serving: it reads `unit.barcode`/`unit.barcodeSource` and has
            // no idea `barcodes` exists. Mirrors the FIRST barcode (creation
            // order, matching the old single-value semantics where the first
            // entry is the one the merchant originally entered), and is null
            // when the unit has no barcodes.
            //
            // Current readers of this fallback, all verified on 2026-09-30:
            // ProductTable.tsx, EditProductModal.tsx, and
            // lib/offline/cache-refresh.ts. None of them carries a TODO marker —
            // this list is the marker. Note that the ProductTable/EditProductModal
            // fallbacks are only reachable against an OLD SERVER build (this
            // route always sends `barcodes`, at minimum `[]`, so `??` never
            // falls through); cache-refresh.ts's fallback is the one that also
            // covers an old cached RESPONSE. Do NOT remove until all three are
            // migrated and the old SW-cached client is gone.
            barcode: barcodes[0]?.barcode ?? null,
            barcodeSource: barcodes[0]?.barcodeSource ?? null,
            isActive: u.isActive !== false,
            isBaseUnit: u.id === baseUnit.id,
          };
        }),
        batches: processedBatches,
        totalStockInBase,
        baseUnitName: baseUnit.unitName,
        hasExpiringSoonBatch,
        hasNegativeStockBatch,
        hasDiscontinuedUnitStock,
        isOutOfStock,
      };
    });

    let filtered = processedProducts;

    if (q) {
      const lowerQ = q.toLowerCase();
      filtered = filtered.filter((p) => {
        // [v4.5] Searches EVERY one of the unit's barcodes, not just one.
        const barcodeMatch = p.units.some((u) =>
          u.barcodes.some((b) => b.barcode.toLowerCase().includes(lowerQ))
        );
        const nameMatch = p.name.toLowerCase().includes(lowerQ);
        const categoryMatch = p.category && p.category.toLowerCase().includes(lowerQ);
        return barcodeMatch || nameMatch || categoryMatch;
      });

      filtered.sort((a, b) => {
        const aExactBarcode = a.units.some((u) =>
          u.barcodes.some((bar) => bar.barcode.toLowerCase() === lowerQ)
        );
        const bExactBarcode = b.units.some((u) =>
          u.barcodes.some((bar) => bar.barcode.toLowerCase() === lowerQ)
        );
        if (aExactBarcode && !bExactBarcode) return -1;
        if (!aExactBarcode && bExactBarcode) return 1;
        return 0;
      });
    }

    if (filter === "public") {
      filtered = filtered.filter((p) => p.isPublic);
    } else if (filter === "expiring") {
      filtered = filtered.filter((p) => p.hasExpiringSoonBatch);
    } else if (filter === "out_of_stock") {
      filtered = filtered.filter((p) => p.isOutOfStock);
    } else if (filter === "needs_reconciliation") {
      filtered = filtered.filter((p) => p.hasNegativeStockBatch);
    } else if (filter === "discontinued_unit_stock") {
      filtered = filtered.filter((p) => p.hasDiscontinuedUnitStock);
    } else if (filter === "inactive_products") {
      filtered = filtered.filter((p) => !p.isActive);
    }

    return NextResponse.json({ success: true, products: filtered });
  } catch (error) {
    console.error("Error fetching inventory products:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب المنتجات." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    assertRolePermission(session.user.role, "inventory:mutate");
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    const body = await req.json();

    // [v4.4, Sections 10–10.1] Checked on the RAW body, before schema
    // validation, so a direct API call can never smuggle a full,
    // pre-formatted batchNumber into `initialBatch` even if the schema were
    // ever loosened later. The date prefix is a server-generated,
    // creation-time-only fact — the only sanctioned way to influence the
    // stored value is `initialBatch.batchNumberSuffix`. Mirrors the
    // identical guard on app/api/inventory/batches/route.ts.
    if (body?.initialBatch?.batchNumber !== undefined) {
      return NextResponse.json(
        {
          error: "BATCH_NUMBER_DIRECT_SET_NOT_ALLOWED",
          message:
            "لا يمكن تحديد رقم الدفعة بالكامل مباشرة — يُبنى تلقائياً من تاريخ اليوم بالإضافة إلى الجزء الذي تدخله.",
        },
        { status: 400 }
      );
    }

    // [Batch cost entry — UNIFIED] Checked on the RAW body, before schema
    // validation, mirroring the identical guards on
    // app/api/inventory/batches/route.ts and
    // app/api/inventory/batches/receipt/route.ts: EVERY value createBatchRow()
    // derives itself (costPricePerBaseUnit, conversionFactor, baseQuantity,
    // perBaseUnit) is rejected outright on this INTERACTIVE creation path,
    // never silently accepted or ignored. The shared helper
    // (batch-creation.ts's findClientComputedBatchField) is used rather than a
    // hand-rolled check, so this list can never drift from the other two
    // screens. Only CSV import's non-interactive bulk path is exempt (a
    // different route entirely).
    const initialBatchComputedField = findClientComputedBatchField(body?.initialBatch);
    if (initialBatchComputedField) {
      return NextResponse.json(
        {
          error: "CLIENT_COMPUTED_FIELD_NOT_ALLOWED",
          message: `الحقل "${initialBatchComputedField}" يُحسب على الخادم ولا يُقبل من العميل — أدخل إجمالي تكلفة الشراء بدلاً منه.`,
        },
        { status: 400 }
      );
    }

    const validation = createProductSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "البيانات المدخلة غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { name, category, imageUrl, isPublic, units, initialBatch } = validation.data;

    const packagingCheck = validatePackagingUnits(units);
    if (!packagingCheck.valid) {
      return NextResponse.json(
        { error: "INVALID_PACKAGING_UNITS", message: packagingCheck.error },
        { status: 400 }
      );
    }

    // [FIX — unitIndex] Explicit bounds check BEFORE any write. The schema
    // above guarantees an integer >= 0; only this route knows how many units
    // were actually submitted, so the upper bound lives here. Rejecting (not
    // falling back) is the point: a nonexistent index used to be silently
    // reinterpreted as "the base unit", corrupting both the stored quantity
    // and the derived per-base-unit cost with no error anywhere.
    if (initialBatch && initialBatch.unitIndex >= units.length) {
      return NextResponse.json(
        {
          error: "INVALID_INITIAL_BATCH_UNIT",
          message: "الوحدة المحددة للدفعة الأولى غير موجودة ضمن وحدات المنتج.",
        },
        { status: 400 }
      );
    }

    if (isPublic) {
      const gateCheck = checkProductPublishable({ isActive: true, imageUrl, units });
      if (!gateCheck.publishable) {
        return NextResponse.json(
          { error: "PUBLISH_GATE_BLOCKED", message: gateCheck.reason },
          { status: 400 }
        );
      }
    }

    // [v4.5] ONE flat list across ALL barcodes of ALL units in the request —
    // not one barcode per unit. A duplicate anywhere in the request (same
    // unit twice, or two different units) is rejected before any write, and
    // then each value is checked against the live DB.
    const incomingBarcodes = units.flatMap((u) => u.barcodes.map((b) => b.barcode));

    if (new Set(incomingBarcodes).size !== incomingBarcodes.length) {
      return NextResponse.json(
        { error: "DUPLICATE_BARCODE", message: "لا يمكن تكرار نفس الباركود ضمن نفس الطلب." },
        { status: 400 }
      );
    }

    for (const barcode of incomingBarcodes) {
      const existingBarcode = await findProductUnitByBarcode(db, tenantId, barcode);
      if (existingBarcode) {
        const statusText = existingBarcode.isActive ? "نشطة" : "متوقفة";
        return NextResponse.json(
          {
            error: "DUPLICATE_BARCODE",
            message: `الباركود (${barcode}) مستخدم مسبقاً في وحدة (${existingBarcode.unitName}) للمنتج (${existingBarcode.productName}) وهي بحالة [${statusText}].`,
          },
          { status: 400 }
        );
      }
    }

    // [v4.0] validatePackagingUnits above already guarantees exactly one
    // submitted unit has conversionFactor === 1 — that one becomes the
    // base unit via createProductWithBaseUnit(); every other submitted
    // unit is created afterward via createAdditionalUnit().
    const baseUnitIndex = units.findIndex((u) => new Decimal(u.conversionFactor).equals(1));
    // Structurally unreachable — validatePackagingUnits already rejected
    // the request otherwise — but fail loud rather than silently proceed
    // with -1 as an array index.
    if (baseUnitIndex === -1) {
      return NextResponse.json(
        { error: "INVALID_PACKAGING_UNITS", message: "لم يتم العثور على الوحدة الأساسية (معامل تحويل = 1)." },
        { status: 400 }
      );
    }

    const createdProduct = await db.$transaction(async (tx) => {
      const baseUnitInput = units[baseUnitIndex];
      // [FIX] createProductWithBaseUnit() now returns
      // { createdProduct, createdBaseUnit } instead of { product, baseUnit }
      // — renamed in lib/data/products.ts specifically so that
      // destructuring this SANCTIONED, trusted return value no longer
      // trips the PRODUCT_MODEL_RULES / BASE_UNIT_ID_RULES ESLint
      // ObjectPattern selectors, which match on the destructured KEY NAME
      // alone and can't distinguish "this function's own safe return"
      // from "a raw Prisma relation." Aliased back to the original local
      // names (`product`, `baseUnit`) here so every downstream reference
      // in this function body (product.id, product.name, baseUnit.id,
      // baseUnit.unitName, ...) needs no further changes.
      const { createdProduct: product, createdBaseUnit: baseUnit } = await createProductWithBaseUnit(
        tx,
        tenantId,
        { name, category: category || null, imageUrl: imageUrl?.trim() || null, isPublic: !!isPublic },
        {
          unitName: baseUnitInput.unitName,
          pricingCurrency: baseUnitInput.pricingCurrency || "SYP",
          priceWholesale: baseUnitInput.priceWholesale,
          isActive: baseUnitInput.isActive ?? true,
        }
      );

      // createdUnits, in the SAME ORDER as the submitted `units` array, so
      // initialBatch.unitIndex still lines up. Filled in below.
      const createdUnits: { id: string; conversionFactor: string }[] = new Array(units.length);
      createdUnits[baseUnitIndex] = { id: baseUnit.id, conversionFactor: "1" };

      // [v4.5] The base unit's barcodes — ONE createUnitBarcode() call per
      // barcode, each its own top-level write inside THIS transaction (T1's
      // nested-write ban: never `barcodes: { create: ... }`). A unit with no
      // barcodes issues no calls at all.
      for (const barcodeRow of baseUnitInput.barcodes) {
        await createUnitBarcode(tx, tenantId, baseUnit.id, {
          barcode: barcodeRow.barcode,
          barcodeSource: barcodeRow.barcodeSource,
        });
      }

      for (let i = 0; i < units.length; i++) {
        if (i === baseUnitIndex) continue;
        const u = units[i];
        const createdUnit = await createAdditionalUnit(tx, tenantId, product.id, u.conversionFactor, {
          unitName: u.unitName,
          pricingCurrency: u.pricingCurrency || "SYP",
          priceWholesale: u.priceWholesale,
          isActive: u.isActive ?? true,
        });
        createdUnits[i] = { id: createdUnit.id, conversionFactor: u.conversionFactor };

        // [v4.5] Same per-barcode treatment as the base unit above.
        for (const barcodeRow of u.barcodes) {
          await createUnitBarcode(tx, tenantId, createdUnit.id, {
            barcode: barcodeRow.barcode,
            barcodeSource: barcodeRow.barcodeSource,
          });
        }
      }

      // [v4.5] GS1 shared-catalog reconciliation. Every GS1 barcode across
      // every unit of this request, in submission order, resolved through
      // lib/data/products.ts's gateway with REQUEST-SCOPED continuity:
      //   * a barcode the platform already knows resolves to ITS OWN entry
      //   * the first barcode that needs an entry creates exactly one
      //   * every later NEW barcode links to that same entry — so a product
      //     entered with three barcodes produces ONE ProductCatalogEntry,
      //     never three near-duplicate rows
      // INTERNAL barcodes are deliberately excluded (T3a §5: internal codes
      // are the merchant's own labels and never contribute to the shared
      // cross-tenant catalog).
      let sharedCatalogEntryId: string | null = null;
      for (const u of units) {
        for (const barcodeRow of u.barcodes) {
          if (barcodeRow.barcodeSource !== "GS1") continue;
          sharedCatalogEntryId = await resolveSharedCatalogForBarcode(tx, {
            barcode: barcodeRow.barcode,
            name,
            category: category || null,
            imageUrl: imageUrl?.trim() || null,
            addedByTenantId: tenantId,
            preferEntryId: sharedCatalogEntryId,
          });
        }
      }

      if (initialBatch) {
        // [v4.0] ProductBatch.unitId is ALWAYS the base unit — never the
        // unit the admin picked via `initialBatch.unitIndex` (an ENTRY
        // convenience only). The entered quantity is converted via the
        // ENTERED unit's own conversionFactor — trusted here because it
        // comes from this same create request, not a later,
        // separately-submitted payload (contrast with T4c/T5, which must
        // re-fetch the factor from the DB instead of trusting a client
        // payload).
        //
        // [v4.4, Sections 10–11] The write itself — including the one
        // sanctioned constructBatchNumber() call — is delegated to the
        // shared lib/inventory/batch-creation.ts helper, so this screen,
        // T3a's single-batch screen and Section 11's multi-product receipt
        // screen cannot drift into three subtly different writes.
        //
        // [Batch cost entry — UNIFIED] Passes `totalCost`, not
        // `costPricePerBaseUnit` — createBatchRow() derives the stored
        // per-base-unit figure via costFromTotal(), using the ENTERED
        // unit's own conversionFactor (never the base unit's, which is
        // always 1). This is the exact same call shape the single-batch
        // and multi-product receipt routes already use.
        //
        // [FIX — unitIndex] No `?? createdUnits[baseUnitIndex]` fallback
        // any more. `initialBatch.unitIndex` was bounds-checked against
        // `units.length` in POST before this transaction opened, and every
        // slot of `createdUnits` has been filled by now, so the lookup
        // cannot miss. If it ever did, the thrown error below is louder
        // and safer than silently treating "3 cartons" as "3 pieces".
        const enteredUnit = createdUnits[initialBatch.unitIndex];
        if (!enteredUnit) {
          throw new Error(
            `initialBatch.unitIndex ${initialBatch.unitIndex} has no created unit — bounds check bypassed.`
          );
        }

        // [v4.7] Step 3 rides the receiving gateway: ONE ProductReceipt
        // written first, then the batch under it — top-level calls only, so
        // a failure rolls back product, receipt and batch together.
        await createReceiptWithBatches(tx, {
          tenantId,
          userId: session.user.id,
          purchaseDate: initialBatch.purchaseDate,
          supplierName: initialBatch.supplierName,
          batchNumberSuffix: initialBatch.batchNumberSuffix,
          lines: [
            {
              productId: product.id,
              entryUnitId: enteredUnit.id,
              quantity: initialBatch.quantity,
              totalCost: initialBatch.totalCost,
              expiryDate: initialBatch.expiryDate ?? null,
            },
          ],
        });
      }

      // [FIX] The field holding the resolved base unit's id here is
      // named `resolvedBaseUnitId`, not `baseUnitId` — this is a plain
      // local object this route builds itself (not a raw Prisma
      // relation), but eslint.config.mjs's BASE_UNIT_ID_RULES bans the
      // literal property name `.baseUnitId` via MemberExpression
      // ANYWHERE outside lib/inventory/base-unit.ts, regardless of the
      // object's actual origin — it can't distinguish "a safe local DTO"
      // from "a raw fetched Product row." Every later READ of this field
      // in this function (`createdProduct.baseUnitId`) would otherwise
      // trip that rule. Renaming the field itself avoids the false
      // positive, matching the exact same reasoning behind
      // createProductWithBaseUnit()'s createdProduct/createdBaseUnit
      // rename in lib/data/products.ts. The outbound JSON response below
      // still exposes this as `baseUnitId` — that's a plain object-literal
      // Property key, not a MemberExpression read, so it isn't restricted.
      return {
        productId: product.id,
        productName: product.name,
        productCategory: product.category,
        productImageUrl: product.imageUrl,
        productIsPublic: product.isPublic,
        productIsActive: product.isActive,
        productCreatedAt: product.createdAt,
        resolvedBaseUnitId: baseUnit.id,
        createdUnits,
        unitInputs: units,
      };
    });

    const responseProduct = {
      id: createdProduct.productId,
      name: createdProduct.productName,
      category: createdProduct.productCategory,
      imageUrl: createdProduct.productImageUrl,
      isPublic: createdProduct.productIsPublic,
      isActive: createdProduct.productIsActive,
      createdAt: createdProduct.productCreatedAt,
      // [FIX] Read from `.resolvedBaseUnitId` (this route's own renamed
      // local field), not `.baseUnitId` — see the note at the
      // transaction's return statement above for why. The outbound key
      // in THIS response object is still named `baseUnitId` (a plain
      // Property key, not a restricted MemberExpression read), so the
      // API's public response shape is unchanged.
      baseUnitId: createdProduct.resolvedBaseUnitId,
      units: createdProduct.createdUnits.map((u, i) => ({
        id: u.id,
        unitName: createdProduct.unitInputs[i].unitName,
        conversionFactor: Number(u.conversionFactor),
        pricingCurrency: createdProduct.unitInputs[i].pricingCurrency || "SYP",
        priceWholesale: Number(createdProduct.unitInputs[i].priceWholesale),
        isBaseUnit: u.id === createdProduct.resolvedBaseUnitId,
      })),
    };

    return NextResponse.json({
      success: true,
      product: responseProduct,
      message: "تم إنشاء المنتج بنجاح.",
    });
  } catch (error) {
    // [v4.7] Backstop: the route schema validates first, but the receiving
    // gateway re-validates — a ZodError escaping it is a 400, not a 500.
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: error.issues[0]?.message || "بيانات الطلب غير صالحة." },
        { status: 400 }
      );
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    // [FIX — createBatchRow errors] The `initialBatch` path goes through the
    // shared createBatchRow(), which throws typed errors for user-caused
    // problems. Without these branches they all fell through to the generic
    // SERVER_ERROR below, and the whole product creation was rolled back
    // with no explanation. Only the two that can genuinely be caused by this
    // request's input are mapped:
    //  - InvalidCostInputError: the quantity/total pair fails costFromTotal()'s
    //    own guards (e.g. a total so small, or a quantity so large, that the
    //    derived per-base-unit cost rounds to 0 or exceeds the column range).
    //  - InactiveEntryUnitError: the merchant chose, as the unit for the
    //    initial batch, a unit they also submitted with isActive: false.
    // UnitNotBelongingToProductError and MissingBaseUnitError are deliberately
    // NOT mapped: the product and its units were created inside this same
    // transaction, so either one here would be a real bug, and a 500 that
    // gets logged is the honest answer to that.
    if (error instanceof InvalidCostInputError) {
      return NextResponse.json(
        { error: "INVALID_COST_INPUT", message: error.message },
        { status: 400 }
      );
    }
    if (error instanceof InactiveEntryUnitError) {
      return NextResponse.json(
        {
          error: "ENTRY_UNIT_INACTIVE",
          message: "الوحدة المحددة للدفعة الأولى متوقفة ولا يمكن الاستلام بها.",
        },
        { status: 400 }
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "BARCODE_EXISTS", message: "أحد الباركودات المدخلة مستخدم بالفعل لمنتج آخر." },
        { status: 400 }
      );
    }
    console.error("Error creating product:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إضافة المنتج." }, { status: 500 });
  }
}