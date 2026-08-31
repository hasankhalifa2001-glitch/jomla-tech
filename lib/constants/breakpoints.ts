/**
 * Single source of truth for the mobile/desktop split used across the app.
 *
 * MUST stay equal to Tailwind's `md` breakpoint (the default Tailwind `md`
 * value is 768px — if tailwind.config's theme.screens.md is ever
 * customized, update this constant in the same change). Every CSS-driven
 * responsive class (`md:flex`, `hidden md:block`, etc.) and every
 * JS-driven check (useIsMobile, below) must agree on the same pixel value,
 * or a viewport width can exist where Tailwind's CSS says "desktop" while
 * JS still thinks "mobile" (or vice versa) — e.g. a component mounts the
 * wrong variant at a width CSS would have styled differently.
 */
export const MOBILE_BREAKPOINT_PX = 768;