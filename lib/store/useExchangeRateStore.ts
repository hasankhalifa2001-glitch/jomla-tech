/* useExchangeRateStore.ts */
"use client";

import { create } from "zustand";
import { setCachedDailyExchangeRate, getCachedDailyExchangeRate } from "@/lib/offline";

// FIX: matches the shape of next-auth's useSession().update — passed in by
// the calling component (Zustand stores are plain JS, not React hooks, so
// this can't import useSession() directly). See ExchangeRateTopbar below
// for the call site.
type SessionUpdateFn = (data: { dailyExchangeRate?: number | null }) => Promise<unknown>;

interface ExchangeRateState {
    dailyExchangeRate: number | null;
    isUpdating: boolean;
    error: string | null;
    setExchangeRate: (rate: number | null, tenantId?: string) => void;
    updateExchangeRate: (
        newRate: number,
        tenantId?: string,
        syncSession?: SessionUpdateFn
    ) => Promise<boolean>;
    hydrateFromCache: (tenantId?: string) => Promise<number | null>;
}

export const useExchangeRateStore = create<ExchangeRateState>((set, get) => ({
    dailyExchangeRate: null,
    isUpdating: false,
    error: null,
    setExchangeRate: (rate, tenantId) => {
        set({ dailyExchangeRate: rate, error: null });
        if (rate !== null && rate > 0) {
            void setCachedDailyExchangeRate(rate, tenantId);
        }
    },
    updateExchangeRate: async (newRate: number, tenantId?: string, syncSession?: SessionUpdateFn) => {
        if (isNaN(newRate) || newRate <= 0) {
            set({ error: "يرجى إدخال سعر صرف صحيح بأرقام أكبر من الصفر." });
            return false;
        }

        set({ isUpdating: true, error: null });
        try {
            const response = await fetch("/api/tenant/exchange-rate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rate: newRate }),
            });

            const data = await response.json();

            if (!response.ok) {
                set({
                    error: data.message || "فشل تحديث سعر الصرف اليومي.",
                    isUpdating: false,
                });
                return false;
            }

            set({ dailyExchangeRate: newRate, isUpdating: false, error: null });
            void setCachedDailyExchangeRate(newRate, tenantId);

            // FIX: keep this device's JWT/session in sync with the DB value
            // that was just written, using the trigger mechanism auth.ts's
            // jwt() callback already implements for exactly this field.
            // Best-effort: a failure here doesn't roll back the DB write
            // (already succeeded above) or block the UI, since
            // useExchangeRateStore itself is already the correct-value
            // source of truth for THIS device — this only prevents *other*
            // parts of the app that read useSession() directly from
            // showing a stale rate on this same device.
            if (syncSession) {
                try {
                    await syncSession({ dailyExchangeRate: newRate });
                } catch (syncErr) {
                    console.error("Failed to sync session after exchange rate update:", syncErr);
                }
            }

            return true;
        } catch (err) {
            console.error("Failed to update exchange rate:", err);
            set({
                error: "حدث خطأ في الاتصال أثناء تحديث سعر الصرف.",
                isUpdating: false,
            });
            return false;
        }
    },
    hydrateFromCache: async (tenantId?: string) => {
        try {
            const cached = await getCachedDailyExchangeRate(tenantId);
            if (cached !== null && get().dailyExchangeRate === null) {
                set({ dailyExchangeRate: cached });
            }
            return cached;
        } catch {
            return null;
        }
    },
}));