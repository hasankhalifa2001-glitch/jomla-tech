import * as React from "react"

import { MOBILE_BREAKPOINT_PX } from "@/lib/constants/breakpoints"

/**
 * Returns whether the viewport is currently below the mobile breakpoint.
 *
 * ⚠️ SCOPE: use this ONLY when a component needs to mount a genuinely
 * different implementation on mobile vs desktop — e.g. T4b's POS cart
 * rendering as a bottom Sheet on mobile vs a persistent side panel on
 * desktop, where the two are different component trees, not the same
 * markup toggled by CSS.
 *
 * For anything that's really just "show/hide this" or "change the number
 * of columns," use Tailwind's responsive classes directly (`hidden
 * md:flex`, `grid-cols-1 md:grid-cols-2`, etc.) instead of this hook. CSS
 * media queries apply before any JS runs, so they never have the
 * first-paint problem this hook has (see below) — and per the spec's
 * Global UI/UX section, responsive layout across T2/T3/T4b is meant to be
 * driven by standard breakpoints, not a JS mobile/desktop branch by
 * default.
 *
 * IMPLEMENTATION NOTE — why useSyncExternalStore instead of
 * useState+useEffect: `window.matchMedia` is external, mutable state
 * React doesn't own, which is exactly what `useSyncExternalStore` exists
 * for. It replaces the earlier `useState` + `useEffect` version, which
 * called `setIsMobile(...)` synchronously in the effect body to seed the
 * initial value on mount — a pattern React's tooling now flags ("Calling
 * setState synchronously within an effect can trigger cascading
 * renders"), because it's functionally a second, avoidable render that
 * only exists to answer "what does the external system say right now,"
 * which is precisely `useSyncExternalStore`'s `getSnapshot` job.
 * `getServerSnapshot` covers the server-render case (no `window`),
 * returning `false` so SSR output and the pre-hydration client render
 * agree — matching the previous `undefined -> false` initial state, just
 * without a manual effect doing that work.
 *
 * ⚠️ FIRST-PAINT CAVEAT (unchanged from before): the real viewport value
 * is only known after hydration on the client. Any component that
 * branches its JSX on this hook's return value can render the desktop
 * variant for one frame on a mobile device before correcting itself —
 * most visible on a slower device or an offline-first PWA cold start
 * (exactly T4b's cashier-on-a-phone scenario). If that flash is a problem
 * for a given component, prefer the CSS approach above instead of trying
 * to fix the flash here.
 */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

function subscribe(onStoreChange: () => void): () => void {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`)
  mql.addEventListener("change", onStoreChange)
  return () => mql.removeEventListener("change", onStoreChange)
}

function getSnapshot(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT_PX
}

function getServerSnapshot(): boolean {
  // No viewport exists on the server. Defaulting to `false` (desktop)
  // matches this hook's previous pre-hydration behavior (`!!undefined`)
  // so SSR markup and the first client render agree — the real value
  // takes over as soon as the client subscribes.
  return false
}