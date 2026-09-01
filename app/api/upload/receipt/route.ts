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
// [FIX] LOCKOUT ENFORCEMENT MUST HAPPEN HERE, PER-TYPE, NOT ONLY IN
// MIDDLEWARE. This path is listed in the middleware's
// WRITE_ALLOWED_WHEN_LOCKED_PREFIXES allowlist — deliberately, because a
// PENDING tenant has a chicken-and-egg problem: they need to upload their
// FIRST subscription receipt (T6) precisely while still locked out. The
// middleware can only see the URL path, not the FormData body, so it has
// no way to tell a receipt upload apart from a product-image upload at
// that layer — allowing the path necessarily allows BOTH `type` values
// through middleware. Without a second, type-aware check here, a
// PENDING/EXPIRED tenant could keep uploading product images (T3) to cloud
// storage indefinitely even though POST /api/inventory/products (the only
// place those images could ever attach to a real product) is correctly
// blocked elsewhere. The practical damage is limited to orphaned storage
// cost (no Product/ProductUnit row can ever reference the image while
// locked), not a data-isolation or security breach, but the endpoint
// should not silently accept work it can never make use of. Receipts
// (`type: "receipt"`) remain allowed regardless of subscriptionStatus —
// that is the entire reason this path is in the middleware allowlist.
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

    // [FIX] Type-aware lockout check. A receipt upload (`kind === "receipts"`)
    // is exactly the escape hatch a PENDING/EXPIRED tenant needs to submit
    // their subscription payment (T6) — never blocked here regardless of
    // subscriptionStatus. A product-image upload (`kind === "products"`) is
    // blocked identically to POST /api/inventory/products itself: EXPIRED
    // and PENDING are locked out the same way (see T2's middleware note —
    // a tenant awaiting first approval has no more write access than one
    // whose subscription lapsed).
    if (
      kind === "products" &&
      (session.user.subscriptionStatus === "EXPIRED" || session.user.subscriptionStatus === "PENDING")
    ) {
      return NextResponse.json(
        {
          error: "SUBSCRIPTION_LOCKED",
          message: "اشتراكك منتهي أو معلق. لا يمكنك رفع صور منتجات جديدة.",
        },
        { status: 403 }
      );
    }

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

    const message =
      error instanceof Error && error.message.startsWith("Cloud storage is not configured")
        ? error.message
        : "حدث خطأ أثناء رفع الصورة. يرجى المحاولة لاحقاً.";

    return NextResponse.json({ error: "SERVER_ERROR", message }, { status: 500 });
  }
}