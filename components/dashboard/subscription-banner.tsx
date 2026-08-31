/* SubscriptionBanner.tsx */
"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// FIX: closes the session-staleness gap flagged in the middleware review.
// The merchant's JWT only reflects subscriptionStatus as of login (or the
// last explicit update() call) — a Super-Admin approval elsewhere never
// pushes to this session on its own. Two mechanisms below:
//   1. Manual "تحقق من الحالة" button — fetches the tenant's live status
//      and, if it changed, syncs the session via update() so the rest of
//      the app (middleware, other components reading useSession()) picks
//      it up without a full re-login.
//   2. Lightweight polling while PENDING specifically (not EXPIRED — that
//      always requires a manual renewal action anyway, so polling adds no
//      value there) so a merchant who leaves this tab open sees the
//      lockout clear on its own once approved.
//
// NOTE: this assumes a GET /api/tenant/status endpoint returning
// { subscriptionStatus }. If that route doesn't exist yet, it needs to be
// added — this component can't check the DB directly from the client.
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
            <div className="flex flex-wrap items-center justify-between gap-3 bg-red-600 px-4 py-2.5 text-white shadow-sm">
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
                    className="h-8 bg-white text-red-700 hover:bg-zinc-100 text-xs font-semibold"
                >
                    <Link href="/settings/billing">تجديد الاشتراك الآن</Link>
                </Button>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2.5 text-slate-950 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-medium">
                <Clock className="h-5 w-5 shrink-0" />
                <span>طلب تمديد الاشتراك قيد المراجعه والتحقق من الإيصال المرفق.</span>
            </div>
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={checkStatus}
                    disabled={isChecking}
                    className="h-8 text-slate-950 hover:bg-amber-600 text-xs font-semibold gap-1.5"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${isChecking ? "animate-spin" : ""}`} />
                    تحقق من الحالة
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    asChild
                    className="h-8 border-slate-900 bg-transparent text-slate-950 hover:bg-amber-600 text-xs font-semibold"
                >
                    <Link href="/settings/billing">عرض الإيصالات</Link>
                </Button>
            </div>
        </div>
    );
}