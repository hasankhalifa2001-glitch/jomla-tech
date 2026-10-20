/**
 * lib/data/platform-admin.ts
 *
 * T6b Phase 1 — Super-Admin platform-rate data layer.
 * [T6b Phase 2] + subscription queue / detail / receipt key (read-only).
 * (Approve/reject/catalog arrive in later phases.)
 *
 * The ONLY module allowed to import lib/db/platform.ts (enforced by the
 * static scan in the T6b tests). Every function takes PlatformAdminContext
 * FIRST — there is no ctx-less entry point, so the auth check is structural.
 * Top-level Prisma calls only; no nested writes; money via
 * lib/utils/money.ts (never `new Decimal`, never native floats).
 */

import type { PlatformAdminContext } from "@/lib/auth/platform-admin";
import { getPlatformDb, type PlatformDb } from "@/lib/db/platform";
import {
    PLATFORM_RATE_CONFIRM_THRESHOLD,
    PLATFORM_RATE_MAX,
    SUBSCRIPTION_OFFER_VALIDITY_HOURS,
} from "@/lib/config/subscription";
import { PLATFORM_TENANT_SLUG } from "@/lib/data/platform-rate";
import {
    compareMoney,
    MoneyError,
    multiplyMoney,
    subtractMoney,
    toDecimal,
} from "@/lib/utils/money";

export class InvalidPlatformRateError extends Error {
    constructor(message = "سعر الصرف غير صالح.") {
        super(message);
        this.name = "InvalidPlatformRateError";
    }
}

export class PlatformRateConfirmRequiredError extends Error {
    readonly currentRate: string;
    readonly newRate: string;
    constructor(currentRate: string, newRate: string) {
        super("التغيير كبير — يرجى التأكيد.");
        this.name = "PlatformRateConfirmRequiredError";
        this.currentRate = currentRate;
        this.newRate = newRate;
    }
}

export interface PlatformRateView {
    rate: string | null;
    updatedAt: string | null;
}

export interface SetPlatformRateInput {
    rate: unknown;
    confirm?: unknown;
}

export class PlatformTenantNotFoundError extends Error {
    constructor() {
        super("Tenant missing.");
        this.name = "PlatformTenantNotFoundError";
    }
}

