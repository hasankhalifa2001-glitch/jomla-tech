import { NextResponse } from "next/server";
import { z } from "zod";
import { PaymentMethod } from "@prisma/client";
import { auth } from "@/auth";
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
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
  recordRepaymentIdempotent,
  RepaymentError,
} from "@/lib/ledger/repayment";

/**
 * POST /api/ledger/repayments — T4e customer repayment (تسديد دفعة), ONLINE path.
 *
 * FILE LOCATION: app/api/ledger/repayments/route.ts (the folder path IS the URL).
 *
 * Shape and safety properties mirror POST /api/ledger/voids exactly:
 *   1. a real session with a tenantId (401 otherwise);
 *   2. assertRolePermission(role, "ledger:log_repayment") FIRST — a CASHIER is
 *      rejected with 403 before the body is even read, so a raw HTTP call
 *      performs ZERO writes and does not reach any validation;
 *   3. assertTenantWritable(tenantId) — an EXPIRED/PENDING subscription is
 *      rejected with 403;
 *   4. the actual work is delegated to recordRepaymentIdempotent (which opens
 *      the transaction around recordRepayment) — the SAME core the sync
 *      engine's Payment pass calls. This route contains no repayment rules of
 *      its own: no balance formula, no exchange-rate read, no write, no P2002
 *      recovery of its own.
 *
 * tenantId always comes from the session — never from the request body.
 * `offlineId` is required: the client generates one key when the dialog opens
 * and reuses it for retries.
 */

const repaymentSchema = z.object({
  customerId: z.string().min(1).max(100),
  // A decimal string (the UI's normalized input) or a plain number — both go
  // through lib/utils/money.ts inside recordRepayment, which owns the real
  // validation (positive, 4-dp, <= balance). The max length only bounds payload
  // size; it is not a money rule.
  amountSYP: z.union([z.string().min(1).max(64), z.number()]),
  // Derived from the generated Prisma enum, so it can never drift from
  // schema.prisma (no second hand-typed list).
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  receiptNo: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  // Idempotency key — required. Generated once when the dialog opens.
  offlineId: z.string().min(1).max(100),
});

function successBody(result: Awaited<ReturnType<typeof recordRepaymentIdempotent>>) {
  return {
    success: true,
    message: result.alreadyRecorded
      ? "هذه الدفعة مسجّلة مسبقاً — لم يتم تسجيلها مرة ثانية."
      : "تم تسجيل الدفعة بنجاح.",
    paymentId: result.paymentId,
    customerId: result.customerId,
    amountSYP: result.amountSYP,
    amountUSD: result.amountUSD,
    exchangeRate: result.exchangeRate,
    balanceBeforeSYP: result.balanceBeforeSYP,
    // The card updates its balance from THIS value — no reload, and no
    // client-side re-derivation of the ledger formula.
    balanceSYP: result.balanceAfterSYP,
    alreadyRecorded: result.alreadyRecorded,
  };
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    // Role Capability Matrix: logging a repayment on the ledger screen is
    // ADMIN-only. Rejects CASHIER at the API level even on a raw HTTP call —
    // before any body parsing or write.
    assertRolePermission(session.user.role, "ledger:log_repayment");

    // Security boundary: assert tenant subscription is active.
    await assertTenantWritable(session.user.tenantId);

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json(
        { error: "BAD_REQUEST", message: "طلب غير صالح (JSON غير صحيح)." },
        { status: 400 }
      );
    }

    const parsed = repaymentSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: "يجب تحديد الزبون وقيمة الدفعة بشكل صحيح.",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const tenantId = session.user.tenantId;
    const input = parsed.data;
    const db = getTenantDb(tenantId);
    const result = await recordRepaymentIdempotent(db, tenantId, {
      customerId: input.customerId,
      amountSYP: input.amountSYP,
      paymentMethod: input.paymentMethod,
      receiptNo: input.receiptNo ?? null,
      notes: input.notes ?? null,
      offlineId: input.offlineId,
    });
    return NextResponse.json(successBody(result));
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }

    if (error instanceof RepaymentError) {
      return NextResponse.json(
        { error: "REPAYMENT_REJECTED", code: error.code, message: error.message },
        { status: error.status }
      );
    }

    console.error("Error logging repayment:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء تسجيل الدفعة." },
      { status: 500 }
    );
  }
}
