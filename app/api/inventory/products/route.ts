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
import { validatePackagingUnits } from "@/lib/inventory/packaging-unit-validation";
// [v4.0] The sole gateway for reading Product.baseUnitId — see
// lib/inventory/base-unit.ts. requireBaseUnits() is the batch variant,
// used here for the product list so we don't issue one lookup per
// product. FAIL-LOUD BY DESIGN: see the comment at its call site below.
import { requireBaseUnits } from "@/lib/inventory/base-unit";
// [v4.0] The sole gateway for any conversionFactor arithmetic. Used here
// only in POST, to convert an initial batch's entered quantity (possibly
// in a non-base sale unit) into the base unit before it is ever written
// to ProductBatch.quantity.
import { toBaseUnit } from "@/lib/inventory/units";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";

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
    // the base-unit designation step in the transaction, not by this
    // per-field schema rule.
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
      // [v4.0] This is now "which unit did the admin enter the quantity
      // in?" — a display/entry convenience only. It is NEVER written
      // directly as ProductBatch.unitId anymore (see the transaction
      // below) — that field is always resolved to the base unit.
      unitIndex: z.number().default(0),
      batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
      quantity: nonNegativeDecimalString("الكمية يجب أن تكون صفراً أو أكثر"),
      expiryDate: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

type ProductUnitRow = {
  id: string;
  unitName: string;
  conversionFactor: Prisma.Decimal | number | string;
  pricingCurrency: string;
  priceWholesale: Prisma.Decimal | number;
  priceRetail: Prisma.Decimal | number | null;
  barcode: string | null;
  barcodeSource: string | null;
  imageUrl: string | null;
  isActive: boolean;
};