/** Reads the platform-internal tenant rate + last-changed time. */
export async function getPlatformRate(ctx: PlatformAdminContext): Promise<PlatformRateView> {
    const db: PlatformDb = getPlatformDb(ctx);
    const row = await db.tenant.findUnique({
        where: { slug: PLATFORM_TENANT_SLUG },
        select: { dailyExchangeRate: true, updatedAt: true },
    });
    if (!row) throw new PlatformTenantNotFoundError();
    return {
        rate: row.dailyExchangeRate != null ? row.dailyExchangeRate.toString() : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
}

/** Writes the platform-internal tenant rate. Top-level update pinned to slug. */
export async function setPlatformRate(
    ctx: PlatformAdminContext,
    input: SetPlatformRateInput
): Promise<PlatformRateView> {
    const canonical = validatePlatformRateInput(input.rate);
    const db: PlatformDb = getPlatformDb(ctx);
    const current = await db.tenant.findUnique({
        where: { slug: PLATFORM_TENANT_SLUG },
        select: { dailyExchangeRate: true },
    });
    if (!current) throw new PlatformTenantNotFoundError();
    const currentStr =
        current.dailyExchangeRate != null ? current.dailyExchangeRate.toString() : null;
    if (platformRateNeedsConfirm(currentStr, canonical) && input.confirm !== true) {
        throw new PlatformRateConfirmRequiredError(currentStr ?? "0", canonical);
    }
    const updated = await db.tenant.update({
        where: { slug: PLATFORM_TENANT_SLUG },
        data: { dailyExchangeRate: canonical },
        select: { dailyExchangeRate: true, updatedAt: true },
    });
    // Every subscription offer is priced from this value and there is no
    // audit table for it, so leave a structured trace of who changed what.
    console.info("[platform-rate] changed", {
        byUserId: ctx.userId,
        from: currentStr,
        to: canonical,
    });
    return {
        rate: updated.dailyExchangeRate != null ? updated.dailyExchangeRate.toString() : null,
        updatedAt: updated.updatedAt ? updated.updatedAt.toISOString() : null,
    };
}


/** Decimal string with up to 4 dp: digits, optional fraction of 1–4 digits. */
const DECIMAL_4DP_RE = /^\d{1,14}(\.\d{1,4})?$/;

/**
 * Validates a platform-rate Decimal string: shape (<=4 dp), > 0,
 * <= PLATFORM_RATE_MAX. Returns the canonical trimmed string.
 * Throws InvalidPlatformRateError on any violation.
 */
export function validatePlatformRateInput(raw: unknown): string {
    if (typeof raw !== "string") throw new InvalidPlatformRateError("سعر الصرف يجب أن يكون نصا عشريا.");
    const rate = raw.trim();
    if (!DECIMAL_4DP_RE.test(rate)) {
        throw new InvalidPlatformRateError("سعر الصرف يجب أن يكون رقما عشريا موجبا (حتى 4 منازل عشرية).");
    }
    let cmp: number;
    try {
        if (compareMoney(rate, "0") <= 0) {
            throw new InvalidPlatformRateError("يجب أن يكون سعر الصرف أكبر من الصفر.");
        }
        cmp = compareMoney(rate, PLATFORM_RATE_MAX);
    } catch (error) {
        if (error instanceof InvalidPlatformRateError) throw error;
        throw new InvalidPlatformRateError("سعر الصرف غير صالح.");
    }
    if (cmp > 0) {
        throw new InvalidPlatformRateError("القيمة أكبر من المتوقع، يرجى التأكد من الرقم المدخل.");
    }
    try {
        return toDecimal(rate).toString();
    } catch (error) {
        if (error instanceof MoneyError) throw new InvalidPlatformRateError("سعر الصرف غير صالح.");
        throw error;
    }
}

/**
 * True when |newRate - currentRate| exceeds currentRate × THRESHOLD
 * (i.e. a change of more than PLATFORM_RATE_CONFIRM_THRESHOLD, 25%).
 * Pure + unit-tested. Computed entirely through lib/utils/money.ts — no
 * native-number arithmetic. A current rate of 0/null means "no rate set":
 * no confirmation needed. A change of exactly 25% does NOT need confirming.
 */
export function platformRateNeedsConfirm(currentRate: string | null, newRate: string): boolean {
    if (currentRate == null) return false;
    let current: string;
    let next: string;
    try {
        current = toDecimal(currentRate).toString();
        next = toDecimal(newRate).toString();
    } catch {
        return false;
    }
    if (compareMoney(current, "0") <= 0) return false;

    const diff = subtractMoney(next, current);
    const absDiff = compareMoney(diff, "0") < 0 ? subtractMoney("0", diff) : diff;
    const allowed = multiplyMoney(current, String(PLATFORM_RATE_CONFIRM_THRESHOLD));
    return compareMoney(absDiff, allowed) > 0;
}

// ============================================================================
// [T6b Phase 2] Super-Admin subscription queue / detail (read-only).
// Reuses the same typed gateway (getPlatformDb) — no second gateway.
// Every query carries an explicit where; never an unfiltered findMany.
// ============================================================================

export const SUBSCRIPTION_PAGE_SIZE = 25;
export const SUBSCRIPTION_MAX_SEARCH_LENGTH = 100;
/** Amendment K: cap on tenant-id matches for a name search. */
export const SUBSCRIPTION_TENANT_ID_CAP = 100;
const MAX_CURSOR_ID_LENGTH = 64;
const SUB_DAY_MS = 24 * 60 * 60 * 1000;

export type SubscriptionQueueStatus =
    | "PENDING_APPROVAL"
    | "ACTIVE"
    | "REJECTED"
    | "EXPIRED";

export class InvalidSubscriptionCursorError extends Error {
    constructor() {
        super("رمز المتابعة غير صالح.");
        this.name = "InvalidSubscriptionCursorError";
    }
}

export class SubscriptionNotFoundError extends Error {
    constructor() {
        super("طلب الاشتراك غير موجود.");
        this.name = "SubscriptionNotFoundError";
    }
}

/** Opaque cursor carrying BOTH sort keys (createdAt + id). Untrusted input. */
export function encodeSubscriptionCursor(createdAtIso: string, id: string): string {
    return Buffer.from(JSON.stringify({ c: createdAtIso, i: id }), "utf-8").toString("base64url");
}

export function decodeSubscriptionCursor(cursor: string): { createdAtMs: number; id: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    } catch {
        throw new InvalidSubscriptionCursorError();
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { c?: unknown }).c !== "string" ||
        typeof (parsed as { i?: unknown }).i !== "string"
    ) {
        throw new InvalidSubscriptionCursorError();
    }
    const ms = Date.parse((parsed as { c: string }).c);
    if (Number.isNaN(ms)) throw new InvalidSubscriptionCursorError();
    const id = (parsed as { i: string }).i;
    if (!id || id.length > MAX_CURSOR_ID_LENGTH) throw new InvalidSubscriptionCursorError();
    return { createdAtMs: ms, id };
}

