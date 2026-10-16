import { SUBSCRIPTION_GRACE_DAYS } from "@/lib/config/subscription";

export type StoredTenantStatus = "ACTIVE" | "EXPIRED" | "PENDING";
export type EffectiveTenantStatus = "ACTIVE" | "GRACE" | "EXPIRED" | "PENDING";

export interface EffectiveTenantStatusResult {
    status: EffectiveTenantStatus;
    /** Days until expiresAt (ACTIVE only), else null. */
    daysLeft: number | null;
    /** Days until the lock moment (GRACE only), else null. */
    graceDaysLeft: number | null;
    /** expiresAt + grace; null when there is no expiry. */
    lockAt: Date | null;
    /** Writable <=> ACTIVE or GRACE. */
    writable: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Single source of truth for the real tenant status (T6c wires every other
 * consumer to this function). Pure: no I/O. Unknown/null stored status fails
 * CLOSED (EXPIRED, not writable).
 */
export function getEffectiveTenantStatus(
    tenant: { subscriptionStatus: StoredTenantStatus | null; expiresAt: Date | null },
    now: Date = new Date()
): EffectiveTenantStatusResult {
    const expiresAt = tenant.expiresAt;
    const lockAt = expiresAt
        ? new Date(expiresAt.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS)
        : null;

    if (tenant.subscriptionStatus === "PENDING") {
        return { status: "PENDING", daysLeft: null, graceDaysLeft: null, lockAt, writable: false };
    }

    if (tenant.subscriptionStatus !== "ACTIVE") {
        return { status: "EXPIRED", daysLeft: null, graceDaysLeft: null, lockAt, writable: false };
    }

    // Stored ACTIVE with no expiry (the platform-internal tenant only).
    if (!expiresAt || !lockAt) {
        return { status: "ACTIVE", daysLeft: null, graceDaysLeft: null, lockAt: null, writable: true };
    }

    const nowMs = now.getTime();

    if (nowMs <= expiresAt.getTime()) {
        return {
            status: "ACTIVE",
            daysLeft: Math.max(Math.ceil((expiresAt.getTime() - nowMs) / DAY_MS), 0),
            graceDaysLeft: null,
            lockAt,
            writable: true,
        };
    }

    if (nowMs <= lockAt.getTime()) {
        return {
            status: "GRACE",
            daysLeft: null,
            graceDaysLeft: Math.max(Math.ceil((lockAt.getTime() - nowMs) / DAY_MS), 0),
            lockAt,
            writable: true,
        };
    }

    return { status: "EXPIRED", daysLeft: null, graceDaysLeft: null, lockAt, writable: false };
}