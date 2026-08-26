"use client";

import { useSession } from "next-auth/react";
import Link from "next/link";
import { AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SubscriptionBanner() {
    const { data: session } = useSession();
    const status = session?.user?.subscriptionStatus;

    if (status !== "EXPIRED" && status !== "PENDING") {
        return null;
    }

    if (status === "EXPIRED") {
        return (
            <div className="flex flex-wrap items-center justify-between gap-3 bg-red-600 px-4 py-2.5 text-white shadow-sm">
                <div className="flex items-center gap-2.5 text-sm font-medium">
                    <AlertTriangle className="h-5 w-5 shrink-0 animate-bounce" />
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
            <Button
                size="sm"
                variant="outline"
                asChild
                className="h-8 border-slate-900 bg-transparent text-slate-950 hover:bg-amber-600 text-xs font-semibold"
            >
                <Link href="/settings/billing">عرض الإيصالات</Link>
            </Button>
        </div>
    );
}