type ProductAdjustmentRow = {
  id: string;
  quantityDelta: Prisma.Decimal | number;
  reason: string;
  createdAt: Date;
  adjustedByUser?: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

type ProductBatchRow = {
  id: string;
  batchNumber: string;
  quantity: Prisma.Decimal | number;
  unitId: string;
  expiryDate: Date | null;
  unit: { unitName: string; conversionFactor: Prisma.Decimal | number } | null;
  adjustments?: ProductAdjustmentRow[];
  _count?: {
    invoiceItems: number;
    adjustments: number;
  };
};

type ProductRow = {
  id: string;
  name: string;
  category: string | null;
  isPublic: boolean;
  isActive: boolean;
  createdAt: Date;
  units: ProductUnitRow[];
  batches: ProductBatchRow[];
  // NOTE: baseUnitId IS present on the raw Prisma result (Product's own
  // scalar field), but per the ESLint rule this file must never read it
  // directly — see the requireBaseUnits() call below. It's intentionally
  // left off this type so a future edit can't casually reach for
  // `product.baseUnitId` here.
};

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

    const whereClause: Prisma.ProductWhereInput = {};
    if (status === "active") {
      whereClause.isActive = true;
    } else if (status === "inactive" || filter === "inactive_products") {
      whereClause.isActive = false;
    }
    // NOTE (still flagged, unresolved — unrelated to v4.0): an omitted
    // `status` param no longer defaults to "active"; left as-is pending a
    // product decision.

    const products = (await db.product.findMany({
      where: whereClause,
      include: {
        units: true,
        batches: {
          include: {
            unit: true,
            adjustments: {
              include: {
                adjustedByUser: {
                  select: { id: true, name: true, email: true },
                },
              },
              orderBy: { createdAt: "desc" },
            },
            _count: { select: { invoiceItems: true, adjustments: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })) as unknown as ProductRow[];

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
      // [v4.0] Product.baseUnitId is the authoritative source now — never
      // re-derived by scanning units for conversionFactor === 1.
      const baseUnit = baseUnitsByProduct.get(product.id)!; // guaranteed present — requireBaseUnits already threw otherwise

      let totalBaseStock = 0;
      let hasExpiringSoonBatch = false;
      let hasNegativeStockBatch = false;

      const processedBatches = product.batches.map((batch) => {
        const batchQty = Number(batch.quantity);
        // [v4.0 — REMOVED conversionFactor arithmetic] Previously:
        // `totalBaseStock += batchQty * batchUnitFactor`, converting via
        // the batch's own unit's factor. That's no longer needed OR
        // permitted here: ProductBatch.quantity is now ALWAYS already
        // expressed in the base unit (batch.unitId is always the base
        // unit going forward), so summing batch quantities directly IS
        // the total base-unit stock — no conversion, no
        // conversionFactor arithmetic outside lib/inventory/units.ts
        // (blocked by this project's ESLint rule).
        totalBaseStock += batchQty;

        if (batchQty < 0) {
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
          isNegative: batchQty < 0,
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

      // [v4.0] No more epsilon-rounding hack needed: the previous
      // near-integer noise (e.g. 93.9992 instead of 94) came specifically
      // from converting through a fractional conversionFactor, which no
      // longer happens here (see the removed multiplication above). A
      // light rounding guard is kept only as defensive protection against
      // ordinary floating-point summation noise across many JS-number
      // additions — not against unit-conversion remainder.
      const totalStockInBase =
        Math.abs(totalBaseStock - Math.round(totalBaseStock)) < 0.0001
          ? Math.round(totalBaseStock)
          : totalBaseStock;

      const isOutOfStock = totalStockInBase <= 0;

      // [FLAGGED — open question, not resolved here] Under v3.9, a
      // deactivated NON-base unit could still carry its own batches
      // (ProductBatch.unitId could be any unit), so this flag made sense.
      // Under v4.0, ProductBatch.unitId is always the base unit — so for
      // any NEW batch, this condition can only ever be true if the BASE
      // unit itself is deactivated (a scenario T3a §4's original spec
      // text doesn't explicitly address for v4.0). Left functionally
      // unchanged pending a product decision on whether deactivating the
      // base unit should even be allowed, and if so what this badge
      // should say in that case.
      const hasDiscontinuedUnitStock = product.units.some(
        (u) =>
          !u.isActive &&
          product.batches.some((b) => b.unitId === u.id && Number(b.quantity) > 0)
      );

      return {
        id: product.id,
        name: product.name,
        category: product.category,
        isPublic: product.isPublic,
        isActive: product.isActive,
        createdAt: product.createdAt,
        // [v4.0] Surfaced for the UI (base-unit badge, locking the base
        // unit's factor field in edit screens) — resolved via the trusted
        // baseUnit above, never via product.baseUnitId directly.
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
          // [v4.0] Lets the edit UI lock this specific unit's
          // conversionFactor field to "1" / non-editable once the product
          // has any batch, per T1's Immutability rule.
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
      const existingBarcode = await db.productUnit.findUnique({
        where: { tenantId_barcode: { tenantId, barcode } },
        include: { product: { select: { name: true } } },
      });
      if (existingBarcode) {
        const statusText = existingBarcode.isActive ? "نشطة" : "متوقفة";
        return NextResponse.json(
          {
            error: "DUPLICATE_BARCODE",
            message: `الباركود (${barcode}) مستخدم مسبقاً في وحدة (${existingBarcode.unitName}) للمنتج (${existingBarcode.product.name}) وهي بحالة [${statusText}].`,
          },
          { status: 400 }
        );
      }
    }

    const createdProduct = await db.$transaction(async (tx) => {
      // [v4.0] Write 1 of 3 in the product-creation transaction (see T1's
      // Unit Conversion Architecture, "Product creation atomicity").
      const product = await tx.product.create({
        data: {
          tenantId,
          name,
          category: category || null,
          isPublic: !!isPublic,
        },
      });

      const unitIds: string[] = [];
      const createdUnits: ProductUnitRow[] = [];
      for (const u of units) {
        // [v4.0] Write 2 of 3 (for each unit; exactly one of these will
        // have conversionFactor === 1, per validatePackagingUnits above).
        const createdUnit = await tx.productUnit.create({
          data: {
            tenantId,
            productId: product.id,
            unitName: u.unitName,
            conversionFactor: u.conversionFactor,
            pricingCurrency: u.pricingCurrency || "SYP",
            priceWholesale: u.priceWholesale,
            priceRetail: u.priceRetail !== undefined ? u.priceRetail : null,
            barcode: u.barcode || null,
            barcodeSource: u.barcodeSource || null,
            imageUrl: u.imageUrl || null,
            isActive: u.isActive ?? true,
          },
        });
        unitIds.push(createdUnit.id);
        createdUnits.push(createdUnit as unknown as ProductUnitRow);

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

      // [v4.0] Identify the base unit: validatePackagingUnits already
      // guaranteed exactly one submitted unit has conversionFactor === 1
      // before this transaction ever started.
      const baseUnitRow = createdUnits.find((u) =>
        new Decimal(u.conversionFactor).equals(1)
      );
      if (!baseUnitRow) {
        // Structurally unreachable — validatePackagingUnits already
        // rejected the request otherwise. Never proceed with a null
        // baseUnitId if this somehow happens.
        throw new Error("لم يتم العثور على الوحدة الأساسية (معامل تحويل = 1) بعد الإنشاء.");
      }

      // [v4.0] Write 3 of 3 — designate the base unit. A required
      // top-level call (T1's nested-write rule), never nested inside the
      // product.create() call above.
      await tx.product.update({
        where: { id: product.id },
        data: { baseUnitId: baseUnitRow.id },
      });

      if (initialBatch) {
        // [v4.0] ProductBatch.unitId is ALWAYS the base unit — never the
        // unit the admin picked via `initialBatch.unitIndex` (that's an
        // ENTRY convenience only: the admin may still type "10 packs").
        // The entered quantity is converted to the base unit via
        // toBaseUnit(), using the ENTERED unit's own conversionFactor —
        // never the base unit's (which is always 1 and would apply no
        // conversion at all) — exactly once, here, before it ever reaches
        // ProductBatch.quantity.
        const enteredUnit = createdUnits[initialBatch.unitIndex] ?? createdUnits[0];
        const baseQuantity = toBaseUnit(initialBatch.quantity, enteredUnit.conversionFactor);

        await tx.productBatch.create({
          data: {
            tenantId,
            productId: product.id,
            unitId: baseUnitRow.id,
            batchNumber: initialBatch.batchNumber,
            quantity: baseQuantity.toString(),
            expiryDate: initialBatch.expiryDate ? new Date(initialBatch.expiryDate) : null,
          },
        });
      }

      return { ...product, units: createdUnits, baseUnitId: baseUnitRow.id };
    });

    const responseProduct = {
      ...createdProduct,
      units: createdProduct.units.map((u) => ({
        ...u,
        conversionFactor: Number(u.conversionFactor),
        priceWholesale: Number(u.priceWholesale),
        priceRetail: u.priceRetail !== null && u.priceRetail !== undefined ? Number(u.priceRetail) : null,
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