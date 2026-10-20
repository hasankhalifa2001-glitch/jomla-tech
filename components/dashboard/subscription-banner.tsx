/* SubscriptionBanner.tsx */
"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import s from "./shell.module.css";

const PENDING_POLL_INTERVAL_MS = 30_000;

interface EffectiveStatusResponse {
    success?: boolean;
    subscriptionStatus?: string;
    status?: "ACTIVE" | "GRACE" | "EXPIRED" | "PENDING";
    writable?: boolean;
    daysLeft?: number | null;
    graceDaysLeft?: number | null;
    expiresAt?: string | null;
    renewalWarningDays?: number | null;
}

function parseDaysLeft(raw: unknown): number | null {
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(Math.floor(raw), 0);
    return null;
}

/**
 * T6c — dashboard subscription banner. ADMIN only, ONLINE only:
 *   - within SUBSCRIPTION_RENEWAL_WARNING_DAYS of expiry: soft warning
 *     "ينتهي اشتراكك بعد N يوم" + renew button;
 *   - GRACE: stronger banner with remaining grace days;
 *   - EXPIRED/PENDING: legacy lock/pending banners (redirects still own the
 *     navigation: ADMIN → /settings/billing, CASHIER → /account-locked).
 * No Dexie schema change; no offline banner (offline status can't be
 * trusted fresh, and offline writes queue for the per-item sync rule).
 */

export function SubscriptionBanner() {
    const { data: session, update: updateSession } = useSessionWithOfflineFallback();
    const role = (session as { role?: string } | null)?.role;
    const status = session?.subscriptionStatus;
    const [isChecking, setIsChecking] = useState(false);
    const [live, setLive] = useState<EffectiveStatusResponse | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const checkStatus = async () => {
        setIsChecking(true);
        try {
            const res = await fetch("/api/tenant/status");
            if (!res.ok) return;
            const data = (await res.json()) as EffectiveStatusResponse;
            setLive(data);
            if (data.subscriptionStatus && data.subscriptionStatus !== status && updateSession) {
                await updateSession({ subscriptionStatus: data.subscriptionStatus });
            }
        } catch (err) {
            console.error("Failed to check subscription status:", err);
        } finally {
            setIsChecking(false);
        }
    };

    useEffect(() => {
        if (typeof navigator !== "undefined" && !navigator.onLine) return;
        if (role !== "ADMIN") return;
        void checkStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [role]);

    useEffect(() => {
        if (status !== "PENDING") {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
            return;
        }
        pollRef.current = setInterval(checkStatus, PENDING_POLL_INTERVAL_MS);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);

    if (status !== "EXPIRED" && status !== "PENDING") {
        // [T6c] ADMIN-only, online-only warning/grace layers. Session alone
        // carries no daysLeft, so both need the live effective payload.
        if (role !== "ADMIN") return null;
        if (typeof navigator !== "undefined" && !navigator.onLine) return null;
        const effectiveStatus = live?.status;
        if (effectiveStatus === "GRACE") {
            const graceLeft = parseDaysLeft(live?.graceDaysLeft);
            return (
                <div role="alert" className={`${s.banner} ${s.bannerExpired}`}>
                    <div className={s.bannerText}>
                        <AlertTriangle size={20} aria-hidden />
                        <span>
                            انتهت صلاحية الاشتراك — متبقٍ {graceLeft ?? "بضعة"} يوم قبل إيقاف النظام. جدّد الآن لتفادي فقدان الوصول.
                        </span>
                    </div>
                    <div className={s.bannerActions}>
                        <Link href="/settings/billing" className={`${s.bannerBtn} ${s.btnWhite}`}>
                            تجديد الاشتراك الآن
                        </Link>
                    </div>
                </div>
            );
        }
        if (effectiveStatus === "ACTIVE") {
            const daysLeft = parseDaysLeft(live?.daysLeft);
            if (daysLeft === null) return null;
            const warnWindow = parseDaysLeft(live?.renewalWarningDays) ?? 7;
            if (daysLeft > warnWindow) return null;
            return (
                <div role="status" className={`${s.banner} ${s.bannerPending}`}>
                    <div className={s.bannerText}>
                        <AlertTriangle size={20} aria-hidden />
                        <span>ينتهي اشتراكك بعد {daysLeft} يوم. جدّد الآن لتفادي الانقطاع.</span>
                    </div>
                    <div className={s.bannerActions}>
                        <Link href="/settings/billing" className={`${s.bannerBtn} ${s.btnAmber}`}>
                            تجديد الاشتراك
                        </Link>
                    </div>
                </div>
            );
        }
        return null;
    }

    // Locked banners stay ADMIN-only and online-only (T6c); a locked CASHIER
    // never sees the dashboard shell — middleware owns that redirect.
    if (role !== "ADMIN") return null;
    if (typeof navigator !== "undefined" && !navigator.onLine) return null;

    if (status === "EXPIRED") {
        return (
            <div role="alert" className={`${s.banner} ${s.bannerExpired}`}>
                <div className={s.bannerText}>
                    <AlertTriangle size={20} aria-hidden />
                    <span>
                        تنبيه: اشتراك هذا المتجر منتهي! تم قفل عمليات التعديل والإنشاء (وضع القراءة فقط).
                    </span>
                </div>
                <div className={s.bannerActions}>
                    <Link href="/settings/billing" className={`${s.bannerBtn} ${s.btnWhite}`}>
                        تجديد الاشتراك الآن
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div role="status" className={`${s.banner} ${s.bannerPending}`}>
            <div className={s.bannerText}>
                <span className={s.pendingDot} aria-hidden />
                <span>طلب تمديد الاشتراك قيد المراجعة والتحقق من الإيصال المرفق.</span>
            </div>
            <div className={s.bannerActions}>
                <button
                    type="button"
                    onClick={checkStatus}
                    disabled={isChecking}
                    className={`${s.bannerBtn} ${s.btnAmberSolid}`}
                >
                    <RefreshCw size={14} className={isChecking ? s.spin : undefined} aria-hidden />
                    تحقق من الحالة
                </button>
                <Link href="/settings/billing" className={`${s.bannerBtn} ${s.btnAmber}`}>
                    عرض الإيصالات
                </Link>
            </div>
        </div>
    );
}