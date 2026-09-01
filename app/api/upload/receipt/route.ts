import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  uploadFileToStorage,
  buildStorageKey,
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
} from "@/lib/storage";

// ============================================================================
// Shared upload endpoint — despite the file's path (kept from T1's original
// folder structure entry), this handler serves TWO call sites:
//   - T3: product/unit images from ImageCropModal (`type: "product"`)
//   - T6: subscription payment receipts (`type: "receipt"`)
// See lib/storage.ts's header comment for why one endpoint/client covers
// both, and T1's folder structure, which already describes this path as a
// general "Cloud storage upload handler for compressed receipt/product
// images" rather than a receipt-only route.
//
// ROLE GATE: ADMIN only. Both real call sites are ADMIN-only actions —
// creating a catalog product (T3 Scope, products/route.ts POST) and
// submitting a subscription payment (T6) are both merchant-admin
// decisions, never a cashier's day-to-day task.
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

    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "رفع الصور والإيصالات متاح لمدير المتجر فقط." },
        { status: 403 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const kindInput = (formData.get("type") as string | null) || "product";
    const kind: "products" | "receipts" = kindInput === "receipt" ? "receipts" : "products";

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
      kind,
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
    console.error("Error uploading file to storage:", error);

    // A missing/misconfigured env var (see lib/storage.ts's
    // assertStorageEnv) surfaces here as a thrown Error with a specific
    // message — worth distinguishing from a generic failure so a
    // misconfigured .env doesn't get mistaken for a transient server error
    // during testing.
    const message =
      error instanceof Error && error.message.startsWith("Cloud storage is not configured")
        ? error.message
        : "حدث خطأ أثناء رفع الصورة. يرجى المحاولة لاحقاً.";

    return NextResponse.json({ error: "SERVER_ERROR", message }, { status: 500 });
  }
}