/* Cross-tenant by design: a system job, not a request handler.
   The ONLY file (besides the platform gateway) that reads across tenants for T6c. */
import { prisma } from "@/lib/db";
import {
    SUBSCRIPTION_GRACE_DAYS,
    SUBSCRIPTION_OFFER_VALIDITY_HOURS,
    SUBSCRIPTION_OFFER_EXPIRED_REASON,
} from "@/lib/config/subscription";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface ReconcileResult {
    tenantsExpired: number;
    subscriptionsExpired: number;
    offersRejected: number;
}

/**
 * Idempotent. Never required for correctness (getEffectiveTenantStatus decides live).
 *
 * RACE SAFETY: a Super-Admin approval can commit between our read and our writes.
 * Therefore every write re-states its full predicate instead of trusting ids:
 *   - tenant flip re-checks status = ACTIVE AND expiresAt < lockCutoff
 *     (a renewed tenant has a future expiresAt, so it no longer matches);
 *   - subscription flip is keyed on the ROW'S OWN expiresAt < lockCutoff,
 *     so a freshly approved row (future expiresAt) can never be expired here.
 * All writes are top-level calls inside ONE transaction.
 */
export async function reconcileSubscriptions(now: Date = new Date()): Promise<ReconcileResult> {
    const lockCutoff = new Date(now.getTime() - SUBSCRIPTION_GRACE_DAYS * DAY_MS);
    const offerCutoff = new Date(now.getTime() - SUBSCRIPTION_OFFER_VALIDITY_HOURS * HOUR_MS);

    return prisma.$transaction(async (tx) => {
        const stale = await tx.tenant.findMany({
            where: { subscriptionStatus: "ACTIVE", expiresAt: { not: null, lt: lockCutoff } },
            select: { id: true },
        });
        const ids = stale.map((t) => t.id);

        let tenantsExpired = 0;
        let subscriptionsExpired = 0;

        if (ids.length > 0) {
            const flipped = await tx.tenant.updateMany({
                where: {
                    id: { in: ids },
                    subscriptionStatus: "ACTIVE",
                    expiresAt: { not: null, lt: lockCutoff },
                },
                data: { subscriptionStatus: "EXPIRED" },
            });
            tenantsExpired = flipped.count;

            const subs = await tx.subscription.updateMany({
                where: {
                    tenantId: { in: ids },
                    status: "ACTIVE",
                    expiresAt: { lt: lockCutoff },
                },
                data: { status: "EXPIRED" },
            });
            subscriptionsExpired = subs.count;
        }

        // System rejection of stale receipt-less offers (T6a item 3 shape:
        // reviewedByUserId stays null, reviewedAt = now).
        const offers = await tx.subscription.updateMany({
            where: {
                status: "PENDING_APPROVAL",
                receiptImageURL: null,
                createdAt: { lt: offerCutoff },
            },
            data: {
                status: "REJECTED",
                rejectionReason: SUBSCRIPTION_OFFER_EXPIRED_REASON,
                reviewedByUserId: null,
                reviewedAt: now,
            },
        });

        return { tenantsExpired, subscriptionsExpired, offersRejected: offers.count };
    });
}