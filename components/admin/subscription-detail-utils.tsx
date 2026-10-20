"use client";

/** T6b Phase 2 — detail view part 1: types + formatters. */

export interface AdminSubDetail {
    id: string;
    tenant: { name: string; slug: string; phone: string | null; subscriptionStatus: string; expiresAt: string | null };
    tier: string;
    durationDays: number;
    amountSYP: string;
    amountUSD: string;
    referenceCode: string;
    exchangeRateUsed: string;
    status: string;
    createdAt: string;
    hasReceipt: boolean;
    isStale: boolean;
    lastRequests: Array<{ id: string; tier: string; amountSYP: string; status: string; createdAt: string }>;
    previewNewExpiry: string;
    platformRate: { current: string | null };
}

export function fmtSYP(v: string): string {
    const n = Number(v);
    return Number.isFinite(n) ? new Intl.NumberFormat("ar-SY", { maximumFractionDigits: 0 }).format(n) : v;
}

export function fmtDT(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Intl.DateTimeFormat("ar-SY", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "Asia/Damascus",
        }).format(new Date(iso));
    } catch {
        return iso;
    }
}
