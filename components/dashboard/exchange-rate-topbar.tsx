"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { DollarSign, RefreshCw, CheckCircle2 } from "lucide-react";

export function ExchangeRateTopbar() {
    const { update: updateSession } = useSession();
    const { dailyExchangeRate, isUpdating, updateExchangeRate } = useExchangeRateStore();
    const [inputValue, setInputValue] = useState<string>("");
    const [isEditing, setIsEditing] = useState<boolean>(false);

    useEffect(() => {
        if (dailyExchangeRate !== null && dailyExchangeRate !== undefined) {
            setInputValue(String(dailyExchangeRate));
        } else {
            setInputValue("");
        }
    }, [dailyExchangeRate]);

    const handleSave = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();

        const numericRate = parseFloat(inputValue);
        if (isNaN(numericRate) || numericRate <= 0) {
            toast.error("يرجى إدخال سعر صرف صحيح بأرقام أكبر من الصفر.");
            return;
        }

        const success = await updateExchangeRate(numericRate);
        if (success) {
            toast.success(
                `تم تحديث سعر الصرف اليومي بنجاح (${numericRate.toLocaleString("ar-SY")} ل.س / 1$)`,
                { icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" /> }
            );
            setIsEditing(false);
            // Trigger session update to sync session context
            await updateSession({ dailyExchangeRate: numericRate });
        } else {
            toast.error("حدث خطأ أثناء تحديث سعر الصرف.");
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
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            handleSave();
                        }
                    }}
                    className="h-8 w-28 text-center text-xs font-mono font-bold bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 border-zinc-300 focus-visible:ring-emerald-500"
                    disabled={isUpdating}
                />
            </div>

            <Button
                type="submit"
                size="sm"
                disabled={isUpdating || (!isEditing && dailyExchangeRate === parseFloat(inputValue))}
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
