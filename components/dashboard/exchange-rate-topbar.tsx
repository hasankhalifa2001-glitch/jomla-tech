/* ExchangeRateTopbar.tsx */
"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, DollarSign, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import { formatMoney } from "@/lib/utils/money";

/** Latin digits, to match the dashboard screen (see its [DIGITS] note). When
 *  the whole app settles on one digit style, change formatMoney() itself and
 *  delete this helper. */
function latinDigits(s: string): string {
    return s
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/\u066C/g, ",")
        .replace(/\u066B/g, ".");
}

const fmtRate = (rate: number) => latinDigits(formatMoney(rate, "SYP", 0));

const CHIP_BASE =
    "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold tabular-nums sm:px-3 sm:text-[13px]";
const CHIP_NEUTRAL = "border-slate-200 bg-slate-50 text-slate-800";
// A missing rate blocks USD pricing, so for an admin the chip asks for action.
const CHIP_WARN = "border-amber-300 bg-amber-50 text-amber-900";

function RateValue({ rate }: { rate: number | null | undefined }) {
    if (!rate) return <span>غير محدد</span>;
    return (
        // Every piece is its OWN flex item (never one "$1 =" string), so in RTL the
        // visual order is: $1  =  135  ل.س  (right → left). Mobile keeps just the number.
        <span className="inline-flex items-baseline gap-1">
            <bdi dir="ltr" className="hidden text-slate-500 sm:inline">$1</bdi>
            <span className="hidden text-slate-400 sm:inline" aria-hidden>
                =
            </span>
            <span className="font-bold text-slate-900">{fmtRate(rate)}</span>
            <span className="hidden text-[0.85em] font-medium text-slate-500 sm:inline">ل.س</span>
        </span>
    );
}

export function ExchangeRateTopbar() {
    const { data: session } = useSessionWithOfflineFallback();
    const { dailyExchangeRate, isUpdating, error, updateExchangeRate, setCurrentTenantId } =
        useExchangeRateStore();

    const [open, setOpen] = useState(false);
    const [inputValue, setInputValue] = useState("");

    const isAdmin = session?.role === "ADMIN";

    // ExchangeRateInitializer (app shell root) already bootstraps the rate for
    // every screen; this only re-registers the tenantId defensively.
    useEffect(() => {
        if (session?.tenantId) setCurrentTenantId(session.tenantId);
    }, [session?.tenantId, setCurrentTenantId]);

    useEffect(() => {
        if (error) toast.error(error);
    }, [error]);

    // The input is re-seeded from the store each time the popover OPENS, so a
    // half-typed value never survives a close and a remote change is picked up.
    const handleOpenChange = (next: boolean) => {
        if (next) {
            setInputValue(
                dailyExchangeRate !== null && dailyExchangeRate !== undefined ? String(dailyExchangeRate) : ""
            );
        }
        setOpen(next);
    };

    const parsed = parseFloat(inputValue);
    const invalid = inputValue.trim() === "" || Number.isNaN(parsed);
    const unchanged = !invalid && dailyExchangeRate === parsed;

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!isAdmin) return;

        if (Number.isNaN(parsed) || parsed <= 0) {
            toast.error("يرجى إدخال سعر صرف صحيح بأرقام أكبر من الصفر.");
            return;
        }

        // updateExchangeRate writes to the server (source of truth), the store,
        // Dexie and other tabs. No session/JWT sync: the rate is never trusted
        // from the session (T2a).
        const success = await updateExchangeRate(parsed, session?.tenantId);
        if (success) {
            toast.success(`تم تحديث سعر الصرف اليومي بنجاح (${fmtRate(parsed)} ل.س / 1$)`, {
                icon: <CheckCircle2 size={16} color="#10b981" />,
            });
            setOpen(false);
        }
    };

    // CASHIER: read-only chip, no controls.
    if (!isAdmin) {
        return (
            <div
                className={cn(CHIP_BASE, CHIP_NEUTRAL)}
                title="سعر الصرف اليومي"
                role="status"
                aria-label="سعر الصرف اليومي"
            >
                <DollarSign size={15} className="text-slate-500" aria-hidden />
                <RateValue rate={dailyExchangeRate} />
            </div>
        );
    }

    const missing = !dailyExchangeRate;

    return (
        <Popover open={open} onOpenChange={handleOpenChange}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label="تعديل سعر الصرف اليومي"
                    className={cn(
                        CHIP_BASE,
                        missing ? CHIP_WARN : CHIP_NEUTRAL,
                        "transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1",
                        // Missing rate on a phone: a 36px icon button with a dot, so the
                        // page title keeps its room. The full sentence returns from sm.
                        missing && "relative w-9 justify-center px-0 hover:bg-amber-100 sm:w-auto sm:px-3"
                    )}
                >
                    <DollarSign size={15} className={missing ? "text-amber-700" : "text-slate-500"} aria-hidden />
                    {missing ? (
                        <>
                            <span className="hidden sm:inline">حدّد سعر الصرف</span>
                            <span
                                className="absolute end-0.5 top-0.5 size-2 rounded-full bg-amber-500 sm:hidden"
                                aria-hidden
                            />
                        </>
                    ) : (
                        <RateValue rate={dailyExchangeRate} />
                    )}
                </button>
            </PopoverTrigger>

            <PopoverContent align="end" dir="rtl" className="w-72 space-y-3 p-4">
                <form onSubmit={handleSave} className="space-y-3">
                    <div className="space-y-1">
                        <label htmlFor="daily-exchange-rate" className="text-sm font-extrabold text-slate-900">
                            سعر الصرف اليومي
                        </label>
                        <p className="text-xs leading-relaxed text-slate-600">
                            ليرة سورية مقابل 1 دولار. الفواتير الصادرة سابقاً تحتفظ بسعرها.
                        </p>
                    </div>

                    <input
                        id="daily-exchange-rate"
                        type="number"
                        step="any"
                        inputMode="decimal"
                        dir="ltr"
                        autoFocus
                        placeholder="0"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        disabled={isUpdating}
                        className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-start text-lg font-bold tabular-nums text-slate-900 placeholder:text-slate-400 focus-visible:border-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/30 disabled:opacity-60"
                    />

                    <Button
                        type="submit"
                        disabled={isUpdating || invalid || unchanged}
                        className="h-10 w-full bg-emerald-600 font-bold text-white hover:bg-emerald-700"
                    >
                        {isUpdating ? (
                            <Loader2 className="size-4 animate-spin" aria-label="جاري الحفظ" />
                        ) : (
                            "حفظ السعر"
                        )}
                    </Button>
                </form>
            </PopoverContent>
        </Popover>
    );
}