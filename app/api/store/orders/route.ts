import { NextResponse } from "next/server";
import { z } from "zod";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
    assertStorefrontOpen,
    isVerifiedRetailerPhone,
    countPendingStorefrontOrders,
    findDuplicateStorefrontOrder,
    findMatchedCustomerId,
    createStorefrontOrder,
    PendingLimitError,
    InvalidOrderLineError,
    type StorefrontOrderInput,
} from "@/lib/data/store";
import { listStorefrontOrderLineUnits } from "@/lib/data/products";
import { getClientIp } from "@/lib/utils/client-ip";
import { normalizePhone } from "@/lib/utils/phone";
import { randomReference } from "@/lib/utils/order-reference";
import {
    STORE_IP_RATE_LIMIT,
    STORE_MAX_PENDING_PER_UNVERIFIED_PHONE,
    STORE_MAX_LINES_PER_ORDER,
    STORE_MAX_QTY_PER_LINE,
    STORE_ERROR,
} from "@/lib/config/storefront";
import { compareMoney, serializeMoney } from "@/lib/utils/money";

/**
 * app/api/store/orders/route.ts — POST
 *
 * T5a — the public, no-login B2B order-submission endpoint (§6.8). Creates a
 * PENDING_REVIEW B2BOrderRequest + its items and NOTHING else: no Invoice, no
 * InvoiceItem, no CustomerPayment, no ProductBatch, no VerifiedRetailer write.
 * Nothing financial or physical changes at submission. `approvedQuantity`
 * stays null (only T5c writes it).
 *
 * THE ORDER OF OPERATIONS IS MANDATORY AND FIXED (§6.8):
 *   1. IP rate limit            → 429 RATE_LIMITED   (+ Retry-After)
 *   2. Honeypot                 → the NORMAL success shape, writes nothing
 *   3. zod validation (strict)  → 400 VALIDATION_ERROR
 *   4. Tenant gate              → 403 STORE_UNAVAILABLE
 *   5. Duplicate-submit guard   → the normal shape, that order's ref, no write
 *   6. Per-phone pending cap    → 429 PENDING_LIMIT
 *   7. Server-side line re-read → 400 INVALID_LINE
 *   8. ONE $transaction         → the single write
 *   9. { success: true, orderRef } — nothing else
 *
 * STEPS 5–7 ARE GUARDS, NOT THE WRITE: each one returns (or throws, which the
 * catch below maps to a response) BEFORE the transaction is opened, so a
 * rejected submission writes nothing at all.
 *
 * ── TRUST BOUNDARY ──────────────────────────────────────────────────────────
 * NOTHING from the client is trusted except the identifiers and the requested
 * quantities. Price and currency snapshots are ALWAYS re-read from the DB
 * (step 7); a client-supplied price is ignored entirely — the request schema
 * does not even have a price field.
 *
 * ── PRIVACY (D4) ────────────────────────────────────────────────────────────
 * No endpoint in this route looks anything up BY phone number for the caller,
 * and the response never contains a phone. The phone is used only as (a) the
 * stored retailerPhone, (b) the per-phone cap key, and (c) the customer hint.
 * None of the three is ever returned.
 *
 * ── IP HEADER ───────────────────────────────────────────────────────────────
 * getClientIp() is the single trusted-IP source (x-real-ip →
 * x-vercel-forwarded-for → right-most x-forwarded-for → "unknown"). The
 * left-most XFF hop is client-supplied and deliberately never used.
 */

// ---------------------------------------------------------------------------
// Rate limiter — STORE_IP_RATE_LIMIT (10 requests / 10 minutes per IP).
//
// Kept in a SEPARATE Redis key namespace from the public read limit
// ("ratelimit:store-read", app/api/store/products) so the two limits are fully
// independent: burning the submission limit never disables catalog reads, and
// vice versa.
// ---------------------------------------------------------------------------

const upstashConfigured = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

if (!upstashConfigured && process.env.NODE_ENV === "production") {
    console.warn(
        "[store/orders] Upstash is not configured: the per-IP submission limit is DISABLED."
    );
}

