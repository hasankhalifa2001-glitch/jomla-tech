/* SubscriptionBanner.tsx */
"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import s from "./shell.module.css";

const PENDING_POLL_INTERVAL_MS = 30_000;

export function SubscriptionBanner() {
    const { data: session, update: updateSession } = useSessionWithOfflineFallback();
    const status = session?.subscriptionStatus;
    const [isChecking, setIsChecking] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const checkStatus = async () => {
        setIsChecking(true);
        try {
            const res = await fetch("/api/tenant/status");
            if (!res.ok) return;
            const data = await res.json();
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
        return null;
    }

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