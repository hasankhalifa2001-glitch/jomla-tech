import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SUBSCRIPTION_GRACE_DAYS, SUBSCRIPTION_OFFER_VALIDITY_HOURS } from "@/lib/config/subscription";

export const dynamic = "force-dynamic";

/**
 * T6c §5 — Daily subscription reconciliation.
 *
 * Idempotent, safe to run twice, and NEVER required for correctness: locking
 * itself is evaluated live on every request by getEffectiveTenantStatus()
 * (assertTenantWritable / middleware / store gate). This job only flips
 * STORED rows so dashboards, reports and the Super-Admin queue read a tidy
 * value instead of relying on computed status everywhere:
 *   - Tenant rows stored ACTIVE whose expiresAt + grace has passed
 *     → subscriptionStatus = EXPIRED;
 *   - their ACTIVE subscription rows → EXPIRED;
 *   - stale receipt-less offers (PENDING_APPROVAL, no receipt, older than
 *     the offer-validity window) → system REJECTED with a reason.
 *
 * Protection: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron configured
 * with the same header). Missing/wrong → 401, no work done.
 */
function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim().length === 0) return false;
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length);
  if (presented.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= secret.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "غير مصرح." },
      { status: 401 }
    );
  }

  const now = new Date();
  const lockCutoff = new Date(
    now.getTime() - SUBSCRIPTION_GRACE_DAYS * 24 * 60 * 60 * 1000
  );
  const offerCutoff = new Date(
    now.getTime() - SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000
  );

  // Tenants stored ACTIVE whose lock moment already passed (idempotent: the
  // WHERE clause only matches rows still stored ACTIVE, so a second run is
  // a no-op).
  const staleTenants = await prisma.tenant.findMany({
    where: {
      subscriptionStatus: "ACTIVE",
      expiresAt: { not: null, lt: lockCutoff },
    },
    select: { id: true },
  });
  const staleTenantIds = staleTenants.map((t) => t.id);

  let tenantsExpired = 0;
  let subscriptionsExpired = 0;
  let offersRejected = 0;

  if (staleTenantIds.length > 0) {
    const flipped = await prisma.tenant.updateMany({
      where: { id: { in: staleTenantIds }, subscriptionStatus: "ACTIVE" },
      data: { subscriptionStatus: "EXPIRED" },
    });
    tenantsExpired = flipped.count;

    const subs = await prisma.subscription.updateMany({
      where: { tenantId: { in: staleTenantIds }, status: "ACTIVE" },
      data: { status: "EXPIRED" },
    });
    subscriptionsExpired = subs.count;
  }

  // Stale receipt-less offers: never had a receipt and outlived the validity
  // window → system REJECTED (idempotent: only PENDING_APPROVAL rows match).
  const staleOffers = await prisma.subscription.updateMany({
    where: {
      status: "PENDING_APPROVAL",
      receiptImageURL: null,
      createdAt: { lt: offerCutoff },
    },
    data: {
      status: "REJECTED",
      rejectionReason: "انتهت صلاحية العرض دون إرفاق إيصال.",
    },
  });
  offersRejected = staleOffers.count;

  return NextResponse.json({
    success: true,
    tenantsExpired,
    subscriptionsExpired,
    offersRejected,
  });
}
