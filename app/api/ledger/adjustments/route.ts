/**
 * app/api/ledger/adjustments/route.ts
 *
 * POST /api/ledger/adjustments — record a customer balance adjustment
 * (opening previous debt or correction). ADMIN only, ONLINE only.
 * GET /api/ledger/adjustments?customerId= — adjustment history for one
 * customer (ADMIN + CASHIER read-only).
 *
 * Safety properties, in order:
 *   1. a real session with a tenantId (401 otherwise);
 *   2. assertRolePermission(role, "ledger:add_balance_adjustment") FIRST — a
 *      CASHIER is rejected with 403 before the body is even read, so a raw
 *      HTTP call performs ZERO writes;
 *   3. assertTenantWritable(tenantId) — a non-writable tenant is rejected with
 *      403 TENANT_NOT_WRITABLE;
 *   4. strict validation, then the idempotency pre-check, then ONE
 *      $transaction with top-level calls only (no nested writes, no
 *      $queryRaw). The balance formula is NOT re-typed here: every balance
 *      comes from getCustomerBalanceSYP (lib/ledger/balance.ts).
 *
 * Every response body is { code, message } (plus `details` on a validation
 * error). An unexpected failure is 500 INTERNAL_ERROR — never FORBIDDEN.
 *
 * tenantId always comes from the session — never from the request body.
 * idempotencyKey is client-generated (one UUID per submission); the
 * @@unique([tenantId, idempotencyKey]) constraint makes a double-submit a
 * no-op that returns the existing row instead of recording the debt twice,
 * while a key reused with a DIFFERENT payload is rejected with 409.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import {
  assertTenantWritable,
  SubscriptionLockedError,
} from "@/lib/auth/tenant";
import {
  assertRolePermission,
  ForbiddenRoleError,
} from "@/lib/auth/role-matrix";
import { getTenantDb, type TxOrClient } from "@/lib/db/tenant-scope";
import { resolveActiveCustomerId } from "@/lib/customers/resolve-active";
import {
  createBalanceAdjustment,
  findAdjustmentByIdempotencyKey,
  listAdjustmentsForCustomer,
} from "@/lib/data/ledger-adjustments";
import { MAX_ADJUSTMENT_AMOUNT_SYP } from "@/lib/config/ledger";
import { STORE_ERROR } from "@/lib/config/storefront";
import { getCustomerBalanceSYP } from "@/lib/ledger/balance";
import {
  addMoney,
  compareMoney,
  serializeMoney,
  subtractMoney,
} from "@/lib/utils/money";

const DEFAULT_OPENING_REASON = "دين سابق من الدفتر";

// A plain signed decimal string with at most 4 decimals (the column is
// Decimal(18,4)): anything else is rejected instead of being rounded by the
// database. No exponent notation, no thousands separators.
const MONEY_STRING = /^-?\d{1,14}(\.\d{1,4})?$/;

const customerSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("EXISTING"),
      customerId: z.string().min(1, "معرف الزبون مطلوب."),
    })
    .strict(),
  z
    .object({
      mode: z.literal("NEW"),
      name: z
        .string()
        .trim()
        .min(2, "اسم الزبون يجب أن يكون حرفين على الأقل.")
        .max(80, "اسم الزبون طويل جداً."),
      phone: z.string().trim().max(30, "رقم الهاتف طويل جداً.").optional().nullable(),
      shopName: z.string().trim().max(80, "اسم المحل طويل جداً.").optional().nullable(),
    })
    .strict(),
]);

const adjustmentSchema = z
  .object({
    idempotencyKey: z.string().uuid("مفتاح الطلب يجب أن يكون بصيغة UUID صالحة."),
    kind: z.enum(["OPENING_BALANCE", "CORRECTION"]),
    amountSYP: z
      .string()
      .trim()
      .regex(MONEY_STRING, "قيمة المبلغ غير صالحة."),
    reason: z.string().max(1000, "الملاحظة طويلة جداً.").optional().nullable(),
    customer: customerSchema,
  })
  .strict();

type AdjustmentRequest = z.infer<typeof adjustmentSchema>;

function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: unknown
) {
  return NextResponse.json(
    details === undefined ? { code, message } : { code, message, details },
    { status }
  );
}

/** A deliberate business rejection raised inside the transaction (rolls it back). */
class AdjustmentRejectedError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AdjustmentRejectedError";
    this.code = code;
    this.status = status;
  }
}

