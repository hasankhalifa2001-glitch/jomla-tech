/* ExchangeRateTopbar.tsx */
"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils/money";
import { toast } from "sonner";
import { DollarSign, RefreshCw, CheckCircle2 } from "lucide-react";

export function ExchangeRateTopbar() {
    const { data: session, update: updateSession } = useSession();
    const {
        dailyExchangeRate,
        isUpdating,
        error,
        updateExchangeRate,
        setExchangeRate,
        setCurrentTenantId,
    } = useExchangeRateStore();
    const [isEditing, setIsEditing] = useState<boolean>(false);

    const isAdmin = session?.user?.role === "ADMIN";

    // Registers this tab's tenantId with the store as soon as the session is
    // known. This is a genuine external-system sync (Zustand store state
    // living outside this component), so useEffect is the right tool here —
    // unlike the inputValue/lastSyncedRate adjustment below, which is a
    // different case (see that comment).
    useEffect(() => {
        if (session?.user?.tenantId) {
            setCurrentTenantId(session.user.tenantId);
        }
    }, [session?.user?.tenantId, setCurrentTenantId]);

    // [FIX — stale JWT source of truth] Previously seeded dailyExchangeRate
    // exclusively from session.user.dailyExchangeRate (the JWT), matching
    // T2a's own rule that this field must never be trusted from the token:
    // it can change mid-session on ANY device (another ADMIN tab, another
    // browser, another ADMIN account entirely) and this device's JWT has no
    // way to know that happened until its own token is explicitly refreshed
    // via updateSession(). That refresh only ever fires on the editing
    // ADMIN's own tab after a successful save — every OTHER open
    // session (a CASHIER's separate browser, an ADMIN's second device, a
    // stale tab that's simply been open a while) never gets it, and a
    // manual page reload doesn't help either, since a plain session read is
    // not a `trigger: 'update'` and re-hydrates the same stale JWT value.
    //
    // Fixed the same way subscriptionStatus already is elsewhere in this
    // codebase: fetch the live value from the database via GET
    // /api/tenant/exchange-rate on every mount, unconditionally — not only
    // when the store happens to be empty. session.user.dailyExchangeRate is
    // used strictly as a same-tick fallback so the badge/input isn't blank
    // while the fetch is in flight; the fetched value always overwrites it
    // once the request resolves, and is treated as the sole source of
    // truth from that point on.
    useEffect(() => {
        if (session?.user?.dailyExchangeRate !== undefined && dailyExchangeRate === null) {
            setExchangeRate(session.user.dailyExchangeRate, session.user.tenantId);
        }
    }, [session, dailyExchangeRate, setExchangeRate]);

    useEffect(() => {
        if (!session?.user?.tenantId) return;

        let cancelled = false;

        (async () => {
            try {
                const res = await fetch("/api/tenant/exchange-rate", {
                    method: "GET",
                    cache: "no-store",
                });
                if (!res.ok) return;
                const data = await res.json();
                if (cancelled) return;
                if (data?.success && data.dailyExchangeRate !== undefined) {
                    // Always applied, even if it matches what's already
                    // shown — this fetch result is what makes the value
                    // authoritative for this mount, not a conditional
                    // "only if different" update.
                    setExchangeRate(data.dailyExchangeRate, session.user.tenantId);
                }
            } catch (err) {
                // Network/offline failure: silently keep whatever value is
                // already shown (session fallback or cache) rather than
                // surfacing an error toast for a background refresh.
                console.error("Failed to fetch fresh daily exchange rate:", err);
            }
        })();

        return () => {
            cancelled = true;
        };
        // Intentionally re-runs whenever the tenant changes (covers a
        // session/account switch in the same tab), and once per mount
        // otherwise — this is the fresh-read-on-load fix itself, so it must
        // not be skipped when dailyExchangeRate is already non-null (e.g.
        // seeded from a stale JWT or Dexie cache).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session?.user?.tenantId]);

    const [inputValue, setInputValue] = useState<string>("");
    const [lastSyncedRate, setLastSyncedRate] = useState<number | null>(null);

    // [FIX — reverted] This is React's officially documented pattern for
    // "adjusting state when a value changes" (react.dev/learn/
    // you-might-not-need-an-effect, "Adjusting some state when a prop
    // changes"). Calling setState directly in the render body like this is
    // intentional and safe: React detects the state change, discards the
    // in-progress render, and re-renders immediately with the new state
    // BEFORE committing anything to the screen or running any effects — so
    // this never produces a visible cascading render or an infinite loop.
    // It is also cheaper than wrapping this in useEffect, which would
    // require a full extra render + commit + effect cycle to achieve the
    // same result, and which React itself now warns against for this exact
    // shape ("Calling setState synchronously within an effect can trigger
    // cascading renders").
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