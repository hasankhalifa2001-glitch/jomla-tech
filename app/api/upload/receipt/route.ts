import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  uploadFileToStorage,
  buildStorageKey,
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
} from "@/lib/storage";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
  assertAdmin,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";

// ============================================================================
// Shared PUBLIC-bucket upload endpoint — PRODUCT IMAGES ONLY (T3, from
// ImageCropModal).
//
// The path keeps its historical name (/api/upload/receipt, from T1's original
// folder structure), but since T6a this endpoint no longer handles
// subscription receipts. Receipts live in a PRIVATE bucket and have their own
// routes: /api/billing/subscriptions/[id]/receipt (POST upload, GET signed
// URL). Accepting `type=receipt` here would have let any ADMIN, including one
// whose tenant is PENDING/EXPIRED, write into the PUBLIC bucket and get back a
// public URL for what is a payment document. So any `type` other than
// "product" is rejected.
//
// LOCKOUT: product images are only useful attached to a product, and creating
// or editing a product is blocked for a PENDING/EXPIRED tenant. This endpoint
// therefore requires a currently writable tenant (fresh DB read via
// assertTenantWritable), instead of letting a locked tenant accumulate
// orphaned storage.
//
// ROLE GATE: ADMIN only. Creating a catalog product (T3) is a merchant-admin
// decision, never a cashier's day-to-day task.
// ============================================================================

function extensionForContentType(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg"; // image/jpeg
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.tenantId) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    // Role gate: ADMIN only.
    assertAdmin(session.user.role);

    const formData = await req.formData();
    const file = formData.get("file");
    const kindInput = (formData.get("type") as string | null) || "product";

    // Receipts never go through this public-bucket endpoint (see header).
    if (kindInput !== "product") {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "نوع الرفع غير مدعوم." },
        { status: 400 }
      );
    }

    // Product images only: the tenant must currently be writable
    // (fresh database read, never the JWT).
    await assertTenantWritable(session.user.tenantId);

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "لم يتم إرفاق ملف صورة صالح." },
        { status: 400 }
      );
    }

    // [SECURITY] Never trust the browser's claimed content-type alone as
    // the sole gate — it's checked here independently on the server,
    // regardless of what ImageCropModal or browser-image-compression
    // already claim to have produced client-side.
    if (!ALLOWED_IMAGE_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: "صيغة الصورة غير مدعومة. الصيغ المسموحة: JPEG، PNG، WEBP.",
        },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: "FILE_TOO_LARGE",
          message: `حجم الصورة يتجاوز الحد المسموح (${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} ميغابايت).`,
        },
        { status: 400 }
      );
    }

    const key = buildStorageKey({
      tenantId: session.user.tenantId,
      kind: "products",
      extension: extensionForContentType(file.type),
    });

    const publicUrl = await uploadFileToStorage({
      buffer,
      key,
      contentType: file.type,
    });

    return NextResponse.json({
      success: true,
      url: publicUrl,
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    console.error("Error uploading file to storage:", error);

    const message =
      error instanceof Error && error.message.startsWith("Cloud storage is not configured")
        ? error.message
        : "حدث خطأ أثناء رفع الصورة. يرجى المحاولة لاحقاً.";

    return NextResponse.json({ error: "SERVER_ERROR", message }, { status: 500 });
  }
}