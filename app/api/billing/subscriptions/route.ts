import { NextResponse } from "next/server";
import { z } from "zod";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
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
  isLockoutExemptPath,
  SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES,
} from "@/lib/auth/tenant";
import {
  SUBSCRIPTION_TIERS,
  SUBSCRIPTION_RATE_LIMIT,
  SUBSCRIPTION_OFFER_VALIDITY_HOURS,
  SHAM_CASH_WALLET,
  subscriptionRateLimitKey,
} from "@/lib/config/subscription";
import {
  toDecimal,
  multiplyMoney,
  roundToWholeLira,
} from "@/lib/utils/money";
import {
  generateReferenceCode,
  isReferenceCodeCollision,
  MAX_RETRIES,
} from "@/lib/utils/subscription-reference";
import { getPlatformExchangeRate } from "@/lib/data/platform-rate";

// Non-strict on purpose: extra client keys (price/amount) are stripped and
// ignored. The SYP amount is always computed server-side.
const createSchema = z.object({
  tier: z.string().trim().min(1),
});

const upstashConfigured = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

const subscribeRatelimit = upstashConfigured
  ? new Ratelimit({
    redis: new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL as string,
      token: process.env.UPSTASH_REDIS_REST_TOKEN as string,
    }),
    limiter: Ratelimit.slidingWindow(
      SUBSCRIPTION_RATE_LIMIT.requests,
      `${SUBSCRIPTION_RATE_LIMIT.windowMinutes} m`
    ),
    prefix: "ratelimit:billing:subscribe",
  })
  : null;

class OpenRequestExistsError extends Error {
  constructor() {
    super("OPEN_REQUEST_EXISTS");
    this.name = "OpenRequestExistsError";
  }
}

function rateUnavailable() {
  return NextResponse.json(
    { error: "RATE_UNAVAILABLE", message: "سعر الصرف غير محدد حالياً." },
    { status: 422 }
  );
}

function serverError() {
  return NextResponse.json(
    { error: "SERVER_ERROR", message: "حدث خطأ أثناء إنشاء طلب الاشتراك." },
    { status: 500 }
  );
}

/** Platform rate (never the merchant's own rate). null when unusable. */
async function resolvePlatformRate(tenantId: string): Promise<string | null> {
  const raw = await getPlatformExchangeRate(tenantId);
  if (!raw) return null;
  try {
    const dec = toDecimal(raw);
    if (dec.isZero() || dec.isNegative()) return null;
    return dec.toString();
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.tenantId || !session.user.id) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
      { status: 401 }
    );
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  // ADMIN only.
  try {
    assertAdmin(session.user.role);
  } catch (error) {
    if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
    throw error;
  }

  // Fresh isActive check (never trust the JWT).
  try {
    await assertUserActive(tenantId, userId);
  } catch (error) {
    if (error instanceof UserInactiveError) return userInactiveResponse(error);
    throw error;
  }

  // T6a lockout exemption (lib/auth/tenant.ts): this route is listed in
  // SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES, so a PENDING/EXPIRED tenant's
  // ADMIN can reach it — that is the whole purpose of the checkout. It
  // deliberately does NOT call assertTenantWritable(). The invariant below
  // keeps the exemption explicit and auditable: if this path ever drops off
  // the named list, the route fails closed instead of silently drifting.
  if (!isLockoutExemptPath("/api/billing/subscriptions")) {
    console.error("[billing/subscriptions] missing lockout exemption; failing closed.");
    return serverError();
  }
  void SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES;

  // Per-tenant rate limit. Skipped only outside production; in production a
  // missing limiter fails closed instead of silently disabling the control.
  if (subscribeRatelimit) {
    let success = false;
    let reset = 0;
    try {
      ({ success, reset } = await subscribeRatelimit.limit(subscriptionRateLimitKey(tenantId)));
    } catch (error) {
      console.error("[billing/subscriptions] rate limiter unavailable:", error);
      return NextResponse.json(
        {
          error: "RATE_LIMIT_UNAVAILABLE",
          message: "خدمة تحديد المعدل غير متاحة حالياً، رجاءً جرب لاحقاً.",
        },
        { status: 503 }
      );
    }
    if (!success) {
      const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "تم تجاوز عدد الطلبات المسموح. حاول لاحقاً." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
  } else if (process.env.NODE_ENV === "production") {
    console.error("[billing/subscriptions] Upstash is not configured in production.");
    return serverError();
  }

  let body: { tier: string };
  try {
    body = createSchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "طلب غير صالح." },
      { status: 400 }
    );
  }

  // Own-property check: names like "constructor" must not resolve to
  // Object.prototype members.
  const tierConfig = Object.prototype.hasOwnProperty.call(
    SUBSCRIPTION_TIERS,
    body.tier
  )
    ? SUBSCRIPTION_TIERS[body.tier]
    : undefined;
  if (!tierConfig) {
    return NextResponse.json(
      { error: "INVALID_TIER", message: "الباقة المختارة غير صالحة." },
      { status: 400 }
    );
  }

  // Platform rate, read fresh (D3). Never a client value, never the
  // merchant's own dailyExchangeRate.
  const rate = await resolvePlatformRate(tenantId);
  if (!rate) return rateUnavailable();

  // Multiply, then round ONCE to a whole lira.
  const amountSYP = roundToWholeLira(multiplyMoney(tierConfig.priceUSD, rate));
  const amountUSD = tierConfig.priceUSD;

  const now = new Date();
  const validityMs = SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000;
  const validityCutoff = new Date(now.getTime() - validityMs);

  const db = getTenantDb(tenantId);

  // The retry loop wraps the WHOLE transaction. In Postgres a unique
  // violation aborts the surrounding transaction, so retrying inside it
  // would fail with "current transaction is aborted".
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const referenceCode = generateReferenceCode();
    try {
      const created = await db.$transaction(async (tx) => {
        // 1. System-reject this tenant's stale offers (no receipt, past validity).
        await tx.subscription.updateMany({
          where: {
            tenantId,
            status: "PENDING_APPROVAL",
            receiptImageURL: null,
            createdAt: { lt: validityCutoff },
          },
          data: {
            status: "REJECTED",
            rejectionReason: "انتهت صلاحية العرض",
            reviewedByUserId: null,
            reviewedAt: now,
          },
        });

        // 2. One open request per tenant (D12).
        const pendingCount = await tx.subscription.count({
          where: { tenantId, status: "PENDING_APPROVAL" },
        });
        if (pendingCount > 0) throw new OpenRequestExistsError();

        // 3. One top-level create.
        return tx.subscription.create({
          data: {
            tenantId,
            tier: body.tier,
            durationDays: tierConfig.durationDays,
            amountUSD,
            amountSYP,
            exchangeRateUsed: rate,
            referenceCode,
            status: "PENDING_APPROVAL",
            expiresAt: null,
          },
        });
      });

      return NextResponse.json({
        id: created.id,
        referenceCode,
        amountSYP,
        amountUSD,
        tier: body.tier,
        expiresOfferAt: new Date(created.createdAt.getTime() + validityMs),
        wallet: SHAM_CASH_WALLET,
      });
    } catch (error) {
      if (error instanceof OpenRequestExistsError) {
        return NextResponse.json(
          { error: "OPEN_REQUEST_EXISTS", message: "لديك طلب اشتراك قيد الدراسة بالفعل." },
          { status: 409 }
        );
      }
      if (isReferenceCodeCollision(error) && attempt < MAX_RETRIES - 1) {
        continue; // new code, new transaction
      }
      console.error("[billing/subscriptions] create failed:", error);
      return serverError();
    }
  }

  return serverError();
}