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
 * Ambiguous-commit recovery: if a RETRY (attempt > 1) hits ALREADY_REVIEWED, or
 * retries are exhausted on a transient error, the order is re-read; when it was
 * approved by THIS user a moment ago and has an invoice, the committed result is
 * returned as a normal 200 instead of a misleading 409/503.
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
} from "@/lib/data/orders-approval";
import { approveOrderInTransaction, recoverCommittedApproval } from "@/lib/data/orders-approval-tx";

export const dynamic = "force-dynamic";

const CODES = APPROVAL_STORE_ERROR_CODES;

/** Body-size bound (bytes). 50 lines x (id + 4dp qty) + customer/payment is a few KB. */
const MAX_BODY_BYTES = 32 * 1024;

/** Domain errors are NEVER retried — every Approval* + Zod + MoneyError. */
function isApprovalFatal(err: unknown): boolean {
    return err instanceof z.ZodError || err instanceof MoneyError || err instanceof ApprovalDomainError;
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
    // attempts (P2028 failures capped at 2). Domain errors rethrow
    // immediately via isFatal.
    let attempts = 0;
    try {
        const result = await withTxRetries(
            () => {
                attempts += 1;
                return prisma.$transaction(
                    (tx) =>
                        approveOrderInTransaction(tx, {
                            orderId: id,
                            tenantId,
                            approvingUserId: userId,
                            body: body.data,
                        }),
                    APPROVAL_TX_OPTIONS
                );
            },
            { isFatal: isApprovalFatal }
        );
        return NextResponse.json({
            success: true,
            invoiceId: result.invoiceId,
            totalSYP: result.totalSYP,
            paidAmountSYP: result.paidAmountSYP,
            debtAmountSYP: result.debtAmountSYP,
            customerId: result.customerId,
        });
    } catch (error) {
        // ---- Ambiguous-commit recovery ------------------------------------
        // (a) a RETRY (attempt > 1) found the order already APPROVED: the
        //     earlier attempt may have committed before its response was lost;
        // (b) retries were exhausted on a transient error: the last attempt
        //     may have committed. Never applied on a first-attempt 409.
        const maybeCommitted =
            (error instanceof ApprovalAlreadyReviewedError && attempts > 1) ||
            (isRetryableTxError(error) && attempts >= 1);
        if (maybeCommitted) {
            try {
                const recovered = await recoverCommittedApproval(prisma, {
                    orderId: id,
                    tenantId,
                    userId,
                });
                if (recovered) {
                    return NextResponse.json({
                        success: true,
                        invoiceId: recovered.invoiceId,
                        totalSYP: recovered.totalSYP,
                        paidAmountSYP: recovered.paidAmountSYP,
                        debtAmountSYP: recovered.debtAmountSYP,
                        customerId: recovered.customerId,
                    });
                }
            } catch (recoveryError) {
                console.error("Recovery check failed after approval error:", recoveryError);
            }
        }

        // ---- Typed domain errors → their specific HTTP code ---------------
        // Mapping happens HERE, outside the transaction (already rolled back).
        if (error instanceof ApprovalOrderNotFoundError) {
            return NextResponse.json({ code: CODES.notFound, message: error.message }, { status: 404 });
        }
        if (error instanceof ApprovalAlreadyReviewedError) {
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
        // A malformed monetary figure is a client-actionable validation problem,
        // never a server fault and never raw exception text.
        if (error instanceof MoneyError) {
            console.error("Invalid monetary value approving B2B order:", error);
            return NextResponse.json(
                { code: CODES.validation, message: "قيمة مالية غير صالحة في بيانات الموافقة." },
                { status: 400 }
            );
        }
        // A retryable transaction failure (after retries) → clear Arabic
        // "try again", fully rolled back, never FORBIDDEN.
        if (isRetryableTxError(error)) {
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