export interface SubscriptionQueueTenant {
    id: string;
    name: string;
    slug: string;
    phone: string | null;
}

export interface SubscriptionQueueRow {
    id: string;
    tenant: SubscriptionQueueTenant;
    tier: string;
    amountSYP: string;
    amountUSD: string;
    referenceCode: string;
    exchangeRateUsed: string;
    status: SubscriptionQueueStatus;
    createdAt: string;
    ageHours: number;
    hasReceipt: boolean;
    /** now > createdAt + validity. Approving a stale offer is allowed (I). */
    isStale: boolean;
}

export interface SubscriptionQueuePage {
    items: SubscriptionQueueRow[];
    nextCursor: string | null;
    pendingCount: number;
    /** Amendment K: name match hit the 100-id cap — UI shows "ضيّق البحث". */
    searchTruncated: boolean;
}

export interface ListSubscriptionsInput {
    status?: unknown;
    q?: unknown;
    cursor?: unknown;
    limit?: unknown;
}

const QUEUE_STATUSES: readonly SubscriptionQueueStatus[] = [
    "PENDING_APPROVAL",
    "ACTIVE",
    "REJECTED",
    "EXPIRED",
];

function parseQueueStatus(raw: unknown): SubscriptionQueueStatus {
    if (typeof raw === "string" && (QUEUE_STATUSES as readonly string[]).includes(raw)) {
        return raw as SubscriptionQueueStatus;
    }
    return "PENDING_APPROVAL";
}

function parseQueueLimit(raw: unknown): number {
    const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 100) return SUBSCRIPTION_PAGE_SIZE;
    return n;
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function subAgeHours(createdAt: Date, now: Date): number {
    return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 3600000));
}

