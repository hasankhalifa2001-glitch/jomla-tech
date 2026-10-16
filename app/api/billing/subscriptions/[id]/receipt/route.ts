import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
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
  SUBSCRIPTION_RATE_LIMIT,
  subscriptionRateLimitKey,
  SUBSCRIPTION_RECEIPT_MAX_BYTES,
  SUBSCRIPTION_OFFER_VALIDITY_HOURS,
} from "@/lib/config/subscription";
import {
  uploadPrivateReceipt,
  removePrivateReceipt,
  createReceiptSignedUrl,
} from "@/lib/storage";

const upstashConfigured = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

const receiptRatelimit = upstashConfigured
  ? new Ratelimit({
    redis: new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL as string,
      token: process.env.UPSTASH_REDIS_REST_TOKEN as string,
    }),
    limiter: Ratelimit.slidingWindow(
      SUBSCRIPTION_RATE_LIMIT.requests,
      `${SUBSCRIPTION_RATE_LIMIT.windowMinutes} m`
    ),
    prefix: "ratelimit:billing:receipt",
  })
  : null;

function invalidFile(message: string) {
  return NextResponse.json({ error: "INVALID_FILE", message }, { status: 400 });
}

function serverError(message: string) {
  return NextResponse.json({ error: "SERVER_ERROR", message }, { status: 500 });
}

function notFound(message = "طلب الاشتراك غير موجود.") {
  return NextResponse.json({ error: "NOT_FOUND", message }, { status: 404 });
}

/**
 * Magic-byte verification. Never trusts the client mime/filename.
 * Returns the extension when the bytes match an allowed image type.
 */
function detectImageExtension(buffer: Buffer): "jpg" | "png" | "webp" | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

