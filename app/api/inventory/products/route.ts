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
// [FIX] validatePackagingUnits now lives in units.ts (merged in — see
// that file's header FIX #3), not the deleted packaging-unit-validation.ts.
import { validatePackagingUnits } from "@/lib/inventory/units";
// [v4.0] Sole gateway for reading Product.baseUnitId.
import { requireBaseUnits } from "@/lib/inventory/base-unit";
// [v4.0] Sole gateway for any conversionFactor arithmetic.
import { toBaseUnit } from "@/lib/inventory/units";
// [FIX] Sole gateway for tx.product.* / tx.productUnit.* — see that
// file's header and eslint.config.mjs's model-level rule. Neither this
// route nor any other route outside lib/data/products.ts (or
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

    // [FIX] Routed through lib/data/products.ts instead of
    // db.product.findMany directly.
    const products = await listProductsWithInventoryDetails(db, tenantId, whereClause);

    // [v4.0] Batch-resolve every listed product's base unit through the
    // sole sanctioned gateway. THIS CALL IS FAIL-LOUD: it throws
    // MissingBaseUnitError the moment it hits any product whose
    // baseUnitId doesn't resolve. If this route starts 500ing right after
    // deploying v4.0, that almost certainly means there are pre-v4.0
    // product rows still needing a one-time baseUnitId backfill — that is
    // the intended signal, not a bug to route around by silently falling
    // back to the old "guess by conversionFactor === 1" heuristic. Do
    // NOT wrap this in a try/catch that swallows MissingBaseUnitError and
    // substitutes a guess.
    const baseUnitsByProduct = await requireBaseUnits(
      db,
      tenantId,
      products.map((p) => p.id)
    );

    const now = new Date();

    const processedProducts = products.map((product) => {
      const baseUnit = baseUnitsByProduct.get(product.id)!; // guaranteed present

      // [FIX] Summed in Decimal end-to-end — no native-number accumulation
      // and therefore no epsilon-rounding patch needed. ProductBatch.quantity
      // is already always base-unit under v4.0, so this is a pure sum, but
      // "pure sum" done via repeated JS `+=` on many rows can still drift on
      // ordinary floating-point summation noise; Decimal removes that too.
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

      // [FLAGGED — open question, not resolved here] Under v3.9, a
      // deactivated NON-base unit could still carry its own batches
      // (ProductBatch.unitId could be any unit), so this flag made sense.
      // Under v4.0, ProductBatch.unitId is always the base unit — so this
      // condition can only ever be true if the BASE unit itself is
      // deactivated, a scenario T3a §4's original spec text doesn't
      // explicitly address for v4.0. Left functionally unchanged pending
      // a product decision on whether deactivating the base unit should
      // even be allowed.
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
          isBaseUnit: u.isBaseUnit,
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
      // [FIX] Routed through lib/data/products.ts.
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
      // [FIX] product/baseUnit → createdProduct/createdBaseUnit (الأسماء
      // الجديدة من الدالة). خليتهم كمتغيرات محلية بأسماء مختصرة عشان الكود
      // تحت ما يطول بلا داعي.
      const { createdProduct: newProduct, createdBaseUnit: newBaseUnit } =
        await createProductWithBaseUnit(
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

      const createdUnits: { id: string; conversionFactor: string }[] = new Array(units.length);
      createdUnits[baseUnitIndex] = { id: newBaseUnit.id, conversionFactor: "1" };

      for (let i = 0; i < units.length; i++) {
        if (i === baseUnitIndex) continue;
        const u = units[i];
        const createdUnit = await createAdditionalUnit(tx, tenantId, newProduct.id, u.conversionFactor, {
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
            if (!isBenignRace) throw catalogError;
          }
        }
      }

      if (initialBatch) {
        // [FIX — من الجولة اللي قبلها] رفض صريح بدل fallback صامت
        if (initialBatch.unitIndex < 0 || initialBatch.unitIndex >= createdUnits.length) {
          throw new Error(
            `initialBatch.unitIndex (${initialBatch.unitIndex}) is out of range for ${createdUnits.length} submitted units.`
          );
        }
        const enteredUnit = createdUnits[initialBatch.unitIndex];
        const baseQuantity: DecimalInstance = toBaseUnit(initialBatch.quantity, enteredUnit.conversionFactor);

        await tx.productBatch.create({
          data: {
            tenantId,
            productId: newProduct.id,
            unitId: newBaseUnit.id,
            batchNumber: initialBatch.batchNumber,
            quantity: baseQuantity.toString(),
            expiryDate: initialBatch.expiryDate ? new Date(initialBatch.expiryDate) : null,
          },
        });
      }

      return {
        productId: newProduct.id,
        productName: newProduct.name,
        productCategory: newProduct.category,
        productIsPublic: newProduct.isPublic,
        productIsActive: newProduct.isActive,
        productCreatedAt: newProduct.createdAt,
        resolvedBaseUnitId: newBaseUnit.id,
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