/** "1000000000" -> "1,000,000,000" (display only; string-based, no float math). */
function groupThousands(integerString: string): string {
  return integerString.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Structured P2002 check — never a message substring. Prisma/Postgres can
 * report the target as an array of field names OR as the constraint-name
 * string; both identify the (tenantId, idempotencyKey) unique index.
 */
function isIdempotencyKeyConflict(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    const target = error.meta?.target;
    if (Array.isArray(target)) {
      return target.some(
        (t) => typeof t === "string" && t.includes("idempotencyKey")
      );
    }
    if (typeof target === "string") {
      return target.includes("idempotencyKey");
    }
  }
  return false;
}

type StoredAdjustment = {
  id: string;
  customerId: string;
  kind: string;
  amountSYP: { toString(): string };
};

/**
 * Does an already-stored row represent the SAME request? Compares kind and
 * amount exactly; for EXISTING also compares the RESOLVED customers (never raw
 * ids — a later merge may have re-pointed the stored row to the survivor).
 * For NEW only kind and amount are compared (the first attempt created the
 * customer).
 */
async function isSameRequest(
  db: TxOrClient,
  tenantId: string,
  stored: StoredAdjustment,
  request: { kind: string; amountSYP: string; customer: AdjustmentRequest["customer"] }
): Promise<boolean> {
  if (stored.kind !== request.kind) return false;
  if (compareMoney(stored.amountSYP.toString(), request.amountSYP) !== 0) return false;
  if (request.customer.mode === "NEW") return true;
  const [storedResolved, requestResolved] = await Promise.all([
    resolveActiveCustomerId(db, tenantId, stored.customerId),
    resolveActiveCustomerId(db, tenantId, request.customer.customerId),
  ]);
  return storedResolved === requestResolved;
}

/** The normal success shape for a replayed (already stored) adjustment. */
async function replayResponse(
  db: TxOrClient,
  tenantId: string,
  stored: StoredAdjustment
) {
  const [customerRow, newBalanceSYP] = await Promise.all([
    db.customer.findFirst({
      where: { id: stored.customerId, tenantId },
      select: { name: true },
    }),
    getCustomerBalanceSYP(db, tenantId, stored.customerId),
  ]);
  return NextResponse.json({
    adjustmentId: stored.id,
    customerId: stored.customerId,
    customerName: customerRow?.name ?? "",
    amountSYP: stored.amountSYP.toString(),
    newBalanceSYP,
  });
}

function keyReusedResponse() {
  return errorResponse(
    STORE_ERROR.IDEMPOTENCY_KEY_REUSED,
    "مفتاح الطلب مستخدم سابقاً بمبلغ أو نوع أو زبون مختلف — لم يتم تسجيل أي شيء.",
    409
  );
}

