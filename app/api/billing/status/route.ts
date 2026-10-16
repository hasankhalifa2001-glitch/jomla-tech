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
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_RENEWAL_WARNING_DAYS,
  SUBSCRIPTION_OFFER_VALIDITY_HOURS,
  SHAM_CASH_WALLET,
} from "@/lib/config/subscription";

export type EffectiveSubscriptionStatus =
  | "ACTIVE"
  | "GRACE"
  | "EXPIRED"
  | "PENDING";

interface EffectiveStatusResult {
  status: EffectiveSubscriptionStatus;
  label: string;
  daysLeft: number | null;
  expiresAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeEffectiveSubscriptionStatus(
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING" | null,
  expiresAt: Date | null
): EffectiveStatusResult {
  const now = Date.now();

  if (subscriptionStatus === "PENDING") {
    return {
      status: "PENDING",
      label: "بانتظار تفعيل حسابك",
      daysLeft: null,
      expiresAt: null,
    };
  }

  if (subscriptionStatus === "EXPIRED") {
    return {
      status: "EXPIRED",
      label: "انتهى الاشتراك",
      daysLeft: null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
  }

  if (expiresAt) {
    const expiryMs = expiresAt.getTime();
    if (now > expiryMs) {
      const graceEndMs = expiryMs + SUBSCRIPTION_GRACE_DAYS * DAY_MS;
      if (now <= graceEndMs) {
        const daysLeft = Math.ceil((graceEndMs - now) / DAY_MS);
        return {
          status: "GRACE",
          label: `انتهى اشتراكك، متبقي ${Math.max(daysLeft, 0)} يوم قبل إيقاف النظام`,
          daysLeft: Math.max(daysLeft, 0),
          expiresAt: expiresAt.toISOString(),
        };
      }
      return {
        status: "EXPIRED",
        label: "انتهى الاشتراك",
        daysLeft: null,
        expiresAt: expiresAt.toISOString(),
      };
    }
    const daysLeft = Math.ceil((expiryMs - now) / DAY_MS);
    return {
      status: "ACTIVE",
      label: "اشتراك نشط",
      daysLeft: Math.max(daysLeft, 0),
      expiresAt: expiresAt.toISOString(),
    };
  }

  return {
    status: "ACTIVE",
    label: "اشتراك نشط",
    daysLeft: null,
    expiresAt: null,
  };
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
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    throw error;
  }

  try {
    await assertUserActive(tenantId, userId);
  } catch (error) {
    if (error instanceof UserInactiveError) {
      return userInactiveResponse(error);
    }
    throw error;
  }

  const db = getTenantDb(tenantId);

  const [tenant, openRequest, recentRequests] = await Promise.all([
    db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        subscriptionStatus: true,
        expiresAt: true,
      },
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
        createdAt: true,
        expiresAt: true,
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
        status: true,
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

  const effective = computeEffectiveSubscriptionStatus(
    tenant.subscriptionStatus,
    tenant.expiresAt
  );

  const openRequestView = openRequest
    ? {
        id: openRequest.id,
        tier: openRequest.tier,
        amountSYP: openRequest.amountSYP.toString(),
        amountUSD: openRequest.amountUSD.toString(),
        referenceCode: openRequest.referenceCode,
        status: openRequest.status,
        createdAt: openRequest.createdAt.toISOString(),
        // Subscription.expiresAt stays null for offers; validity is derived
        // from createdAt + the offer window (same as POST /subscriptions).
        expiresOfferAt: new Date(
          openRequest.createdAt.getTime() +
            SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000
        ).toISOString(),
      }
    : null;

  const recent = recentRequests.map((r) => ({
    id: r.id,
    tier: r.tier,
    amountSYP: r.amountSYP.toString(),
    status: r.status,
    rejectionReason: r.rejectionReason ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return NextResponse.json({
    status: effective.status,
    label: effective.label,
    daysLeft: effective.daysLeft,
    expiresAt: effective.expiresAt,
    graceDays: SUBSCRIPTION_GRACE_DAYS,
    renewalWarningDays: SUBSCRIPTION_RENEWAL_WARNING_DAYS,
    wallet: SHAM_CASH_WALLET,
    openRequest: openRequestView,
    recentRequests: recent,
  });
}

