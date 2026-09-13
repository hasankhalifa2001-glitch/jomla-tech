/* ExchangeRateTopbar.tsx */
"use client";

import { useEffect, useState } from "react";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils/money";
import { toast } from "sonner";
import { DollarSign, RefreshCw, CheckCircle2 } from "lucide-react";

export function ExchangeRateTopbar() {
    const { data: session } = useSessionWithOfflineFallback();
    const {
        dailyExchangeRate,
        isUpdating,
        error,
        updateExchangeRate,
        setCurrentTenantId,
    } = useExchangeRateStore();
    const [isEditing, setIsEditing] = useState<boolean>(false);

    const isAdmin = session?.role === "ADMIN";

    // Registers this tab's tenantId with the store as soon as the session is
    // known. This is a genuine external-system sync (Zustand store state
    // living outside this component), so useEffect is the right tool here —
    // unlike the inputValue/lastSyncedRate adjustment below, which is a
    // different case (see that comment).
    //
    // NOTE: ExchangeRateInitializer, mounted once at the app shell root,
    // already sets currentTenantId and bootstraps dailyExchangeRate
    // (Dexie cache first, then a fresh fetch from the database) for every
    // screen. This component no longer duplicates that fetch — it only
    // re-registers the tenantId defensively in case this component is ever
    // rendered without the initializer mounted above it.
    useEffect(() => {
        if (session?.tenantId) {
            setCurrentTenantId(session.tenantId);
        }
    }, [session?.tenantId, setCurrentTenantId]);

    const [inputValue, setInputValue] = useState<string>("");
    const [lastSyncedRate, setLastSyncedRate] = useState<number | null>(null);

    // This is React's officially documented pattern for "adjusting state
    // when a value changes" (react.dev/learn/you-might-not-need-an-effect,
    // "Adjusting some state when a prop changes"). Calling setState
    // directly in the render body like this is intentional and safe: React
    // detects the state change, discards the in-progress render, and
    // re-renders immediately with the new state BEFORE committing anything
    // to the screen or running any effects — so this never produces a
    // visible cascading render or an infinite loop. It is also cheaper
    // than wrapping this in useEffect, which would require a full extra
    // render + commit + effect cycle to achieve the same result.
    if (dailyExchangeRate !== lastSyncedRate) {
        setLastSyncedRate(dailyExchangeRate);
        setInputValue(
            dailyExchangeRate !== null && dailyExchangeRate !== undefined
                ? String(dailyExchangeRate)
                : ""
        );
    }

    useEffect(() => {
        if (error) {
            toast.error(error);
        }
    }, [error]);

    const handleSave = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        if (!isAdmin) return;

        const numericRate = parseFloat(inputValue);
        if (isNaN(numericRate) || numericRate <= 0) {
            toast.error("يرجى إدخال سعر صرف صحيح بأرقام أكبر من الصفر.");
            return;
        }

        // No JWT/session sync here: per T2a, dailyExchangeRate must never
        // be trusted from the session/JWT anywhere in the app, and nothing
        // reads it that way anymore — updateExchangeRate already writes
        // the new rate to the server (source of truth), the Zustand store
        // (this tab), Dexie (offline cache), and broadcasts it to other
        // tabs on this device. A next-auth session update() call here
        // would be a network round-trip with no reader left to serve.
        const success = await updateExchangeRate(numericRate, session?.tenantId);
        if (success) {
            toast.success(
                `تم تحديث سعر الصرف اليومي بنجاح (${numericRate.toLocaleString("ar-SY")} ل.س / 1$)`,
                { icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" /> }
            );
            setIsEditing(false);
        }
    };

    // CASHIER view: purely read-only badge with zero input controls or buttons
    if (!isAdmin) {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/80">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                    <DollarSign className="h-3.5 w-3.5" />
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <span className="text-zinc-600 dark:text-zinc-400 hidden sm:inline">سعر الصرف اليومي:</span>
                    <span className="text-zinc-600 dark:text-zinc-400 sm:hidden">الصرف:</span>
                    {dailyExchangeRate ? (
                        <Badge variant="outline" className="font-mono font-bold bg-white text-emerald-700 border-emerald-200 dark:bg-zinc-950 dark:text-emerald-300 dark:border-emerald-900/60 px-2 py-0.5 text-xs">
                            {formatMoney(dailyExchangeRate, "SYP", 0)} ل.س / $
                        </Badge>
                    ) : (
                        <span className="text-zinc-400 font-normal">غير محدد</span>
                    )}
                </div>
            </div>
        );
    }

    return (
        <form
            onSubmit={handleSave}
            className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/80 sm:w-auto sm:flex-nowrap"
        >
            <div className="flex shrink-0 items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                    <DollarSign className="h-3.5 w-3.5" />
                </div>
                <span className="text-xs font-semibold whitespace-nowrap">
                    <span className="sm:hidden">سعر الصرف:</span>
                    <span className="hidden sm:inline">سعر الصرف اليومي (SYP/$):</span>
                </span>
            </div>

            <div className="flex flex-1 items-center gap-2 sm:flex-none">
                <Input
                    type="number"
                    step="any"
                    placeholder="أدخل سعر اليوم..."
                    value={inputValue}
                    onChange={(e) => {
                        setInputValue(e.target.value);
                        setIsEditing(true);
                    }}
                    className="h-8 w-full min-w-0 text-center text-xs font-mono font-bold bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 border-zinc-300 focus-visible:ring-emerald-500 sm:w-28"
                    disabled={isUpdating}
                />

                <Button
                    type="submit"
                    size="sm"
                    disabled={
                        isUpdating ||
                        inputValue.trim() === "" ||
                        isNaN(parseFloat(inputValue)) ||
                        (!isEditing && dailyExchangeRate === parseFloat(inputValue))
                    }
                    className="h-8 shrink-0 px-2.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white dark:bg-emerald-600 dark:hover:bg-emerald-500"
                >
                    {isUpdating ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <span className="font-medium">تحديث</span>
                    )}
                </Button>
            </div>
        </form>
    );
}