/** Queue list: keyset (createdAt desc, id desc); ref search insensitive; name capped. */
export async function listSubscriptions(
    ctx: PlatformAdminContext,
    input: ListSubscriptionsInput,
    now: Date = new Date()
): Promise<SubscriptionQueuePage> {
    const status = parseQueueStatus(input.status);
    const limit = parseQueueLimit(input.limit);
    const rawQ = typeof input.q === "string" ? input.q.trim().slice(0, SUBSCRIPTION_MAX_SEARCH_LENGTH) : "";
    const rawCursor = typeof input.cursor === "string" && input.cursor.length > 0 ? input.cursor : null;
    const cursor = rawCursor ? decodeSubscriptionCursor(rawCursor) : null;
    const db: PlatformDb = getPlatformDb(ctx);
    const validityMs = SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000;

    // Search limitation (documented): `contains` + case-insensitive only, no
    // Arabic folding (same limitation as the T5b orders search).
    let searchTruncated = false;
    let tenantIds: string[] | null = null;
    let refUpper: string | null = null;
    if (rawQ) {
        refUpper = rawQ.toUpperCase();
        const found = await db.tenant.findMany({
            where: { name: { contains: rawQ, mode: "insensitive" } },
            select: { id: true },
            // Stable order: without it the capped subset could differ between
            // calls and break pagination for the same search.
            orderBy: { id: "asc" },
            take: SUBSCRIPTION_TENANT_ID_CAP + 1,
        });
        searchTruncated = found.length > SUBSCRIPTION_TENANT_ID_CAP;
        tenantIds = (searchTruncated ? found.slice(0, SUBSCRIPTION_TENANT_ID_CAP) : found).map((t) => t.id);
    }

    const ors: Array<Record<string, unknown>> = [];
    if (refUpper) {
        // contains already covers an exact match.
        ors.push({ referenceCode: { contains: refUpper, mode: "insensitive" } });
        if (tenantIds && tenantIds.length > 0) ors.push({ tenantId: { in: tenantIds } });
    }
    const ands: Array<Record<string, unknown>> = [];
    if (cursor) {
        const curDate = new Date(cursor.createdAtMs);
        ands.push({ OR: [{ createdAt: { lt: curDate } }, { createdAt: { equals: curDate }, id: { lt: cursor.id } }] });
    }
    const where: Record<string, unknown> = { status };
    if (ors.length > 0) where.OR = ors;
    if (ands.length > 0) where.AND = ands;

    const [rows, pendingCount] = await Promise.all([
        db.subscription.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
            select: {
                id: true, tenantId: true, tier: true, amountSYP: true, amountUSD: true,
                referenceCode: true, exchangeRateUsed: true, status: true,
                receiptImageURL: true, createdAt: true,
            },
        }),
        db.subscription.count({ where: { status: "PENDING_APPROVAL" } }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const tenantMap = new Map<string, SubscriptionQueueTenant>();
    if (page.length > 0) {
        const ids = [...new Set(page.map((r) => r.tenantId))];
        const tenants = await db.tenant.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, slug: true, phone: true },
        });
        for (const t of tenants) tenantMap.set(t.id, { id: t.id, name: t.name, slug: t.slug, phone: t.phone ?? null });
    }
    const items: SubscriptionQueueRow[] = page.map((r) => {
        const created = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string);
        const tenant = tenantMap.get(r.tenantId) ?? { id: r.tenantId, name: "—", slug: "—", phone: null };
        return {
            id: r.id, tenant, tier: r.tier,
            amountSYP: r.amountSYP.toString(), amountUSD: r.amountUSD.toString(),
            referenceCode: r.referenceCode, exchangeRateUsed: r.exchangeRateUsed.toString(),
            status: r.status as SubscriptionQueueStatus, createdAt: toIso(created),
            ageHours: subAgeHours(created, now), hasReceipt: r.receiptImageURL != null,
            isStale: now.getTime() > created.getTime() + validityMs,
        };
    });
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeSubscriptionCursor(toIso(last.createdAt as Date), last.id) : null;
    return { items, nextCursor, pendingCount, searchTruncated };
}

