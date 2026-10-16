/**
 * T5c — POST /api/orders/[id]/approve
 *
 * ADMIN only (orders:approve; CASHIER → 403 with zero writes). assertTenantWritable
 * runs before any write (locked tenant → 403 TENANT_NOT_WRITABLE). Strict zod
 * body (body-size bounded, read as text first). Opens ONE raw `prisma.$transaction`
 * (category-5: the gateway needs lockBatchesForFifoAllocations/commitFifoAllocation,
 * both typed to Prisma.TransactionClient) and delegates the whole write-sequence
 * to lib/data/orders-approval-tx.ts. Typed domain errors are mapped to HTTP HERE,
 * OUTSIDE the transaction — any throw inside rolls everything back and the order
 * stays PENDING_REVIEW. Every response is { code, message } (+ optional details),
 * Arabic, never carrying raw exception text.
 *
 * IDEMPOTENT RESUBMISSION: when the transaction reports ALREADY_REVIEWED, the
 * route checks (read-only) whether THIS admin already committed an IDENTICAL
 * approval within the last 2 minutes (same quantities, payment mode and
 * customer). If so it answers with the committed result, so a retry after a
 * lost response never looks like a failure. Any difference stays a 409.
 *
 * Reject remains POST /api/orders/[id]/reject (T5b). This is the ONLY approval
 * path (the legacy PATCH /api/orders/[id]/status route is retired — D19).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isRetryableTxError, withTxRetries } from "@/lib/db/tx-retry";
import { MoneyError } from "@/lib/utils/money";
import { assertRolePermission, ForbiddenRoleError } from "@/lib/auth/role-matrix";
import { assertTenantWritable, SubscriptionLockedError } from "@/lib/auth/tenant";
import {
    APPROVAL_STORE_ERROR_CODES,
    APPROVAL_TX_OPTIONS,
    approveOrderBodySchema,
    ApprovalAlreadyReviewedError,
    ApprovalDomainError,
    ApprovalInsufficientStockError,
    ApprovalInvalidCustomerError,
    ApprovalInvalidPaymentError,
    ApprovalOrderNotFoundError,
    ApprovalProductInactiveError,
    ApprovalRateRequiredError,
    ApprovalValidationError,
    type ApproveOrderBody,
    type ApproveOrderResult,
} from "@/lib/data/orders-approval";
import { approveOrderInTransaction, recoverCommittedApproval } from "@/lib/data/orders-approval-tx";

export const dynamic = "force-dynamic";

const CODES = APPROVAL_STORE_ERROR_CODES;

/** Body-size bound. 50 lines x (id + 4dp qty) + customer/payment is a few KB. */
const MAX_BODY_BYTES = 32 * 1024;

/** Retryable Prisma transaction failures → a clear "try again", never FORBIDDEN. */
function isApprovalRetryable(err: unknown): boolean {
    return isRetryableTxError(err);
}

/**
 * Domain errors are NEVER retried. ONE base class covers every typed approval
 * failure, so a newly added error class can never be retried by accident.
 */
function isApprovalFatal(err: unknown): boolean {
    return err instanceof ApprovalDomainError || err instanceof z.ZodError || err instanceof MoneyError;
}

function successResponse(result: ApproveOrderResult) {
    return NextResponse.json({
        success: true,
        invoiceId: result.invoiceId,
        totalSYP: result.totalSYP,
        paidAmountSYP: result.paidAmountSYP,
        debtAmountSYP: result.debtAmountSYP,
        customerId: result.customerId,
    });
}