async function handlePost(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session || !session.user || !session.user.tenantId || !session.user.id) {
    return errorResponse(STORE_ERROR.UNAUTHORIZED, "يرجى تسجيل الدخول أولاً.", 401);
  }
  assertRolePermission(session.user.role, "ledger:add_balance_adjustment");
  await assertTenantWritable(session.user.tenantId);

  const tenantId = session.user.tenantId;
  const userId = session.user.id;
  const db = getTenantDb(tenantId);

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(STORE_ERROR.VALIDATION_ERROR, "طلب غير صالح (JSON غير صحيح).", 400);
  }

  const parsed = adjustmentSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      STORE_ERROR.VALIDATION_ERROR,
      "يجب تحديد بيانات التعديل بشكل صحيح.",
      400,
      parsed.error.flatten().fieldErrors
    );
  }
  const { idempotencyKey, kind, amountSYP, reason, customer } = parsed.data;

  let normalizedAmount: string;
  try {
    normalizedAmount = serializeMoney(amountSYP);
  } catch {
    return errorResponse(STORE_ERROR.VALIDATION_ERROR, "قيمة المبلغ غير صالحة.", 400);
  }

  // Sign rules (D5). Only OPENING_BALANCE must be positive; a CORRECTION is
  // signed (negative = decrease, positive = increase) and merely non-zero.
  const sign = compareMoney(normalizedAmount, "0");
  if (kind === "OPENING_BALANCE" && sign <= 0) {
    return errorResponse(
      STORE_ERROR.VALIDATION_ERROR,
      "رصيد الافتتاح يجب أن يكون أكبر من صفر.",
      400
    );
  }
  if (kind === "CORRECTION" && sign === 0) {
    return errorResponse(
      STORE_ERROR.VALIDATION_ERROR,
      "تصحيح الرصيد يجب أن تكون قيمته غير صفرية.",
      400
    );
  }

  // Upper bound applies to the ABSOLUTE amount (a correction can be negative).
  const absoluteAmount =
    sign < 0 ? subtractMoney("0", normalizedAmount) : normalizedAmount;
  if (compareMoney(absoluteAmount, MAX_ADJUSTMENT_AMOUNT_SYP) > 0) {
    return errorResponse(
      STORE_ERROR.VALIDATION_ERROR,
      `المبلغ كبير جداً. الحد الأقصى المسموح به ${groupThousands(
        MAX_ADJUSTMENT_AMOUNT_SYP
      )} ل.س.`,
      400
    );
  }

  // A NEW customer is only allowed with an opening balance.
  if (customer.mode === "NEW" && kind !== "OPENING_BALANCE") {
    return errorResponse(
      STORE_ERROR.VALIDATION_ERROR,
      "إنشاء زبون جديد غير مسموح إلا مع رصيد افتتاحي.",
      400
    );
  }

  let finalReason = reason?.trim() ?? "";
  if (kind === "OPENING_BALANCE") {
    if (!finalReason) finalReason = DEFAULT_OPENING_REASON;
  } else if (finalReason.length < 3) {
    return errorResponse(
      STORE_ERROR.VALIDATION_ERROR,
      "سبب التصحيح مطلوب (بين 3 و 300 حرفاً).",
      400
    );
  }
  if (finalReason.length > 300) {
    return errorResponse(
      STORE_ERROR.VALIDATION_ERROR,
      "الملاحظة يجب ألا تتجاوز 300 حرفاً.",
      400
    );
  }

  const request = { kind, amountSYP: normalizedAmount, customer };

  // Idempotency pre-check: replay a matching row, reject a mismatching one.
  const existing = await findAdjustmentByIdempotencyKey(db, tenantId, idempotencyKey);
  if (existing) {
    if (await isSameRequest(db, tenantId, existing, request)) {
      return replayResponse(db, tenantId, existing);
    }
    return keyReusedResponse();
  }

  // One $transaction, top-level calls only.
  try {
    const result = await db.$transaction(async (tx) => {
      let targetCustomerId: string;
      let customerName: string;

      if (customer.mode === "EXISTING") {
        targetCustomerId = await resolveActiveCustomerId(tx, tenantId, customer.customerId);
        const target = await tx.customer.findFirst({
          where: { id: targetCustomerId, tenantId },
          select: { id: true, name: true, isSystemGenerated: true, isActive: true },
        });
        if (!target || target.isSystemGenerated || !target.isActive) {
          throw new AdjustmentRejectedError(
            STORE_ERROR.INVALID_CUSTOMER,
            "الزبون غير صالح أو غير نشط أو غير موجود لهذا المتجر.",
            400
          );
        }
        customerName = target.name;
      } else {
        const created = await tx.customer.create({
          data: {
            tenantId,
            name: customer.name,
            phone: customer.phone?.trim() || null,
            shopName: customer.shopName?.trim() || null,
            isSystemGenerated: false,
            offlineId: null,
          },
          select: { id: true, name: true },
        });
        targetCustomerId = created.id;
        customerName = created.name;
      }

      // D6: a DECREASING correction must never drive the NET balance (invoices
      // + adjustments - repayments, through the one formula) below zero.
      if (kind === "CORRECTION" && sign < 0) {
        const currentBalance = await getCustomerBalanceSYP(tx, tenantId, targetCustomerId);
        const projected = addMoney(currentBalance, normalizedAmount);
        if (compareMoney(projected, "0") < 0) {
          throw new AdjustmentRejectedError(
            STORE_ERROR.VALIDATION_ERROR,
            "هذا التصحيح سيخفض رصيد الزبون إلى أقل من صفر — لم يتم تسجيل أي تعديل.",
            400
          );
        }
      }

      const createdAdjustment = await createBalanceAdjustment(tx, {
        tenantId,
        createdByUserId: userId,
        customerId: targetCustomerId,
        kind,
        amountSYP: normalizedAmount,
        reason: finalReason,
        idempotencyKey,
      });

      const newBalanceSYP = await getCustomerBalanceSYP(tx, tenantId, targetCustomerId);

      return {
        adjustmentId: createdAdjustment.id,
        customerId: targetCustomerId,
        customerName,
        amountSYP: createdAdjustment.amountSYP.toString(),
        newBalanceSYP,
      };
    });
    return NextResponse.json(result);
  } catch (txError) {
    if (txError instanceof AdjustmentRejectedError) {
      return errorResponse(txError.code, txError.message, txError.status);
    }
    if (isIdempotencyKeyConflict(txError)) {
      // A racing duplicate won: this whole transaction (including any NEW
      // customer row) rolled back. Re-read the winner and answer like step 3.
      const winner = await findAdjustmentByIdempotencyKey(db, tenantId, idempotencyKey);
      if (winner) {
        if (await isSameRequest(db, tenantId, winner, request)) {
          return replayResponse(db, tenantId, winner);
        }
        return keyReusedResponse();
      }
    }
    // Any other error, including an unrelated P2002, is NOT an idempotent
    // replay: let the outer handler report it as 500 INTERNAL_ERROR.
    throw txError;
  }
}

