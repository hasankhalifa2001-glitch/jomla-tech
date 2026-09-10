import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { previewFifoAllocation } from "@/lib/inventory/fifo";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const fifoPreviewSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  requestedQty: z.number().positive("الكمية المطلوبة يجب أن تكون أكبر من الصفر"),
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

    const resolution = await previewFifoAllocation({
      tenantId,
      productId,
      unitId,
      requestedQty,
    });

    return NextResponse.json({
      success: true,
      resolution,
    });
  } catch (error) {
    // [FIX] `error: any` removed. `previewFifoAllocation` throws plain
    // `Error` instances with friendly Arabic messages for expected,
    // client-caused validation failures (an unrecognized/foreign
    // productId or unitId, or a non-positive quantity) — none of those
    // are actually "server errors." Only a genuine Prisma-level failure (a real DB/connection problem)
    // represents an unexpected server-side condition. Distinguishing the
    // two means a bad productId returns a clear 400 the frontend can
    // display directly, instead of being lumped in with real infra
    // failures under a generic 500 — and it keeps server error monitoring
    // (e.g. Sentry) from being flooded with expected user-input mismatches
    // misclassified as server errors.
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