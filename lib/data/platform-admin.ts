/**
 * lib/data/platform-admin.ts
 *
 * T6b Phase 1 — Super-Admin platform-rate data layer.
 * (Queue/detail/approve/reject/catalog arrive in later phases.)
 *
 * The ONLY module allowed to import lib/db/platform.ts (enforced by the
 * Phase-1 static scan). Every function takes PlatformAdminContext FIRST —
 * there is no ctx-less entry point, so the auth check is structural.
 * Top-level Prisma calls only; no nested writes; money via
 * lib/utils/money.ts (never `new Decimal`, never native floats).
 */

import type { PlatformAdminContext } from "@/lib/auth/platform-admin";
import { getPlatformDb, type PlatformDb } from "@/lib/db/platform";
import {
    PLATFORM_RATE_CONFIRM_THRESHOLD,
    PLATFORM_RATE_MAX,
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