/** Never lets a recovery failure mask the original 409. */
async function tryRecover(params: {
    orderId: string;
    tenantId: string;
    userId: string;
    body: ApproveOrderBody;
}): Promise<ApproveOrderResult | null> {
    try {
        return await recoverCommittedApproval(prisma, params);
    } catch (error) {
        console.error("Approval recovery check failed:", error);
        return null;
    }
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // ---- 1. Auth ---------------------------------------------------------
    const session = await auth();
    if (!session?.user?.tenantId || !session.user.id) {
        return NextResponse.json(
            { code: CODES.unauthorized, message: "يرجى تسجيل الدخول أولاً." },
            { status: 401 }
        );
    }
    const tenantId = session.user.tenantId;
    const userId = session.user.id;

    // ---- 2. Role (ADMIN only; D20) --------------------------------------
    try {
        assertRolePermission(session.user.role, "orders:approve");
    } catch (error) {
        if (error instanceof ForbiddenRoleError) {
            return NextResponse.json(
                { code: CODES.forbidden, message: error.message },
                { status: 403 }
            );
        }
        throw error;
    }

    // ---- 3. Body (size-bounded, read as text first, strict zod) ---------
    const raw = await req.text().catch(() => "");
    if (raw.length > MAX_BODY_BYTES) {
        return NextResponse.json(
            { code: CODES.validation, message: "حجم الطلب كبير جداً." },
            { status: 400 }
        );
    }
    let parsedJson: unknown;
    try {
        parsedJson = raw ? JSON.parse(raw) : null;
    } catch {
        parsedJson = null;
    }
    const body = approveOrderBodySchema.safeParse(parsedJson);
    if (!body.success) {
        return NextResponse.json(
            { code: CODES.validation, message: "بيانات الموافقة غير صالحة." },
            { status: 400 }
        );
    }

    // ---- 4. Tenant writable (fresh DB read) ------------------------------
    try {
        await assertTenantWritable(tenantId);
    } catch (error) {
        if (error instanceof SubscriptionLockedError) {
            return NextResponse.json(
                { code: CODES.tenantNotWritable, message: error.message },
                { status: 403 }
            );
        }
        throw error;
    }

    // ---- 5. The ONE approval transaction (retried on transient only) ------
    // withTxRetries re-runs the WHOLE closure (claim included) up to 3
    // attempts (P2028 capped at 2 failures). Domain errors rethrow immediately
    // via isFatal — INSUFFICIENT_STOCK / ALREADY_REVIEWED / validation never
    // retry.
    try {
        const result = await withTxRetries(
            () =>
                prisma.$transaction(
                    (tx) =>
                        approveOrderInTransaction(tx, {
                            orderId: id,
                            tenantId,
                            approvingUserId: userId,
                            body: body.data,
                        }),
                    APPROVAL_TX_OPTIONS
                ),
            { isFatal: isApprovalFatal }
        );
        return successResponse(result);
    } catch (error) {
        // Typed domain errors → their specific HTTP code. Mapping happens HERE,
        // outside the transaction, so the tx has already fully rolled back.
        if (error instanceof ApprovalOrderNotFoundError) {
            return NextResponse.json({ code: CODES.notFound, message: error.message }, { status: 404 });
        }
        if (error instanceof ApprovalAlreadyReviewedError) {
            // Identical resubmission by the same admin within the window (e.g.
            // the first attempt committed but its response was lost): answer
            // with the committed result. Anything else stays a 409.
            const recovered = await tryRecover({ orderId: id, tenantId, userId, body: body.data });
            if (recovered) return successResponse(recovered);
            return NextResponse.json({ code: CODES.alreadyReviewed, message: error.message }, { status: 409 });
        }
        if (error instanceof ApprovalInsufficientStockError) {
            return NextResponse.json(
                { code: CODES.insufficientStock, message: error.message, details: error.lines },
                { status: 409 }
            );
        }
        if (error instanceof ApprovalProductInactiveError) {
            return NextResponse.json({ code: CODES.productInactive, message: error.message }, { status: 409 });
        }
        if (error instanceof ApprovalRateRequiredError) {
            return NextResponse.json({ code: CODES.rateRequired, message: error.message }, { status: 422 });
        }
        if (error instanceof ApprovalInvalidCustomerError) {
            return NextResponse.json({ code: CODES.invalidCustomer, message: error.message }, { status: 400 });
        }
        if (error instanceof ApprovalInvalidPaymentError) {
            return NextResponse.json({ code: CODES.invalidPayment, message: error.message }, { status: 400 });
        }
        if (error instanceof ApprovalValidationError) {
            return NextResponse.json({ code: CODES.validation, message: error.message }, { status: 400 });
        }
        // A retryable transaction failure → clear Arabic "try again" (503),
        // fully rolled back, never FORBIDDEN. Reached only after withTxRetries
        // exhausted its attempts.
        if (isApprovalRetryable(error)) {
            console.error("Retryable tx failure approving B2B order:", error);
            return NextResponse.json(
                { code: CODES.txRetry, message: "تعذّر إتمام العملية بسبب ضغط على الخادم، حاول مرة ثانية." },
                { status: 503 }
            );
        }
        // Unexpected: log server-side, generic Arabic message, never FORBIDDEN,
        // never raw exception text.
        console.error("Unexpected error approving B2B order:", error);
        return NextResponse.json(
            { code: CODES.internal, message: "حدث خطأ أثناء قبول الطلب." },
            { status: 500 }
        );
    }
}