const orderRatelimit = upstashConfigured
    ? new Ratelimit({
          redis: new Redis({
              url: process.env.UPSTASH_REDIS_REST_URL!,
              token: process.env.UPSTASH_REDIS_REST_TOKEN!,
          }),
          limiter: Ratelimit.slidingWindow(
              STORE_IP_RATE_LIMIT.requests,
              `${STORE_IP_RATE_LIMIT.windowMinutes} m`
          ),
          prefix: "ratelimit:store-order",
      })
    : null;

// ---------------------------------------------------------------------------
// Body-size bound. Read as TEXT first so an oversized payload is rejected
// before it is ever parsed — `req.json()` would happily parse a 50 MB body.
// 50 lines × (a 25-char id + a 25-char id + a short quantity) plus the header
// fields is a few KB, so 32 KB is generous and still a hard ceiling.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 32 * 1024;

/**
 * A quantity in the sale unit: a plain decimal, > 0, at most 4 decimal places
 * (matching B2BOrderRequestItem.quantity's DECIMAL(18,4)) and at most
 * STORE_MAX_QTY_PER_LINE (D6). Compared through money.ts / decimal.js — never
 * a native JS number.
 */
const QUANTITY_REGEX = /^\d+(\.\d{1,4})?$/;

const orderLineSchema = z.object({
    productId: z.string().trim().min(1).max(64),
    unitId: z.string().trim().min(1).max(64),
    quantity: z
        .string()
        .trim()
        .regex(QUANTITY_REGEX, "الكمية يجب أن تكون رقماً بصيغة صحيحة (حتى 4 خانات عشرية).")
        .refine((v) => compareMoney(v, 0) > 0, {
            message: "الكمية يجب أن تكون أكبر من صفر.",
        })
        .refine((v) => compareMoney(v, STORE_MAX_QTY_PER_LINE) <= 0, {
            message: `الكمية القصوى للسطر الواحد هي ${STORE_MAX_QTY_PER_LINE}.`,
        }),
});

const orderSchema = z
    .object({
        tenantSlug: z.string().trim().min(1).max(64),
        retailerName: z
            .string()
            .trim()
            .min(2, "الاسم مطلوب (حرفان على الأقل).")
            .max(80),
        // Stored raw here; normalizePhone() runs below so an invalid number is
        // a clean 400 rather than a silently-wrong stored value.
        retailerPhone: z.string().trim().min(1).max(40),
        // D3: shop name is OPTIONAL.
        retailerShopName: z.string().trim().max(120).optional().nullable(),
        items: z
            .array(orderLineSchema)
            .min(1, "أضف منتجاً واحداً على الأقل إلى الطلب.")
            .max(
                STORE_MAX_LINES_PER_ORDER,
                `الحد الأقصى ${STORE_MAX_LINES_PER_ORDER} سطر في الطلب الواحد.`
            ),
        // Honeypot: a hidden field no human fills. Checked BEFORE validation so
        // a bot that fills every field still gets the normal success shape.
        website: z.string().optional().nullable(),
    })
    .strict();

/** The normal success shape — used by the real path AND the honeypot path. */
function successResponse(orderRef: string) {
    return NextResponse.json({ success: true, orderRef });
}

function errorResponse(
    code: string,
    message: string,
    status: number,
    headers?: Record<string, string>
) {
    return NextResponse.json({ code, message }, { status, headers });
}

