import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const unitSchema = z.object({
  unitName: z.string().min(1, "اسم الوحدة مطلوب"),
  conversionFactor: z.number().positive("معامل التحويل يجب أن يكون رقماً موجباً"),
  priceUSD: z.number().positive("السعر بالدولار يجب أن يكون رقماً موجباً"),
  barcode: z.string().optional().nullable(),
});

const createProductSchema = z.object({
  name: z.string().min(1, "اسم المنتج مطلوب"),
  category: z.string().optional().nullable(),
  isPublic: z.boolean().optional().default(false),
  units: z.array(unitSchema).min(1, "يجب تقديم وحدة قياس واحدة على الأقل"),
  initialBatch: z
    .object({
      unitIndex: z.number().default(0),
      batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
      quantity: z.number().min(0, "الكمية يجب أن تكون صفر أو أكثر"),
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
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const filter = searchParams.get("filter") || "all";

    const products = await prisma.product.findMany({
      where: {
        tenantId,
        isActive: true,
      },
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
    });

    const now = new Date();

    const processedProducts = products.map((product) => {
      const baseUnit = product.units.find((u) => Number(u.conversionFactor) === 1) || product.units[0];
      const baseFactor = baseUnit ? Number(baseUnit.conversionFactor) : 1;

      let totalBaseStock = 0;
      let hasExpiringSoonBatch = false;

      const processedBatches = product.batches.map((batch) => {
        const batchUnitFactor = batch.unit ? Number(batch.unit.conversionFactor) : 1;
        const batchQty = Number(batch.quantity);
        totalBaseStock += batchQty * batchUnitFactor;

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
        };
      });

      const totalStockInBase = totalBaseStock / baseFactor;
      const isOutOfStock = totalStockInBase <= 0;

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
          priceUSD: Number(u.priceUSD),
          barcode: u.barcode,
        })),
        batches: processedBatches,
        totalStockInBase,
        baseUnitName: baseUnit?.unitName || "قطعة",
        hasExpiringSoonBatch,
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

    // ADMIN-only: creating a catalog product is a pricing/catalog decision,
    // not a day-to-day operational task a cashier performs.
    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "إضافة منتجات جديدة متاحة لمدير المتجر فقط." },
        { status: 403 }
      );
    }

    if (session.user.subscriptionStatus === "EXPIRED" || session.user.subscriptionStatus === "PENDING") {
      return NextResponse.json(
        { error: "SUBSCRIPTION_LOCKED", message: "اشتراكك منتهي أو معلق. لا يمكنك إضافة منتجات جديدة." },
        { status: 403 }
      );
    }

    const tenantId = session.user.tenantId;
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

    for (const unit of units) {
      if (unit.barcode) {
        const existingBarcode = await prisma.productUnit.findUnique({
          where: {
            tenantId_barcode: {
              tenantId,
              barcode: unit.barcode,
            },
          },
        });
        if (existingBarcode) {
          return NextResponse.json(
            { error: "BARCODE_EXISTS", message: `الباركود (${unit.barcode}) مستخدم بالفعل لمنتج آخر.` },
            { status: 400 }
          );
        }
      }
    }

    const createdProduct = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          tenantId,
          name,
          category: category || null,
          isPublic: !!isPublic,
        },
      });

      // FIX: units are created one at a time in a loop (instead of a single
      // nested `create: units.map(...)`) specifically so each created row's
      // id is captured at the moment of its own creation, in `unitIds[]` at
      // the same index as the input `units[]` array. Relying on the include
      // order Prisma returns after a bulk nested create is not a documented
      // guarantee — silently mismatching a batch to the wrong packaging
      // unit (e.g. a "carton" batch recorded under "piece") is a bug with no
      // visible error, which is worse than the extra queries here cost.
      const unitIds: string[] = [];
      const createdUnits = [];
      for (const u of units) {
        const createdUnit = await tx.productUnit.create({
          data: {
            tenantId,
            productId: product.id,
            unitName: u.unitName,
            conversionFactor: u.conversionFactor,
            priceUSD: u.priceUSD,
            barcode: u.barcode || null,
          },
        });
        unitIds.push(createdUnit.id);
        createdUnits.push(createdUnit);
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

    return NextResponse.json({
      success: true,
      product: createdProduct,
      message: "تم إنشاء المنتج بنجاح.",
    });
  } catch (error) {
    // A unique-constraint violation on (tenantId, barcode) can still slip
    // through the pre-check above under concurrent requests (two identical
    // imports/submissions racing each other) — surface it as the same
    // friendly Arabic message instead of a generic 500.
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