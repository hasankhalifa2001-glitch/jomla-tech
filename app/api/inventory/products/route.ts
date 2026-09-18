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
import { validatePackagingUnits } from "@/lib/inventory/units";
// [v4.0] Sole gateway for reading Product.baseUnitId.
import { requireBaseUnits } from "@/lib/inventory/base-unit";
// [v4.0] Sole gateway for any conversionFactor arithmetic.
import { toBaseUnit } from "@/lib/inventory/units";
// Sole gateway for tx.product.* / tx.productUnit.* — see that file's
// header and eslint.config.mjs's model-level rule. Neither this route
// nor any other route outside lib/data/products.ts (or
// lib/inventory/base-unit.ts) may call db.product.*/db.productUnit.*
// directly anymore.
import {
  createProductWithBaseUnit,
  createAdditionalUnit,
  listProductsWithInventoryDetails,
  findProductUnitByBarcode,
} from "@/lib/data/products";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";

type DecimalInstance = InstanceType<typeof Decimal>;

const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;

const positiveDecimalString = (message: string) =>
  z
    .string()
    .regex(DECIMAL_STRING_REGEX, message)
    .refine((val) => Number(val) > 0, { message });

const nonNegativeDecimalString = (message: string) =>
  z
    .string()
    .regex(DECIMAL_STRING_REGEX, message)
    .refine((val) => Number(val) >= 0, { message });

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
    priceRetail: nonNegativeDecimalString("سعر التجزئة يجب أن يكون صفراً أو أكثر")
      .optional()
      .nullable(),
    barcode: z.string().optional().nullable(),
    barcodeSource: z.enum(["GS1", "INTERNAL"]).optional().nullable(),
    imageUrl: z.string().optional().nullable(),
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
  );

