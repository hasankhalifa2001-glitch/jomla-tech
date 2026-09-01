import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [NOTE — intentionally the raw client, not getTenantDb()] Unlike
// products/route.ts and batches/route.ts, importing the raw `prisma`
// client here is CORRECT, not a bug, and must not be "fixed" to
// getTenantDb(tenantId) the way those two files were. Two independent
// reasons:
//
// 1. `resolveFifoAllocation` (lib/inventory/fifo.ts) never relies on the
//    tenant-scoping Client Extension at all — it manually filters every
//    internal query by `tenantId` itself (`where: { id: unitId, productId,
//    tenantId }`, etc.), because it is shared between this read-only
//    PREVIEW call site and T4c's COMMIT call site, which runs inside an
//    interactive `prisma.$transaction(async (tx) => ...)` callback where
//    no `getTenantDb`-style extension is ever applied. Tenant isolation
//    for this function comes entirely from its own explicit filtering,
//    not from which client type is handed to it.
// 2. `resolveFifoAllocation`'s `tx` parameter is typed as
//    `Prisma.TransactionClient` specifically (see fifo.ts's own
//    docstring: "a real PrismaClient instance ... is still assignable
//    here with zero casts"). An extended client returned by
//    `getTenantDb(tenantId)` is NOT structurally assignable to that type
//    (the same category of type mismatch that forced removing the
//    explicit `tx: Prisma.TransactionClient` annotation in
//    products/route.ts's $transaction callback) — passing it here would
//    fail to compile, not just be redundant.
// [ESLINT] The `no-restricted-imports` rule enforcing lib/db.ts's raw-
// client allowlist (registration, seed.ts, isPlatformAdmin-gated
// super-admin routes) does not yet list this file. That is a real gap to
// close — not a false positive to silently work around — because this
// route's raw-client usage is a THIRD, previously-undocumented category of
// legitimate exception (shared functions like resolveFifoAllocation that
// accept either a raw PrismaClient or an interactive Prisma.TransactionClient
// and enforce tenant isolation manually themselves, rather than via the
// getTenantDb() extension). Until lib/db.ts's header comment and the
// ESLint config's allowlist are both updated to name this category
// explicitly, this single import is suppressed inline with the reasoning
// captured here so the exception stays narrowly scoped to this one line
// rather than disabling the rule for the whole file.
// eslint-disable-next-line no-restricted-imports -- see note above: raw client required for resolveFifoAllocation's PREVIEW-mode type compatibility; tenant isolation is enforced manually inside fifo.ts itself, not via getTenantDb().
import { prisma } from "@/lib/db";
import { resolveFifoAllocation } from "@/lib/inventory/fifo";
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

    // No explicit `mode` passed — defaults to "PREVIEW" inside
    // resolveFifoAllocation, which is exactly what read-only preview needs
    // and is the one mode the raw top-level client above is safe for (see
    // the note at the top of this file, and fifo.ts's own runtime guard
    // that rejects the raw client outright if mode were ever "COMMIT").
    const resolution = await resolveFifoAllocation(prisma, {
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
    // [FIX] `error: any` removed. `resolveFifoAllocation` throws plain
    // `Error` instances with friendly Arabic messages for expected,
    // client-caused validation failures (an unrecognized/foreign
    // productId or unitId, a non-positive quantity, or the COMMIT-mode
    // misuse guard) — none of those are actually "server errors." Only a
    // genuine Prisma-level failure (a real DB/connection problem)
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