export async function POST(req: Request) {
  try {
    return await handlePost(req);
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return errorResponse(STORE_ERROR.FORBIDDEN, error.message, 403);
    }
    if (error instanceof SubscriptionLockedError) {
      return errorResponse(
        STORE_ERROR.TENANT_NOT_WRITABLE,
        error.message || "اشتراك المتجر غير فعّال حالياً — لا يمكن تسجيل تعديلات.",
        403
      );
    }
    console.error("Error recording balance adjustment:", error);
    return errorResponse(
      STORE_ERROR.INTERNAL_ERROR,
      "حدث خطأ غير متوقع أثناء تسجيل التعديل. لم يتم تسجيل أي شيء مؤكد، تحقق من السجل قبل إعادة المحاولة.",
      500
    );
  }
}

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return errorResponse(STORE_ERROR.UNAUTHORIZED, "يرجى تسجيل الدخول أولاً.", 401);
    }
    assertRolePermission(session.user.role, "ledger:view_balances");

    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get("customerId");
    if (!customerId) {
      return errorResponse(STORE_ERROR.VALIDATION_ERROR, "معرف الزبون مطلوب.", 400);
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    const rows = await listAdjustmentsForCustomer(db, tenantId, customerId);

    return NextResponse.json({
      success: true,
      adjustments: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        amountSYP: row.amountSYP.toString(),
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
        createdByUser: { name: row.createdByUser?.name ?? "" },
      })),
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return errorResponse(STORE_ERROR.FORBIDDEN, error.message, 403);
    }
    console.error("Error fetching balance adjustments:", error);
    return errorResponse(
      STORE_ERROR.INTERNAL_ERROR,
      "حدث خطأ أثناء جلب سجل تعديلات الرصيد.",
      500
    );
  }
}