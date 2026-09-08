/* useExchangeRateStore.ts */
"use client";

import { create } from "zustand";
import { setCachedDailyExchangeRate, getCachedDailyExchangeRate } from "@/lib/offline";

// FIX: matches the shape of next-auth's useSession().update — passed in by
// the calling component (Zustand stores are plain JS, not React hooks, so
// this can't import useSession() directly). See ExchangeRateTopbar below
// for the call site.
type SessionUpdateFn = (data: { dailyExchangeRate?: number | null }) => Promise<unknown>;

export const EXCHANGE_RATE_BROADCAST_CHANNEL = "jomla_exchange_rate_sync";

interface BroadcastSyncMessage {
    type: "EXCHANGE_RATE_SYNC";
    rate: number | null;
    tenantId?: string;
}

interface ExchangeRateState {
    dailyExchangeRate: number | null;
    // FIX: the store now tracks which tenant it's currently scoped to, so
    // the broadcast listener has something to check an incoming message
    // against. BroadcastChannel fires at the browser-origin level, not
    // per-tab — without this, an update from a different tenant's tab open
    // on the same device/browser would silently overwrite this tab's rate.
    currentTenantId: string | null;
    isUpdating: boolean;
    error: string | null;
    setExchangeRate: (rate: number | null, tenantId?: string, broadcast?: boolean) => void;
    updateExchangeRate: (
        newRate: number,
        tenantId?: string,
        syncSession?: SessionUpdateFn
    ) => Promise<boolean>;
    hydrateFromCache: (tenantId?: string) => Promise<number | null>;
    // FIX: explicit setter so the owning component can register which
    // tenant this tab belongs to as soon as the session is known — needed
    // before the tenantId guard below has anything to compare against.
    setCurrentTenantId: (tenantId: string | null) => void;
}

// Global broadcast channel instance for multi-tab live sync on the same device
let broadcastChannel: BroadcastChannel | null = null;
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    try {
        broadcastChannel = new BroadcastChannel(EXCHANGE_RATE_BROADCAST_CHANNEL);
    } catch {
        broadcastChannel = null;
    }
}

function broadcastRateChange(rate: number | null, tenantId?: string) {
    if (broadcastChannel) {
        try {
            broadcastChannel.postMessage({
                type: "EXCHANGE_RATE_SYNC",
                rate,
                tenantId,
            } satisfies BroadcastSyncMessage);
        } catch (err) {
            console.warn("Failed to broadcast exchange rate change to other tabs:", err);
        }
    }
}

export const useExchangeRateStore = create<ExchangeRateState>((set, get) => {
    if (typeof window !== "undefined" && broadcastChannel) {
        broadcastChannel.onmessage = (event: MessageEvent<BroadcastSyncMessage>) => {
            if (event.data?.type === "EXCHANGE_RATE_SYNC") {
                const incomingRate = event.data.rate;
                const incomingTenantId = event.data.tenantId;

                // FIX: reject cross-tenant broadcasts. BroadcastChannel is
                // origin-scoped, not tab-scoped — without this check, a
                // rate update from Tenant A's tab would leak into Tenant
                // B's tab if both are open on the same device/browser.
                // A message with no tenantId is treated as untrusted and
                // dropped rather than assumed to match, since silently
                // accepting an unscoped update reopens the same leak.
                const currentTenantId = get().currentTenantId;
                if (!incomingTenantId || incomingTenantId !== currentTenantId) {
                    return;
                }

                set({ dailyExchangeRate: incomingRate, error: null });

                if (incomingRate !== null && incomingRate > 0) {
                    setCachedDailyExchangeRate(incomingRate, incomingTenantId).catch((err) => {
                        console.error("Failed to cache broadcasted daily exchange rate in Dexie:", err);
                    });
                }
            }
        };
    }

    return {
        dailyExchangeRate: null,
        currentTenantId: null,
        isUpdating: false,
        error: null,
        setCurrentTenantId: (tenantId) => set({ currentTenantId: tenantId }),
        setExchangeRate: (rate, tenantId, broadcast = false) => {
            set({ dailyExchangeRate: rate, error: null });
            if (rate !== null && rate > 0) {
                setCachedDailyExchangeRate(rate, tenantId).catch((err) => {
                    console.error("Failed to cache daily exchange rate locally:", err);
                });
            }
            if (broadcast) {
                broadcastRateChange(rate, tenantId);
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

                // [FIX — unhandled rejection, same reasoning as setExchangeRate
                // above] `newRate` is already validated positive above, so this
                // shouldn't reject today — but it's now a throwing function, and
                // a bare `void` on it is fragile the same way. Caught and
                // logged rather than surfaced: the server write (the actual
                // source of truth) already succeeded by this point, so a local
                // cache-write failure must never flip this call's overall
                // result to `false` or overwrite the success state set above.
                try {
                    await setCachedDailyExchangeRate(newRate, tenantId);
                } catch (cacheErr) {
                    console.error("Failed to cache daily exchange rate locally:", cacheErr);
                }

                // Broadcast to other tabs on the same device
                broadcastRateChange(newRate, tenantId);

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
    };
});