export interface SubscriptionHistoryRow {
    id: string;
    tier: string;
    amountSYP: string;
    amountUSD: string;
    status: SubscriptionQueueStatus;
    hasReceipt: boolean;
    rejectionReason: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SubscriptionDetailView {
    id: string;
    tenant: SubscriptionQueueTenant & {
        subscriptionStatus: string;
        expiresAt: string | null;
    };
    tier: string;
    durationDays: number;
    amountSYP: string;
    amountUSD: string;
    referenceCode: string;
    /** Rate frozen at request time (amendment I). */
    exchangeRateUsed: string;
    status: SubscriptionQueueStatus;
    createdAt: string;
    ageHours: number;
    hasReceipt: boolean;
    isStale: boolean;
    rejectionReason: string | null;
    reviewedAt: string | null;
    lastRequests: SubscriptionHistoryRow[];
    /** D6 preview: max(now, future tenant expiry) + frozen durationDays. */
    previewNewExpiry: string;
    platformRate: { current: string | null };
}

/** Pure D6: max(now, future tenant expiry) + frozen durationDays. */
export function previewNewExpiry(input: {
    now: Date;
    tenantExpiresAt: Date | null;
    durationDays: number;
}): Date {
    const base =
        input.tenantExpiresAt && input.tenantExpiresAt.getTime() > input.now.getTime()
            ? input.tenantExpiresAt
            : input.now;
    return new Date(base.getTime() + input.durationDays * SUB_DAY_MS);
}

/** One subscription + tenant + last 10 tenant requests + expiry preview. */
export async function getSubscriptionDetail(
    ctx: PlatformAdminContext,
    id: string,
    now: Date = new Date()
): Promise<SubscriptionDetailView> {
    const db: PlatformDb = getPlatformDb(ctx);
    const row = await db.subscription.findUnique({
        where: { id },
        select: {
            id: true, tenantId: true, tier: true, durationDays: true,
            amountSYP: true, amountUSD: true, referenceCode: true,
            exchangeRateUsed: true, status: true, receiptImageURL: true,
            rejectionReason: true, reviewedAt: true, createdAt: true,
        },
    });
    if (!row) throw new SubscriptionNotFoundError();
    const tenant = await db.tenant.findUnique({
        where: { id: row.tenantId },
        select: {
            id: true, name: true, slug: true, phone: true,
            subscriptionStatus: true, expiresAt: true,
        },
    });
    if (!tenant) throw new SubscriptionNotFoundError();
    const hist = await db.subscription.findMany({
        where: { tenantId: row.tenantId },
        orderBy: [{ createdAt: "desc" }],
        take: 10,
        select: {
            id: true, tier: true, amountSYP: true, amountUSD: true, status: true,
            receiptImageURL: true, rejectionReason: true, createdAt: true, updatedAt: true,
        },
    });
    const plat = await db.tenant.findUnique({
        where: { slug: PLATFORM_TENANT_SLUG },
        select: { dailyExchangeRate: true },
    });
    const validityMs = SUBSCRIPTION_OFFER_VALIDITY_HOURS * 60 * 60 * 1000;
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string);
    const tenantExp =
        tenant.expiresAt == null
            ? null
            : tenant.expiresAt instanceof Date
                ? tenant.expiresAt
                : new Date(tenant.expiresAt as unknown as string);
    return {
        id: row.id,
        tenant: {
            id: tenant.id, name: tenant.name, slug: tenant.slug, phone: tenant.phone ?? null,
            subscriptionStatus: tenant.subscriptionStatus,
            expiresAt: tenantExp ? tenantExp.toISOString() : null,
        },
        tier: row.tier, durationDays: row.durationDays,
        amountSYP: row.amountSYP.toString(), amountUSD: row.amountUSD.toString(),
        referenceCode: row.referenceCode, exchangeRateUsed: row.exchangeRateUsed.toString(),
        status: row.status as SubscriptionQueueStatus, createdAt: toIso(created),
        ageHours: subAgeHours(created, now), hasReceipt: row.receiptImageURL != null,
        isStale: now.getTime() > created.getTime() + validityMs,
        rejectionReason: row.rejectionReason ?? null,
        reviewedAt: row.reviewedAt ? toIso(row.reviewedAt as Date) : null,
        lastRequests: hist.map((h) => ({
            id: h.id, tier: h.tier,
            amountSYP: h.amountSYP.toString(), amountUSD: h.amountUSD.toString(),
            status: h.status as SubscriptionQueueStatus, hasReceipt: h.receiptImageURL != null,
            rejectionReason: h.rejectionReason ?? null,
            createdAt: toIso(h.createdAt as Date), updatedAt: toIso(h.updatedAt as Date),
        })),
        previewNewExpiry: previewNewExpiry({ now, tenantExpiresAt: tenantExp, durationDays: row.durationDays }).toISOString(),
        platformRate: { current: plat?.dailyExchangeRate != null ? plat.dailyExchangeRate.toString() : null },
    };
}

/**
 * The stored receipt key of a subscription + its OWNING tenant id, for the
 * receipt route. The route (not this function) verifies that the key lives
 * under `receipts/<tenantId>/` before signing. Lives here so that
 * lib/db/platform.ts keeps exactly ONE importer.
 */
export async function getSubscriptionReceiptKey(
    ctx: PlatformAdminContext,
    id: string
): Promise<{ tenantId: string; receiptKey: string | null }> {
    const db: PlatformDb = getPlatformDb(ctx);
    const row = await db.subscription.findUnique({
        where: { id },
        select: { tenantId: true, receiptImageURL: true },
    });
    if (!row) throw new SubscriptionNotFoundError();
    return { tenantId: row.tenantId, receiptKey: row.receiptImageURL ?? null };
}