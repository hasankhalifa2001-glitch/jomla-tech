/* ExchangeRateTopbar.tsx */
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

    useEffect(() => {
        if (session?.user?.dailyExchangeRate !== undefined && dailyExchangeRate === null) {
            setExchangeRate(session.user.dailyExchangeRate, session.user.tenantId);
        }
    }, [session, dailyExchangeRate, setExchangeRate]);

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