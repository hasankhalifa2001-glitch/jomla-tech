"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Tracks which authenticated user THIS TAB last successfully resolved a
 * live session for.
 *
 * [FIX — review pass] Previously plain in-memory Zustand state with NO
 * persist middleware at all. That made currentUserId reset to null on
 * every page reload — which defeated the entire purpose of this store,
 * since T4a2's core scenarios (reload / crash / cold-start while
 * offline) are reloads by definition. A reload wipes the JS heap before
 * useSessionWithOfflineFallback() ever gets a chance to read
 * currentUserId, so the fallback path always reported "unreachable"
 * instead of "offline-cached" on the exact scenarios this whole
 * mechanism exists for.
 *
 * FIX: persist to `sessionStorage` (via createJSONStorage), NOT
 * `localStorage`. This preserves the original per-tab isolation reasoning
 * below — sessionStorage is scoped to a single tab/window, never shared
 * across tabs even on the same origin, and is cleared automatically when
 * that tab closes — while surviving the one event the original design
 * missed: a reload of that same tab. This does not reintroduce the
 * cross-tab leak a localStorage-backed store would: a second tab logging
 * in still cannot overwrite what a first, still-open tab believes its
 * own identity is, because each tab has its own independent
 * sessionStorage, exactly as it has its own independent JS heap today.
 *
 * Deliberately NOT persisted to localStorage/IndexedDB, and NOT
 * broadcast to other tabs. On a shared shop device where different
 * cashiers log in and out of the same browser across shifts (see
 * lib/offline/session-cache.ts's file-header note), a device-wide store
 * like localStorage would let a second tab's login silently overwrite
 * what a first, still-open tab believes its own identity is.
 * sessionStorage-backed Zustand state never has that problem, because
 * there is nothing here for a second tab to write over — each tab gets
 * its own sessionStorage instance, just as it always got its own JS heap.
 *
 * This is intentionally NOT a source of truth for anything
 * authorization-related — the actual claims always come from either a
 * live useSession() resolution or, offline, from
 * lib/offline/session-cache.ts's cachedSession table (never trusted
 * server-side either way; see that file's own authorization note). This
 * store exists solely so that IF this tab's live useSession() call fails
 * while offline (including after a reload of this same tab),
 * useSessionWithOfflineFallback() has a userId to look up in the offline
 * cache instead of guessing at "whichever session happens to be cached
 * on this device." If this tab never resolved a live session (e.g. it
 * was opened directly while already offline, in a fresh tab that has
 * never persisted anything to its own sessionStorage), currentUserId
 * stays null and the fallback correctly reports "identity unknown"
 * rather than assuming any cached row belongs to it.
 */
interface ActiveSessionState {
    currentUserId: string | null;
    setCurrentUserId: (userId: string | null) => void;
}

export const useActiveSessionStore = create<ActiveSessionState>()(
    persist(
        (set) => ({
            currentUserId: null,
            setCurrentUserId: (userId) => set({ currentUserId: userId }),
        }),
        {
            name: "jomla-active-session-tab", // sessionStorage key
            storage: createJSONStorage(() => sessionStorage),
            // Only currentUserId is ever persisted — this store has no other
            // fields today, but if one is added later that should NOT survive
            // a reload (e.g. a transient UI flag), partialize here rather than
            // assuming "whatever's in state" is safe to persist.
            partialize: (state) => ({ currentUserId: state.currentUserId }),
        }
    )
);