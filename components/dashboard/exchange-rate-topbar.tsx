"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { DollarSign, RefreshCw, CheckCircle2 } from "lucide-react";

export function ExchangeRateTopbar() {
    const { data: session, update: updateSession } = useSession();
    const { dailyExchangeRate, isUpdating, error, updateExchangeRate, setExchangeRate } =
        useExchangeRateStore();
    const [isEditing, setIsEditing] = useState<boolean>(false);

    // FIX #1: dropped `hasHydrated` entirely — it was redundant. The guard
    // condition (`dailyExchangeRate === null`) already prevents this from
    // re-firing once setExchangeRate() runs once, so a separate "have we
    // hydrated yet" flag was tracking information the store's own state
    // already carried. This is still legitimately a `useEffect` — syncing
    // TWO external systems (next-auth's session, Zustand's store) is
    // exactly what effects are for — the fix removes the unnecessary local
    // useState, not the effect itself.
    useEffect(() => {
        if (session?.user?.dailyExchangeRate !== undefined && dailyExchangeRate === null) {
            setExchangeRate(session.user.dailyExchangeRate, session.user.tenantId);
        }
    }, [session, dailyExchangeRate, setExchangeRate]);

    // FIX #2: `inputValue` is local component state DERIVED from the
    // store's `dailyExchangeRate` — this is the documented React pattern
    // for "adjusting state when a value it depends on changes" (see
    // react.dev/learn/you-might-not-need-an-effect). Instead of letting the
    // component commit with a stale inputValue and then correcting it one
    // render later via an effect, we compare against the last-seen rate
    // DURING render and adjust immediately — React discards that render
    // and re-renders synchronously before anything is painted, so there's
    // no visible flicker and no extra effect pass.
    const [inputValue, setInputValue] = useState<string>("");
    const [lastSyncedRate, setLastSyncedRate] = useState<number | null>(null);

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

        const numericRate = parseFloat(inputValue);
        if (isNaN(numericRate) || numericRate <= 0) {
            toast.error("يرجى إدخال سعر صرف صحيح بأرقام أكبر من الصفر.");
            return;
        }

        const success = await updateExchangeRate(numericRate, session?.user?.tenantId);
        if (success) {
            toast.success(
                `تم تحديث سعر الصرف اليومي بنجاح (${numericRate.toLocaleString("ar-SY")} ل.س / 1$)`,
                { icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" /> }
            );
            setIsEditing(false);
            await updateSession({ dailyExchangeRate: numericRate });
        }
    };

    return (
        <form
            onSubmit={handleSave}
            className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/80"
        >
            <div className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                    <DollarSign className="h-3.5 w-3.5" />
                </div>
                <span className="text-xs font-semibold whitespace-nowrap">
                    سعر الصرف اليومي (SYP/$):
                </span>
            </div>

            <div className="relative flex items-center">
                <Input
                    type="number"
                    step="any"
                    placeholder="أدخل سعر اليوم..."
                    value={inputValue}
                    onChange={(e) => {
                        setInputValue(e.target.value);
                        setIsEditing(true);
                    }}
                    className="h-8 w-28 text-center text-xs font-mono font-bold bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 border-zinc-300 focus-visible:ring-emerald-500"
                    disabled={isUpdating}
                />
            </div>

            <Button
                type="submit"
                size="sm"
                disabled={
                    isUpdating ||
                    inputValue.trim() === "" ||
                    isNaN(parseFloat(inputValue)) ||
                    (!isEditing && dailyExchangeRate === parseFloat(inputValue))
                }
                className="h-8 px-2.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white dark:bg-emerald-600 dark:hover:bg-emerald-500"
            >
                {isUpdating ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                    <span className="font-medium">تحديث</span>
                )}
            </Button>
        </form>
    );
}