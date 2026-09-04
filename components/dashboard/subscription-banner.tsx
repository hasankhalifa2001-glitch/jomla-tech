/* SubscriptionBanner.tsx */
"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

const PENDING_POLL_INTERVAL_MS = 30_000;

export function SubscriptionBanner() {
    const { data: session, update: updateSession } = useSession();
    const status = session?.user?.subscriptionStatus;
    const [isChecking, setIsChecking] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const checkStatus = async () => {
        setIsChecking(true);
        try {
            const res = await fetch("/api/tenant/status");
            if (!res.ok) return;
            const data = await res.json();
            if (data.subscriptionStatus && data.subscriptionStatus !== status) {
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
            <div className="flex flex-col items-stretch gap-2 bg-red-600 px-4 py-2.5 text-white shadow-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="flex items-center gap-2.5 text-sm font-medium">
                    <AlertTriangle className="h-5 w-5 shrink-0" />
                    <span>
                        تنبيه: اشتراك هذا المتجر منتهي! تم قفل عمليات التعديل والإنشاء (وضع القراءة فقط).
                    </span>
                </div>
                <Button
                    size="sm"
                    variant="secondary"
                    asChild
                    className="h-8 w-full shrink-0 bg-white text-red-700 hover:bg-zinc-100 text-xs font-semibold sm:w-auto"
                >
                    <Link href="/settings/billing">تجديد الاشتراك الآن</Link>
                </Button>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-stretch gap-2 bg-amber-500 px-4 py-2.5 text-slate-950 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
                <Clock className="h-5 w-5 shrink-0" />
                <span>طلب تمديد الاشتراك قيد المراجعه والتحقق من الإيصال المرفق.</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={checkStatus}
                    disabled={isChecking}
                    className="h-8 flex-1 text-slate-950 hover:bg-amber-600 text-xs font-semibold gap-1.5 sm:flex-none"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${isChecking ? "animate-spin" : ""}`} />
                    تحقق من الحالة
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    asChild
                    className="h-8 flex-1 border-slate-900 bg-transparent text-slate-950 hover:bg-amber-600 text-xs font-semibold sm:flex-none"
                >
                    <Link href="/settings/billing">عرض الإيصالات</Link>
                </Button>
            </div>
        </div>
    );
}