export async function POST(request: Request) {
    try {
        // ── 1. Per-IP rate limit (STORE_IP_RATE_LIMIT: 10 / 10 minutes) ─────
        // Keyed on the trusted client IP. 429 carries Retry-After so a client
        // can back off correctly instead of hammering.
        if (orderRatelimit) {
            const ip = getClientIp(request);
            const { success, reset } = await orderRatelimit.limit(ip);
            if (!success) {
                const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
                return errorResponse(
                    STORE_ERROR.RATE_LIMITED,
                    "طلبات كثيرة من هذا الجهاز. انتظر قليلاً ثم أعد المحاولة.",
                    429,
                    { "Retry-After": String(retryAfter) }
                );
            }
        }

        // ── Body-size bound, then parse ─────────────────────────────────────
        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
            return errorResponse(
                STORE_ERROR.VALIDATION_ERROR,
                "حجم الطلب كبير جداً.",
                413
            );
        }

        let parsedBody: unknown;
        try {
            parsedBody = JSON.parse(raw);
        } catch {
            return errorResponse(
                STORE_ERROR.VALIDATION_ERROR,
                "صيغة الطلب غير صالحة.",
                400
            );
        }

        // ── 2. Honeypot (§6.8 step 2) ───────────────────────────────────────
        // Returns the NORMAL success shape with an indistinguishable random
        // reference (randomReference uses the same base36 alphabet a real
        // reference can contain) and writes NOTHING. A bot cannot tell this
        // apart from a real acceptance, so it gets no signal to adapt to.
        // Checked BEFORE validation so a bot that fills every field is caught.
        const honeypot =
            parsedBody && typeof parsedBody === "object"
                ? (parsedBody as { website?: unknown }).website
                : undefined;
        if (typeof honeypot === "string" && honeypot.trim() !== "") {
            return successResponse(randomReference());
        }

        // ── 3. zod validation (strict: unknown keys are rejected) ───────────
        const validation = orderSchema.safeParse(parsedBody);
        if (!validation.success) {
            return errorResponse(
                STORE_ERROR.VALIDATION_ERROR,
                validation.error.issues[0]?.message || "بيانات الطلب غير صالحة.",
                400
            );
        }

        const body = validation.data;

        // D3: name + phone required (enforced above), shop name optional.
        // D17: mobile-only Syrian number. An invalid number is a clean 400
        // rather than a silently-wrong stored value.
        const normalizedPhone = normalizePhone(body.retailerPhone);
        if (!normalizedPhone) {
            return errorResponse(
                STORE_ERROR.VALIDATION_ERROR,
                "رقم الهاتف غير صالح — أدخل رقم موبايل سوري (مثال: 0944123456).",
                400
            );
        }

        // One line per (product, unit) pair (§6.7).
        const seenPairs = new Set<string>();
        for (const item of body.items) {
            const pairKey = `${item.productId}|${item.unitId}`;
            if (seenPairs.has(pairKey)) {
                return errorResponse(
                    STORE_ERROR.VALIDATION_ERROR,
                    "لا يمكن تكرار نفس المنتج والوحدة في سطرين.",
                    400
                );
            }
            seenPairs.add(pairKey);
        }

        const retailerShopName = body.retailerShopName?.trim() || null;

        // ── 4. Tenant gate — FRESH DB read, never cached (§6.1/§6.8) ────────
        // Runs BEFORE any write. An unknown slug and a closed (EXPIRED/PENDING)
        // store both resolve to null here; both return the same 403 so the
        // endpoint never confirms which slugs exist.
        const tenant = await assertStorefrontOpen(body.tenantSlug);
        if (!tenant) {
            return errorResponse(
                STORE_ERROR.STORE_UNAVAILABLE,
                "هذا المتجر غير متاح حالياً.",
                403
            );
        }

        const tenantId = tenant.id;
        const db = getTenantDb(tenantId);

        const orderInput: StorefrontOrderInput = {
            retailerName: body.retailerName,
            retailerPhone: normalizedPhone,
            retailerShopName,
            lines: body.items.map((item) => ({
                productId: item.productId,
                unitId: item.unitId,
                quantity: item.quantity,
            })),
        };

        // ── 5. Duplicate-submit guard (§6.8 step 5) ─────────────────────────
        // Identical lines from the same phone inside the window → return that
        // order's reference and write NOTHING. This is what makes a
        // double-click idempotent.
        const duplicate = await findDuplicateStorefrontOrder(
            db,
            tenantId,
            orderInput
        );
        if (duplicate) {
            return successResponse(duplicate.orderRef);
        }



        // ── 6. Per-phone pending cap (D5) ───────────────────────────────────
        // Verified phones are EXEMPT — a deterrent-level convenience, NOT proof
        // of identity. The per-IP limit (step 1) still applies to EVERY
        // submission regardless of this exemption. A small overshoot under a
        // concurrent double-submit is accepted (§6.8). Independent of the IP
        // limit: the two are keyed differently and neither disables the other.
        const isVerified = await isVerifiedRetailerPhone(db, normalizedPhone);
        if (!isVerified) {
            const pendingCount = await countPendingStorefrontOrders(
                db,
                tenantId,
                normalizedPhone
            );
            if (pendingCount >= STORE_MAX_PENDING_PER_UNVERIFIED_PHONE) {
                throw new PendingLimitError(STORE_MAX_PENDING_PER_UNVERIFIED_PHONE);
            }
        }

        // ── 7. Server-side re-read of every line (§6.8 step 7) ──────────────
        // NEVER trust a client price or currency — snapshots come from the DB.
        // Two indexed reads for the whole order (never per-line): the units,
        // then the owning products' public/active flags, joined in the gateway.
        const lineRows = await listStorefrontOrderLineUnits(
            db,
            tenantId,
            body.items.map((item) => ({
                productId: item.productId,
                unitId: item.unitId,
            }))
        );

        const snapshots: Array<{
            priceWholesale: string;
            pricingCurrency: "SYP" | "USD";
        }> = [];

        for (let i = 0; i < body.items.length; i++) {
            const row = lineRows[i];
            const lineNumber = i + 1;

            if (!row || !row.productPublic || !row.productActive) {
                throw new InvalidOrderLineError(
                    lineNumber,
                    "أحد المنتجات في الطلب لم يعد متاحاً في المتجر."
                );
            }
            if (!row.unitActive) {
                throw new InvalidOrderLineError(
                    lineNumber,
                    "إحدى وحدات القياس في الطلب لم تعد متاحة."
                );
            }
            if (!row.unitBelongsToProduct) {
                throw new InvalidOrderLineError(
                    lineNumber,
                    "إحدى وحدات القياس في الطلب لا تنتمي إلى منتجها."
                );
            }

            snapshots.push({
                priceWholesale: serializeMoney(row.priceWholesale),
                pricingCurrency: row.pricingCurrency,
            });
        }

        // ── 8. ONE $transaction — the single write of T5a (§6.8 step 8) ─────
        // Every write inside is its own top-level tx.model.create() (no nested
        // writes), so the tenant-scope extension injects tenantId into each.
        // Exactly one B2BOrderRequest + one B2BOrderRequestItem per line.
        // Nothing financial or physical is touched.
        const created = await db.$transaction(async (tx) => {
            // The customer hint is resolved INSIDE the transaction so it reads
            // the same snapshot the order is written against.
            const matchedCustomerId = await findMatchedCustomerId(
                tx,
                tenantId,
                normalizedPhone
            );
            return createStorefrontOrder(
                tx,
                tenantId,
                orderInput,
                snapshots,
                matchedCustomerId
            );
        });

        // ── 9. Response — { success, orderRef } and NOTHING else ────────────
        // `matchedCustomerId` is deliberately NOT returned: it is a
        // pre-approval hint for the reviewing admin, never exposed to anyone
        // on the public path.
        return successResponse(created.orderRef);
    } catch (error) {
        if (error instanceof PendingLimitError) {
            // The message interpolates STORE_MAX_PENDING_PER_UNVERIFIED_PHONE
            // (never a hardcoded "3").
            return errorResponse(STORE_ERROR.PENDING_LIMIT, error.message, 429);
        }
        if (error instanceof InvalidOrderLineError) {
            return errorResponse(STORE_ERROR.INVALID_LINE, error.message, 400);
        }
        console.error("[store/orders] submission failed:", error);
        return errorResponse(
            STORE_ERROR.FORBIDDEN,
            "تعذّر إرسال الطلب. حاول مرة أخرى.",
            500
        );
    }
}

