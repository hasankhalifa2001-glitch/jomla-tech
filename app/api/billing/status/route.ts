import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
  assertAdmin,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import {
  assertUserActive,
  UserInactiveError,
  userInactiveResponse,
} from "@/lib/auth/user";
import {
  SUBSCRIPTION_TIERS,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_RENEWAL_WARNING_DAYS,
  SUBSCRIPTION_OFFER_VALIDITY_HOURS,
  SHAM_CASH_WALLET,
} from "@/lib/config/subscription";
import {
  getEffectiveTenantStatus,
  type EffectiveTenantStatusResult,
} from "@/lib/subscription/effective-status";
import { getPlatformExchangeRate } from "@/lib/data/platform-rate";
import { multiplyMoney, roundToWholeLira, toDecimal } from "@/lib/utils/money";

const OFFER_VALIDITY_MS = SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000;

function statusLabel(effective: EffectiveTenantStatusResult): string {
  switch (effective.status) {
    case "PENDING":
      return "بانتظار تفعيل حسابك";
    case "GRACE":
      return `انتهى اشتراكك، متبقي ${effective.graceDaysLeft ?? 0} يوم قبل إيقاف النظام`;
    case "EXPIRED":
      return "انتهى الاشتراك";
    default:
      return "اشتراك نشط";
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.tenantId || !session.user.id) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
      { status: 401 }
    );
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  try {
    assertAdmin(session.user.role);
  } catch (error) {
    if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
    throw error;
  }

  try {
    await assertUserActive(tenantId, userId);
  } catch (error) {
    if (error instanceof UserInactiveError) return userInactiveResponse(error);
    throw error;
  }

  const db = getTenantDb(tenantId);

  const [tenant, openRequest, recentRequests] = await Promise.all([
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, subscriptionStatus: true, expiresAt: true },
    }),
    db.subscription.findFirst({
      where: { tenantId, status: "PENDING_APPROVAL" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        tier: true,
        amountSYP: true,
        amountUSD: true,
        referenceCode: true,
        status: true,
        receiptImageURL: true, // only to compute hasReceipt; never returned
        createdAt: true,
      },
    }),
    db.subscription.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        tier: true,
        amountSYP: true,
        amountUSD: true,
        status: true,
        receiptImageURL: true, // only to compute hasReceipt; never returned
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  if (!tenant) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "المتجر غير موجود." },
      { status: 404 }
    );
  }

  const now = new Date();
  const effective = getEffectiveTenantStatus(tenant, now);

  // Platform rate (never the merchant's own rate). Used ONLY for the
  // informational SYP preview on the plan cards; the charged amount is
  // computed and frozen by POST /api/billing/subscriptions.
  let usableRate: string | null = null;
  const platformRaw = await getPlatformExchangeRate(tenantId);
  if (platformRaw) {
    try {
      const d = toDecimal(platformRaw);
      if (!d.isZero() && !d.isNegative()) usableRate = d.toString();
    } catch {
      usableRate = null;
    }
  }

  const plans = Object.entries(SUBSCRIPTION_TIERS).map(([tier, cfg]) => ({
    tier,
    label: (cfg as { label?: string }).label ?? tier,
    priceUSD: String(cfg.priceUSD),
    durationDays: cfg.durationDays,
    priceSYPPreview: usableRate
      ? roundToWholeLira(multiplyMoney(cfg.priceUSD, usableRate))
      : null,
  }));

  const openRequestView = openRequest
    ? (() => {
      const expiresOfferAt = new Date(
        openRequest.createdAt.getTime() + OFFER_VALIDITY_MS
      );
      const hasReceipt = Boolean(openRequest.receiptImageURL);
      return {
        id: openRequest.id,
        tier: openRequest.tier,
        amountSYP: openRequest.amountSYP.toString(),
        amountUSD: openRequest.amountUSD.toString(),
        referenceCode: openRequest.referenceCode,
        status: openRequest.status,
        hasReceipt,
        createdAt: openRequest.createdAt.toISOString(),
        expiresOfferAt: expiresOfferAt.toISOString(),
        // An expired offer WITH a receipt still awaits a human decision;
        // the UI shows it as stale for the reviewer, not as dead.
        isOfferExpired: now > expiresOfferAt,
      };
    })()
    : null;

  const recent = recentRequests.map((r) => ({
    id: r.id,
    tier: r.tier,
    amountSYP: r.amountSYP.toString(),
    amountUSD: r.amountUSD.toString(),
    status: r.status,
    hasReceipt: Boolean(r.receiptImageURL),
    rejectionReason: r.rejectionReason ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return NextResponse.json({
    status: effective.status,
    writable: effective.writable,
    label: statusLabel(effective),
    daysLeft: effective.daysLeft,
    graceDaysLeft: effective.graceDaysLeft,
    expiresAt: tenant.expiresAt ? tenant.expiresAt.toISOString() : null,
    lockAt: effective.lockAt ? effective.lockAt.toISOString() : null,
    graceDays: SUBSCRIPTION_GRACE_DAYS,
    renewalWarningDays: SUBSCRIPTION_RENEWAL_WARNING_DAYS,
    renewalWarning:
      effective.status === "ACTIVE" &&
      effective.daysLeft !== null &&
      effective.daysLeft <= SUBSCRIPTION_RENEWAL_WARNING_DAYS,
    rateAvailable: usableRate !== null,
    plans,
    wallet: SHAM_CASH_WALLET,
    openRequest: openRequestView,
    recentRequests: recent,
  });
}