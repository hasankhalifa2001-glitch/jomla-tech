"use client";

import { create } from "zustand";
import { setCachedDailyExchangeRate, getCachedDailyExchangeRate } from "@/lib/offline";

interface ExchangeRateState {
    dailyExchangeRate: number | null;
    isUpdating: boolean;
    error: string | null;
    setExchangeRate: (rate: number | null, tenantId?: string) => void;
    updateExchangeRate: (newRate: number, tenantId?: string) => Promise<boolean>;
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
    updateExchangeRate: async (newRate: number, tenantId?: string) => {
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
            // Cache locally in Dexie whenever updated online
            void setCachedDailyExchangeRate(newRate, tenantId);
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
