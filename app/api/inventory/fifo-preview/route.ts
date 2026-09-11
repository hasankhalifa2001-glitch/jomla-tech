import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { previewFifoAllocation } from "@/lib/inventory/fifo";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";

const fifoPreviewSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  requestedQty: z
    .union([z.number(), z.string()])
    .transform((val) => {
      try {
        const d = new Decimal(val);
        return d.toNumber();
      } catch {
        return NaN;
      }
    })
    .refine((val) => !isNaN(val) && val > 0, {
      message: "الكمية المطلوبة يجب أن تكون أكبر من الصفر",
    }),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const tenantId = session.user.tenantId;
    const body = await req.json();
    const validation = fifoPreviewSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات طلب المعاينة غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { productId, unitId, requestedQty } = validation.data;
    const db = getTenantDb(tenantId);

    // Cross-tenant / cross-product preflight verification:
    // 1. Ensure productId exists for this tenant
    const product = await db.product.findFirst({
      where: { id: productId },
      select: { id: true },
    });

    if (!product) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "المنتج المحدد غير موجود." },
        { status: 404 }
      );
    }

    // 2. Ensure unitId exists and belongs to the given productId for this tenant
    const unit = await db.productUnit.findFirst({
      where: { id: unitId, productId },
      select: { id: true },
    });

    if (!unit) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "وحدة القياس المحددة غير صالحة لهذا المنتج." },
        { status: 400 }
      );
    }

    // Read-only FIFO preview execution:
    // Never opens a transaction, never issues locks, never writes to database.
    const resolution = await previewFifoAllocation({
      tenantId,
      productId,
      unitId,
      requestedQty,
    });

    // Derive explicit shortfall indicators from the core allocation plan
    const fullyAllocated = resolution.isSufficient;
    const shortfallQty = resolution.remainingQty;

    return NextResponse.json({
      success: true,
      resolution: {
        ...resolution,
        fullyAllocated,
        shortfallQty,
      },
    });
  } catch (error) {
    // Distinguish Prisma DB/infrastructure failures from expected business logic validation errors
    const isInfrastructureError =
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientRustPanicError ||
      error instanceof Prisma.PrismaClientUnknownRequestError;

    const message =
      error instanceof Error
        ? error.message
        : "حدث خطأ أثناء معاينة سحب المخزون.";

    console.error("Error running FIFO preview:", error);

    if (isInfrastructureError) {
      return NextResponse.json(
        { error: "SERVER_ERROR", message: "حدث خطأ أثناء معاينة سحب المخزون." },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: "FIFO_RESOLUTION_ERROR", message },
      { status: 400 }
    );
  }
}