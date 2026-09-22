/* ExchangeRateTopbar.tsx */
"use client";

import { useEffect, useState } from "react";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import { formatMoney } from "@/lib/utils/money";
import { toast } from "sonner";
import { DollarSign, RefreshCw, CheckCircle2 } from "lucide-react";
import s from "./shell.module.css";

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
                { icon: <CheckCircle2 size={16} color="#10b981" /> }
            );
            setIsEditing(false);
        }
    };

    // CASHIER view: purely read-only value with zero input controls or buttons
    if (!isAdmin) {
        return (
            <div className={`${s.chip} ${s.rate}`}>
                <span className={s.rateIcon} aria-hidden>
                    <DollarSign size={15} />
                </span>
                <span className={s.rateLabel}>
                    <span className={s.onlyDesktop}>سعر الصرف اليومي:</span>
                    <span className={s.onlyMobile}>الصرف:</span>
                </span>
                {dailyExchangeRate ? (
                    <span className={s.rateValue}>
                        <span className={s.rateNum}>{formatMoney(dailyExchangeRate, "SYP", 0)}</span>
                        <span className={s.rateUnit}>ل.س / $</span>
                    </span>
                ) : (
                    <span className={s.rateNone}>غير محدد</span>
                )}
            </div>
        );
    }

    return (
        <form onSubmit={handleSave} className={`${s.chip} ${s.rate}`}>
            <span className={s.rateIcon} aria-hidden>
                <DollarSign size={15} />
            </span>
            <label htmlFor="daily-exchange-rate" className={s.rateLabel}>
                <span className={s.onlyMobile}>سعر الصرف:</span>
                <span className={s.onlyDesktop}>سعر الصرف اليومي (SYP/$):</span>
            </label>

            <div className={s.rateField}>
                <input
                    id="daily-exchange-rate"
                    type="number"
                    step="any"
                    inputMode="decimal"
                    placeholder="أدخل سعر اليوم..."
                    value={inputValue}
                    onChange={(e) => {
                        setInputValue(e.target.value);
                        setIsEditing(true);
                    }}
                    className={s.rateInput}
                    disabled={isUpdating}
                />

                <button
                    type="submit"
                    disabled={
                        isUpdating ||
                        inputValue.trim() === "" ||
                        isNaN(parseFloat(inputValue)) ||
                        (!isEditing && dailyExchangeRate === parseFloat(inputValue))
                    }
                    className={s.rateBtn}
                >
                    {isUpdating ? (
                        <RefreshCw size={14} className={s.spin} aria-label="جاري التحديث" />
                    ) : (
                        <span>تحديث</span>
                    )}
                </button>
            </div>
        </form>
    );
}