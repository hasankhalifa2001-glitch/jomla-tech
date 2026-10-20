/**
 * T6b Phase 2 — GET /api/admin/subscriptions/[id]/receipt
 *
 * Short-lived signed receipt URL (≤ 5 minutes) for the Super-Admin reviewer.
 * Reads the key through lib/data/platform-admin.ts (the only importer of the
 * platform gateway) and pins it under the row's OWN tenant prefix before
 * signing. No receipt → 404.
 */
import { NextResponse } from "next/server";
import {
    requirePlatformAdmin,
    platformAdminForbiddenResponse,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import { getSubscriptionReceiptKey, SubscriptionNotFoundError } from "@/lib/data/platform-admin";
import { createReceiptSignedUrl, RECEIPT_SIGNED_URL_MAX_SECONDS } from "@/lib/storage";

export const dynamic = "force-dynamic";

function notFound(message = "لا يوجد إيصال مرفق بهذا الطلب.") {
    return NextResponse.json({ error: "NOT_FOUND", message }, { status: 404 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    let ctx: PlatformAdminContext;
    try {
        ctx = await requirePlatformAdmin();
    } catch (error) {
        if (error instanceof PlatformAdminDeniedError) return platformAdminForbiddenResponse(error);
        throw error;
    }

    let found: { tenantId: string; receiptKey: string | null };
    try {
        found = await getSubscriptionReceiptKey(ctx, id);
    } catch (error) {
        if (error instanceof SubscriptionNotFoundError) return notFound("طلب الاشتراك غير موجود.");
        console.error("[admin/subscriptions] receipt lookup failed:", error);
        return NextResponse.json({ error: "SERVER_ERROR", message: "تعذّر تحميل الإيصال." }, { status: 500 });
    }

    if (!found.receiptKey) return notFound();

    // The key must live under this row's own tenant prefix before signing.
    if (!found.receiptKey.startsWith(`receipts/${found.tenantId}/`)) {
        console.error("[admin/subscriptions] receipt key outside tenant prefix:", id);
        return notFound();
    }

    try {
        // The helper clamps the TTL to 300s regardless of what is passed.
        const url = await createReceiptSignedUrl(found.receiptKey, RECEIPT_SIGNED_URL_MAX_SECONDS);
        return NextResponse.json({ url, expiresInSeconds: RECEIPT_SIGNED_URL_MAX_SECONDS });
    } catch (error) {
        console.error("[admin/subscriptions] receipt sign failed:", error);
        return NextResponse.json({ error: "SERVER_ERROR", message: "تعذّر تحميل الإيصال." }, { status: 500 });
    }
}