const CONTENT_TYPE_BY_EXT = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.tenantId || !session.user.id) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
      { status: 401 }
    );
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  // T6a lockout exemption: PENDING/EXPIRED ADMINs must be able to upload and
  // view receipts — the checkout's whole purpose. Deliberately no
  // assertTenantWritable() here. Fails closed if the named list drifts.
  if (!isLockoutExemptPath(`/api/billing/subscriptions/${id}/receipt`)) {
    console.error("[billing/receipt] missing lockout exemption; failing closed.");
    return serverError("حدث خطأ، حاول لاحقاً.");
  }
  void SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES;

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

  if (receiptRatelimit) {
    const { success, reset } = await receiptRatelimit.limit(
      subscriptionRateLimitKey(tenantId)
    );
    if (!success) {
      const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "تم تجاوز عدد الطلبات المسموح. حاول لاحقاً." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
  } else if (process.env.NODE_ENV === "production") {
    console.error("[billing/receipt] Upstash is not configured in production.");
    return serverError("حدث خطأ، حاول لاحقاً.");
  }

  // Cheap guard BEFORE the body is read into memory. base64 inflates by ~1.37x
  // and multipart adds boundaries, hence the allowance. The exact size is
  // re-checked below on the real bytes.
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  const maxBody = Math.ceil(SUBSCRIPTION_RECEIPT_MAX_BYTES * 1.4) + 16 * 1024;
  if (Number.isFinite(declaredLength) && declaredLength > maxBody) {
    return invalidFile("حجم الملف يتجاوز الحد المسموح.");
  }

  // The client filename/mime are deliberately NOT read.
  let fileBuffer: Buffer;
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData().catch(() => null);
    const file = formData?.get("file");
    if (!(file instanceof File)) {
      return invalidFile("لم يتم إرفاق ملف صورة صالح.");
    }
    fileBuffer = Buffer.from(await file.arrayBuffer());
  } else {
    let body: { file?: string };
    try {
      body = await req.json();
    } catch {
      return invalidFile("جسم الطلب غير صالح.");
    }
    if (!body.file || typeof body.file !== "string") {
      return invalidFile("لم يتم تزويد محتوى الملف.");
    }
    const base64 = body.file.replace(/^data:image\/[a-z]+;base64,/i, "");
    fileBuffer = Buffer.from(base64, "base64");
  }

  if (fileBuffer.byteLength > SUBSCRIPTION_RECEIPT_MAX_BYTES) {
    return invalidFile(
      `حجم الملف يتجاوز الحد المسموح (${Math.floor(
        SUBSCRIPTION_RECEIPT_MAX_BYTES / 1024
      )} كيلوبايت).`
    );
  }

  const ext = detectImageExtension(fileBuffer);
  if (!ext) {
    return invalidFile("صيغة الملف غير مدعومة. الصيغ المسموحة: JPEG، PNG، WEBP.");
  }

  const db = getTenantDb(tenantId);

  // findFirst: the tenant extension injects tenantId into the where clause.
  const subscription = await db.subscription.findFirst({
    where: { id },
    select: {
      id: true,
      tenantId: true,
      status: true,
      receiptImageURL: true,
      createdAt: true,
    },
  });

  // Defense in depth on top of the extension.
  if (!subscription || subscription.tenantId !== tenantId) return notFound();

  if (subscription.status !== "PENDING_APPROVAL") {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "لا يمكن إرفاق إيصال لطلب ليست حالته قيد الموافقة.",
      },
      { status: 409 }
    );
  }

  const validityExpiry = new Date(
    subscription.createdAt.getTime() +
    SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000
  );
  if (new Date() > validityExpiry && !subscription.receiptImageURL) {
    return NextResponse.json(
      { error: "OFFER_EXPIRED", message: "انتهت صلاحية العرض، أنشئ طلباً جديداً." },
      { status: 409 }
    );
  }

  const key = `receipts/${tenantId}/${id}-${randomBytes(16).toString("hex")}.${ext}`;
  const oldKey = subscription.receiptImageURL ?? null;

  try {
    await uploadPrivateReceipt({
      buffer: fileBuffer,
      key,
      contentType: CONTENT_TYPE_BY_EXT[ext],
    });
  } catch (error) {
    console.error("[billing/receipt] upload failed:", error);
    return serverError("تعذّر رفع الإيصال، حاول مجدداً.");
  }

  let updated: { count: number };
  try {
    // Pinned to the receipt value we read: a concurrent replace makes this
    // count 0 for the loser instead of silently orphaning an object.
    updated = await db.subscription.updateMany({
      where: {
        id,
        tenantId,
        status: "PENDING_APPROVAL",
        receiptImageURL: oldKey,
      },
      data: { receiptImageURL: key },
    });
  } catch (error) {
    console.error("[billing/receipt] db update failed:", error);
    await removePrivateReceipt(key);
    return serverError("تعذّر حفظ الإيصال، حاول مجدداً.");
  }

  if (updated.count !== 1) {
    await removePrivateReceipt(key);
    return NextResponse.json(
      { error: "INVALID_REQUEST", message: "طلب الاشتراك لم يعد قابلاً للتعديل." },
      { status: 409 }
    );
  }

  // Delete the replaced object only AFTER the DB write succeeded.
  if (oldKey) await removePrivateReceipt(oldKey);

  return NextResponse.json({
    success: true,
    message: "تم رفع الإيصال. الطلب قيد المراجعة.",
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.tenantId || !session.user.id) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
      { status: 401 }
    );
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  // T6a lockout exemption (same named list as POST above).
  if (!isLockoutExemptPath(`/api/billing/subscriptions/${id}/receipt`)) {
    console.error("[billing/receipt] missing lockout exemption; failing closed.");
    return serverError("تعذّر تحميل الإيصال.");
  }
  void SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES;

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

  const subscription = await db.subscription.findFirst({
    where: { id },
    select: { id: true, tenantId: true, receiptImageURL: true },
  });

  if (!subscription || subscription.tenantId !== tenantId) return notFound();

  if (!subscription.receiptImageURL) {
    return notFound("لا يوجد إيصال مرفق بهذا الطلب.");
  }

  // The key must live under this tenant's prefix before anything is signed.
  if (!subscription.receiptImageURL.startsWith(`receipts/${tenantId}/`)) {
    console.error("[billing/receipt] key outside tenant prefix:", id);
    return notFound("لا يوجد إيصال مرفق بهذا الطلب.");
  }

  try {
    const url = await createReceiptSignedUrl(subscription.receiptImageURL);
    return NextResponse.json({ url });
  } catch (error) {
    console.error("[billing/receipt] signed url failed:", error);
    return serverError("تعذّر تحميل الإيصال.");
  }
}