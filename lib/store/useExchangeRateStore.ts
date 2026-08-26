"use client";

import { create } from "zustand";

interface ExchangeRateState {
    dailyExchangeRate: number | null;
    isUpdating: boolean;
    error: string | null;
    setExchangeRate: (rate: number | null) => void;
    updateExchangeRate: (newRate: number) => Promise<boolean>;
}

export const useExchangeRateStore = create<ExchangeRateState>((set) => ({
    dailyExchangeRate: null,
    isUpdating: false,
    error: null,
    setExchangeRate: (rate) => set({ dailyExchangeRate: rate, error: null }),
    updateExchangeRate: async (newRate: number) => {
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
}));
