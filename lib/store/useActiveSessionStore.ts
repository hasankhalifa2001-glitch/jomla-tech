"use client";

import { create } from "zustand";

/**
 * Tracks which authenticated user THIS TAB last successfully resolved a
 * live session for.
 *
 * Deliberately plain in-memory Zustand state — NOT persisted to
 * localStorage/sessionStorage/IndexedDB, and NOT broadcast to other tabs.
 * A JS module's state is inherently scoped to the single tab that loaded
 * it, which is exactly the isolation this needs: on a shared shop device
 * where different cashiers log in and out of the same browser across
 * shifts (see lib/offline/session-cache.ts's file-header note), a
 * device-wide store like localStorage would let a second tab's login
 * silently overwrite what a first, still-open tab believes its own
 * identity is. Plain Zustand state (no persist middleware) never has
 * that problem, because there is nothing here for a second tab to write
 * over — each tab gets its own JS heap and therefore its own store
 * instance.
 *
 * This is intentionally NOT a source of truth for anything
 * authorization-related — the actual claims always come from either a
 * live useSession() resolution or, offline, from
 * lib/offline/session-cache.ts's cachedSession table (never trusted
 * server-side either way; see that file's own authorization note). This
 * store exists solely so that IF this tab's live useSession() call fails
 * while offline, useSessionWithOfflineFallback() has a userId to look up
 * in the offline cache instead of guessing at "whichever session happens
 * to be cached on this device." If this tab never resolved a live
 * session (e.g. it was opened directly while already offline),
 * currentUserId stays null and the fallback correctly reports "identity
 * unknown" rather than assuming any cached row belongs to it.
 */
interface ActiveSessionState {
    currentUserId: string | null;
    setCurrentUserId: (userId: string | null) => void;
}

export const useActiveSessionStore = create<ActiveSessionState>((set) => ({
    currentUserId: null,
    setCurrentUserId: (userId) => set({ currentUserId: userId }),
}));