/* eslint-disable @typescript-eslint/no-explicit-any */
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
    this.name = "OPEN_REQUEST_EXISTS";
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
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    throw error;
  }

  // Fresh isActive check (never trust the JWT).
  try {
    await assertUserActive(tenantId, userId);
  } catch (error) {
    if (error instanceof UserInactiveError) {
      return userInactiveResponse(error);
    }
    throw error;
  }

  // Per-tenant rate limit.
  if (subscribeRatelimit) {
    const { success } = await subscribeRatelimit.limit(
      subscriptionRateLimitKey(tenantId)
    );
    if (!success) {
      return NextResponse.json(
        {
          error: "RATE_LIMITED",
          message: "تم تجاوز عدد الطلبات المسموح. حاول لاحقاً.",
        },
        { status: 429 }
      );
    }
  }

  // ── zod validation ──
  // Non-strict on purpose: extra client keys (price/amount) are stripped and
  // ignored — the SYP amount is always computed server-side from the tier +
  // fresh platform rate, never taken from the client.
  let body: { tier: string };
  try {
    body = createSchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "طلب غير صالح." },
      { status: 400 }
    );
  }

  const tierConfig = SUBSCRIPTION_TIERS[body.tier];
  if (!tierConfig) {
    return NextResponse.json(
      { error: "INVALID_TIER", message: "الباقة المختارة غير صالحة." },
      { status: 400 }
    );
  }

  // ── Read the platform rate fresh (D3). Never trust a client-supplied rate/price. ──
  const dbForRate = getTenantDb(tenantId);
  const tenantRateRow = await dbForRate.tenant.findUnique({
    where: { id: tenantId },
    select: { dailyExchangeRate: true },
  });
  const rateStr =
    tenantRateRow?.dailyExchangeRate != null
      ? tenantRateRow.dailyExchangeRate.toString()
      : null;

  if (!rateStr) {
    return NextResponse.json(
      { error: "RATE_UNAVAILABLE", message: "سعر الصرف غير محدد حالياً." },
      { status: 422 }
    );
  }

  let rate: ReturnType<typeof toDecimal>;
  try {
    rate = toDecimal(rateStr);
  } catch {
    return NextResponse.json(
      { error: "RATE_UNAVAILABLE", message: "سعر الصرف غير محدد حالياً." },
      { status: 422 }
    );
  }
  if (rate.isZero() || rate.isNegative()) {
    return NextResponse.json(
      { error: "RATE_UNAVAILABLE", message: "سعر الصرف غير محدد حالياً." },
      { status: 422 }
    );
  }

  const amountSYP = roundToWholeLira(
    multiplyMoney(tierConfig.priceUSD, rate.toString())
  );
  const amountUSD = tierConfig.priceUSD;

  const now = new Date();
  const validityMs = SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000;
  const validityCutoff = new Date(now.getTime() - validityMs);

  const db = getTenantDb(tenantId);

  try {
    const result = await db.$transaction(async (tx) => {
      // 1. System-reject this tenant's stale offers (PENDING_APPROVAL, no
      // receipt, older than the validity window).
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

      // 2. Count remaining PENDING_APPROVAL requests of this tenant.
      const pendingCount = await tx.subscription.count({
        where: { tenantId, status: "PENDING_APPROVAL" },
      });
      if (pendingCount > 0) {
        throw new OpenRequestExistsError();
      }

      // 3. One top-level subscription.create with a unique reference code.
      let created: any;
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const referenceCode = generateReferenceCode();
        try {
          created = await tx.subscription.create({
            data: {
              tenantId,
              tier: body.tier,
              durationDays: tierConfig.durationDays,
              amountUSD: amountUSD,
              amountSYP: amountSYP,
              exchangeRateUsed: rate.toString(),
              referenceCode,
              status: "PENDING_APPROVAL",
              expiresAt: null,
            },
          });
          return { created, referenceCode };
        } catch (error) {
          lastError = error;
          if (!isReferenceCodeCollision(error)) throw error;
          // referenceCode collision → regenerate and retry.
          if (attempt === MAX_RETRIES - 1) throw error;
        }
      }
      throw lastError;
    });

    const expiresOfferAt = new Date(
      result.created.createdAt.getTime() + validityMs
    );

    return NextResponse.json({
      id: result.created.id,
      referenceCode: result.referenceCode,
      amountSYP,
      amountUSD,
      tier: body.tier,
      expiresOfferAt,
      wallet: SHAM_CASH_WALLET,
    });
  } catch (error) {
    if (error instanceof OpenRequestExistsError) {
      return NextResponse.json(
        {
          error: "OPEN_REQUEST_EXISTS",
          message: "لديك طلب اشتراك قيد الدراسة بالفعل.",
        },
        { status: 409 }
      );
    }
    console.error("[billing/subscriptions] create failed:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء إنشاء طلب الاشتراك." },
      { status: 500 }
    );
  }
}

