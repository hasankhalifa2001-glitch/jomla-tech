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
import { validatePackagingUnits } from "@/lib/inventory/conversions";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const unitSchema = z
  .object({
    unitName: z.string().min(1, "اسم الوحدة مطلوب"),
    conversionFactor: z.number().positive("معامل التحويل يجب أن يكون رقماً موجباً"),
    pricingCurrency: z.enum(["SYP", "USD"]).default("SYP"),
    priceWholesale: z.number().positive("سعر الجملة يجب أن يكون أكبر من صفر"),
    priceRetail: z.number().min(0).optional().nullable(),
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
      unitIndex: z.number().default(0),
      batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
      quantity: z.number(),
      expiryDate: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

type ProductUnitRow = {
  id: string;
  unitName: string;
  conversionFactor: Prisma.Decimal | number;
  pricingCurrency: string;
  priceWholesale: Prisma.Decimal | number;
  priceRetail: Prisma.Decimal | number | null;
  barcode: string | null;
  barcodeSource: string | null;
  imageUrl: string | null;
  isActive: boolean;
};

type ProductBatchRow = {
  id: string;
  batchNumber: string;
  quantity: Prisma.Decimal | number;
  unitId: string;
  expiryDate: Date | null;
  unit: { unitName: string; conversionFactor: Prisma.Decimal | number } | null;
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
    // NOTE (flagged, unresolved): unlike an earlier version of this route,
    // an omitted `status` param no longer defaults to "active" — a bare
    // GET now returns products regardless of isActive. Left exactly as
    // received pending confirmation of whether this was an intentional
    // behavior change.

    const products = (await db.product.findMany({
      where: whereClause,
      include: {
        units: true,
        batches: {
          include: {
            unit: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    })) as unknown as ProductRow[];

    const now = new Date();

    const processedProducts = products.map((product) => {
      const baseUnit = product.units.find((u) => Number(u.conversionFactor) === 1) || product.units[0];
      const baseFactor = baseUnit ? Number(baseUnit.conversionFactor) : 1;

      let totalBaseStock = 0;
      let hasExpiringSoonBatch = false;
      let hasNegativeStockBatch = false;

      const processedBatches = product.batches.map((batch) => {
        const batchUnitFactor = batch.unit ? Number(batch.unit.conversionFactor) : 1;
        const batchQty = Number(batch.quantity);
        totalBaseStock += batchQty * batchUnitFactor;

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
          quantity: batchQty,
          unitId: batch.unitId,
          unitName: batch.unit?.unitName || "",
          expiryDate: batch.expiryDate,
          daysToExpiry,
          expiryStatus,
          isNegative: batchQty < 0,
        };
      });

      const totalStockInBase = totalBaseStock / baseFactor;
      const isOutOfStock = totalStockInBase <= 0;

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
        units: product.units.map((u) => ({
          id: u.id,
          unitName: u.unitName,
          conversionFactor: Number(u.conversionFactor),
          pricingCurrency: u.pricingCurrency || "SYP",
          priceWholesale: Number(u.priceWholesale ?? 0),
          priceRetail: u.priceRetail !== null && u.priceRetail !== undefined ? Number(u.priceRetail) : null,
          barcode: u.barcode,
          barcodeSource: u.barcodeSource,
          imageUrl: u.imageUrl,
          isActive: u.isActive !== false,
        })),
        batches: processedBatches,
        totalStockInBase,
        baseUnitName: baseUnit?.unitName || "قطعة",
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

    return NextResponse.json({
      success: true,
      products: filtered,
    });
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

    // [FIX — new] Previously missing entirely from this route: PATCH
    // enforced "exactly one base unit (factor === 1)" and "no duplicate
    // conversion factors" but POST (product creation) did not, so a brand
    // new product could be created without a base unit or with duplicate
    // factors, only to be rejected the very first time someone tried to
    // edit it. Delegates to the same shared implementation PATCH now uses.
    const packagingCheck = validatePackagingUnits(units);
    if (!packagingCheck.valid) {
      return NextResponse.json(
        {
          error: "INVALID_PACKAGING_UNITS",
          message: packagingCheck.error,
        },
        { status: 400 }
      );
    }

    // PUBLISHING GATE: delegates to the single shared implementation in
    // lib/inventory/publishing-gate.ts.
    if (isPublic) {
      const gateCheck = checkProductPublishable({ isActive: true, units });
      if (!gateCheck.publishable) {
        return NextResponse.json(
          {
            error: "PUBLISH_GATE_BLOCKED",
            message: gateCheck.reason,
          },
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
        where: {
          tenantId_barcode: {
            tenantId,
            barcode,
          },
        },
        include: {
          product: { select: { name: true } },
        },
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

        // ProductCatalogEntry is write-once at creation and MUST NEVER be
        // updated afterward by anyone. The only two valid outcomes: (a)
        // no entry exists yet → create it, or (b) an entry already
        // exists → do nothing.
        if (u.barcodeSource === "GS1" && u.barcode?.trim()) {
          const barcodeTrim = u.barcode.trim();
          const existingCatalog = await tx.productCatalogEntry.findUnique({
            where: { barcode: barcodeTrim },
          });
          if (!existingCatalog) {
            await tx.productCatalogEntry.create({
              data: {
                barcode: barcodeTrim,
                name,
                category: category || null,
                imageUrl: u.imageUrl || null,
                addedByTenantId: tenantId,
              },
            });
          }
        }
      }

      if (initialBatch) {
        const selectedUnitId = unitIds[initialBatch.unitIndex] ?? unitIds[0];
        await tx.productBatch.create({
          data: {
            tenantId,
            productId: product.id,
            unitId: selectedUnitId,
            batchNumber: initialBatch.batchNumber,
            quantity: initialBatch.quantity,
            expiryDate: initialBatch.expiryDate ? new Date(initialBatch.expiryDate) : null,
          },
        });
      }

      return { ...product, units: createdUnits };
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