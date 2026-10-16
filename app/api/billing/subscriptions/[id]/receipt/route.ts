import { NextResponse } from "next/server";
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
  SUBSCRIPTION_RATE_LIMIT,
  subscriptionRateLimitKey,
  SUBSCRIPTION_RECEIPT_MAX_BYTES,
  SUBSCRIPTION_OFFER_VALIDITY_HOURS,
} from "@/lib/config/subscription";
import {
  uploadFileToStorage,
  removeFileFromStorage,
  createSignedUrl,
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
  return NextResponse.json(
    { error: "INVALID_FILE", message },
    { status: 400 }
  );
}

function offerExpired() {
  return NextResponse.json(
    {
      error: "OFFER_EXPIRED",
      message: "انتهت صلاحية العرض، أنشئ طلباً جديداً.",
    },
    { status: 409 }
  );
}

/**
 * Magic-byte verification. Never trusts the client-supplied mime/filename.
 * Returns the extension ("jpg" | "png" | "webp") when the buffer's magic
 * bytes match an allowed image type, otherwise null.
 */
function detectImageExtension(buffer: Buffer): "jpg" | "png" | "webp" | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  // PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  // WEBP: RIFF (52 49 46 46) .... WEBP (57 45 42 50 at offset 8)
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

function randomHex(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}


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

  if (receiptRatelimit) {
    const { success } = await receiptRatelimit.limit(
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

  // ── Parse multipart or base64 body ──
  // NOTE: the client filename/mime are deliberately NOT read — the file type
  // comes only from server-side magic-byte detection below.
  let fileBuffer: Buffer;
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData().catch(() => null);
    const file = formData?.get("file");
    if (!(file instanceof File)) {
      return invalidFile("لم يتم إرفاق ملف صورة صالح.");
    }
    const arrayBuffer = await file.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
  } else {
    // Base64 JSON body: { file: "base64..." | "data:image/jpeg;base64,..." }
    let body: { file?: string };
    try {
      body = await req.json();
    } catch {
      return invalidFile("جسم الطلب غير صالح.");
    }
    if (!body.file) {
      return invalidFile("لم يتم تزويد محتوى الملف.");
    }
    const base64 = body.file.replace(/^data:image\/[a-z]+;base64,/i, "");
    try {
      fileBuffer = Buffer.from(base64, "base64");
    } catch {
      return invalidFile("محتوى الملف غير صالح.");
    }
  }

  // ── Size re-validation (server-side backstop) ──
  if (fileBuffer.byteLength > SUBSCRIPTION_RECEIPT_MAX_BYTES) {
    return invalidFile(
      `حجم الملف يتجاوز الحد المسموح (${Math.floor(
        SUBSCRIPTION_RECEIPT_MAX_BYTES / 1024
      )} كيلوبايت).`
    );
  }

  // ── Magic-byte verification (never trust client mime/filename) ──
  const ext = detectImageExtension(fileBuffer);
  if (!ext) {
    return invalidFile(
      "صيغة الملف غير مدعومة. الصيغ المسموحة: JPEG، PNG، WEBP."
    );
  }

  const db = getTenantDb(tenantId);

  // Ownership + status lookup (never another tenant's row).
  // findFirst (not findUnique): the tenant Client Extension injects tenantId
  // into the where clause, which would break a unique lookup shape.
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

  if (!subscription) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "طلب الاشتراك غير موجود." },
      { status: 404 }
    );
  }

  // Cross-tenant guard: the subscription must belong to this tenant.
  if (subscription.tenantId !== tenantId) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "طلب الاشتراك غير موجود." },
      { status: 404 }
    );
  }

  const now = new Date();
  const validityExpiry = new Date(
    subscription.createdAt.getTime() +
      SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000
  );
  const pastValidity = now > validityExpiry;

  // An offer past its validity window WITHOUT a receipt → OFFER_EXPIRED.
  if (
    pastValidity &&
    !subscription.receiptImageURL &&
    subscription.status === "PENDING_APPROVAL"
  ) {
    return offerExpired();
  }

  // Can only upload/replace on a still-pending request.
  if (subscription.status !== "PENDING_APPROVAL") {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "لا يمكن إرفاق إيصال لطلب ليست حالته قيد الموافقة.",
      },
      { status: 409 }
    );
  }

  // ── Upload object ──
  const key = `receipts/${tenantId}/${id}-${randomHex()}.${ext}`;
  await uploadFileToStorage({
    buffer: fileBuffer,
    key,
    contentType: ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : "image/webp",
  });

  const oldKey = subscription.receiptImageURL || undefined;

  // ── Conditional update: only one PENDING_APPROVAL row for this tenant+id ──
  const updateResult = await db.subscription.updateMany({
    where: {
      id,
      tenantId,
      status: "PENDING_APPROVAL",
    },
    data: {
      receiptImageURL: key,
    },
  });

  if (updateResult.count !== 1) {
    // The request is no longer pending (e.g. approved/rejected concurrently).
    // Delete the just-uploaded object and 409.
    await removeFileFromStorage(key).catch(() => {
      /* best-effort cleanup */
    });
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "طلب الاشتراك لم يعد قابلاً للتعديل.",
      },
      { status: 409 }
    );
  }

  // ── Delete the old object AFTER the DB write succeeds (replace allowed) ──
  if (oldKey) {
    await removeFileFromStorage(oldKey).catch(() => {
      /* best-effort cleanup of orphaned old object */
    });
  }

  return NextResponse.json({
    success: true,
    message: "تم رفع الإيصال. الطلب قيد المراجعة.",
  });
}

export async function GET(
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

  // Ownership lookup: only this tenant's subscription, never another tenant's.
  // findFirst (not findUnique): the tenant Client Extension injects tenantId.
  const subscription = await db.subscription.findFirst({
    where: { id },
    select: {
      id: true,
      tenantId: true,
      receiptImageURL: true,
      status: true,
    },
  });

  if (!subscription) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "طلب الاشتراك غير موجود." },
      { status: 404 }
    );
  }

  if (subscription.tenantId !== tenantId) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "طلب الاشتراك غير موجود." },
      { status: 404 }
    );
  }

  if (!subscription.receiptImageURL) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "لا يوجد إيصال مرفق بهذا الطلب." },
      { status: 404 }
    );
  }

  // Signed URL valid for at most 5 minutes (300 seconds).
  const url = await createSignedUrl({
    key: subscription.receiptImageURL,
    seconds: 300,
  });

  return NextResponse.json({ url });
}