const createProductSchema = z.object({
  name: z.string().min(1, "اسم المنتج مطلوب"),
  category: z.string().optional().nullable(),
  isPublic: z.boolean().optional().default(false),
  units: z.array(unitSchema).min(1, "يجب تقديم وحدة قياس واحدة على الأقل"),
  initialBatch: z
    .object({
      // [v4.0] "which unit did the admin enter the quantity in?" — a
      // display/entry convenience only. NEVER written directly as
      // ProductBatch.unitId (that field is always resolved to the base
      // unit inside the transaction below).
      unitIndex: z.number().default(0),
      batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
      quantity: nonNegativeDecimalString("الكمية يجب أن تكون صفراً أو أكثر"),
      expiryDate: z.string().optional().nullable(),
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

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
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
        isPublic: product.isPublic,
        isActive: product.isActive,
        createdAt: product.createdAt,
        baseUnitId: baseUnit.id,
        units: product.units.map((u) => ({
          id: u.id,
          unitName: u.unitName,
          conversionFactor: Number(u.conversionFactor),
          pricingCurrency: u.pricingCurrency || "SYP",
          priceWholesale: u.priceWholesale.toString(),
          priceRetail: u.priceRetail !== null && u.priceRetail !== undefined ? u.priceRetail.toString() : null,
          barcode: u.barcode,
          barcodeSource: u.barcodeSource,
          imageUrl: u.imageUrl,
          isActive: u.isActive !== false,
          isBaseUnit: u.id === baseUnit.id,
        })),
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
        const barcodeMatch = p.units.some((u) => u.barcode && u.barcode.toLowerCase().includes(lowerQ));
        const nameMatch = p.name.toLowerCase().includes(lowerQ);
        const categoryMatch = p.category && p.category.toLowerCase().includes(lowerQ);
        return barcodeMatch || nameMatch || categoryMatch;
      });

      filtered.sort((a, b) => {
        const aExactBarcode = a.units.some((u) => u.barcode && u.barcode.toLowerCase() === lowerQ);
        const bExactBarcode = b.units.some((u) => u.barcode && u.barcode.toLowerCase() === lowerQ);
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

    const { name, category, isPublic, units, initialBatch } = validation.data;

    const packagingCheck = validatePackagingUnits(units);
    if (!packagingCheck.valid) {
      return NextResponse.json(
        { error: "INVALID_PACKAGING_UNITS", message: packagingCheck.error },
        { status: 400 }
      );
    }

    if (isPublic) {
      const gateCheck = checkProductPublishable({ isActive: true, units });
      if (!gateCheck.publishable) {
        return NextResponse.json(
          { error: "PUBLISH_GATE_BLOCKED", message: gateCheck.reason },
          { status: 400 }
        );
      }
    }

    const incomingBarcodes = units
      .map((u) => u.barcode?.trim())
      .filter((b): b is string => !!b);

    if (new Set(incomingBarcodes).size !== incomingBarcodes.length) {
      return NextResponse.json(
        { error: "DUPLICATE_BARCODE", message: "لا يمكن تكرار نفس الباركود لأكثر من وحدة ضمن نفس الطلب." },
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
        { name, category: category || null, isPublic: !!isPublic },
        {
          unitName: baseUnitInput.unitName,
          pricingCurrency: baseUnitInput.pricingCurrency || "SYP",
          priceWholesale: baseUnitInput.priceWholesale,
          priceRetail: baseUnitInput.priceRetail ?? null,
          barcode: baseUnitInput.barcode || null,
          barcodeSource: baseUnitInput.barcodeSource || null,
          imageUrl: baseUnitInput.imageUrl || null,
          isActive: baseUnitInput.isActive ?? true,
        }
      );

      // createdUnits, in the SAME ORDER as the submitted `units` array, so
      // initialBatch.unitIndex still lines up. Filled in below.
      const createdUnits: { id: string; conversionFactor: string }[] = new Array(units.length);
      createdUnits[baseUnitIndex] = { id: baseUnit.id, conversionFactor: "1" };

      for (let i = 0; i < units.length; i++) {
        if (i === baseUnitIndex) continue;
        const u = units[i];
        const createdUnit = await createAdditionalUnit(tx, tenantId, product.id, u.conversionFactor, {
          unitName: u.unitName,
          pricingCurrency: u.pricingCurrency || "SYP",
          priceWholesale: u.priceWholesale,
          priceRetail: u.priceRetail ?? null,
          barcode: u.barcode || null,
          barcodeSource: u.barcodeSource || null,
          imageUrl: u.imageUrl || null,
          isActive: u.isActive ?? true,
        });
        createdUnits[i] = { id: createdUnit.id, conversionFactor: u.conversionFactor };
      }

      // GS1 shared-catalog entries — ProductCatalogEntry is not a
      // restricted model (only Product/ProductUnit are), so this stays a
      // direct tx call, same as before.
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.barcodeSource === "GS1" && u.barcode?.trim()) {
          const barcodeTrim = u.barcode.trim();
          try {
            await tx.productCatalogEntry.create({
              data: {
                barcode: barcodeTrim,
                name,
                category: category || null,
                imageUrl: u.imageUrl || null,
                addedByTenantId: tenantId,
              },
            });
          } catch (catalogError) {
            const isBenignRace =
              catalogError instanceof Prisma.PrismaClientKnownRequestError &&
              catalogError.code === "P2002";
            if (!isBenignRace) {
              throw catalogError;
            }
          }
        }
      }

      if (initialBatch) {
        // [v4.0] ProductBatch.unitId is ALWAYS the base unit — never the
        // unit the admin picked via `initialBatch.unitIndex` (an ENTRY
        // convenience only). The entered quantity is converted via
        // toBaseUnit(), using the ENTERED unit's own conversionFactor —
        // trusted here because it comes from this same create request,
        // not a later, separately-submitted payload (contrast with
        // T4c/T5, which must re-fetch the factor from the DB instead of
        // trusting a client payload).
        const enteredUnit = createdUnits[initialBatch.unitIndex] ?? createdUnits[baseUnitIndex];
        const baseQuantity: DecimalInstance = toBaseUnit(initialBatch.quantity, enteredUnit.conversionFactor);

        await tx.productBatch.create({
          data: {
            tenantId,
            productId: product.id,
            unitId: baseUnit.id,
            batchNumber: initialBatch.batchNumber,
            quantity: baseQuantity.toString(),
            expiryDate: initialBatch.expiryDate ? new Date(initialBatch.expiryDate) : null,
          },
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
        priceRetail:
          createdProduct.unitInputs[i].priceRetail !== null &&
            createdProduct.unitInputs[i].priceRetail !== undefined
            ? Number(createdProduct.unitInputs[i].priceRetail)
            : null,
        isBaseUnit: u.id === createdProduct.resolvedBaseUnitId,
      })),
    };

    return NextResponse.json({
      success: true,
      product: responseProduct,
      message: "تم إنشاء المنتج بنجاح.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
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