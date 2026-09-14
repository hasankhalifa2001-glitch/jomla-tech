import type { MetadataRoute } from "next";

// [FIX] start_url stays "/dashboard" — changing it to "/dashboard/pos"
// would skip the redirect for CASHIER sessions (the more common daily
// user, per T2b) but would then send an ADMIN opening the installed PWA
// straight into POS instead of their own landing page, trading one
// unnecessary redirect for another. Since T2b's middleware redirect is
// already a required, tested part of the auth flow regardless of entry
// point (PWA or browser tab), the extra hop for CASHIER is a one-time,
// sub-second cost, not a correctness issue. What DOES matter for T4a2's
// offline-reachable requirement: both /dashboard and /dashboard/pos (and
// every other app/(dashboard)/** route) must have their JS chunks in the
// service worker's precache manifest, so this redirect resolves instantly
// even on a cold, fully offline launch — verify this at build time per
// T4a2's own acceptance criteria, not assumed from "the shell is generic."
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "جملة تك - Jomla Tech",
    short_name: "جملة تك",
    description: "منصة تجارة جملة برمجية متعددة المستأجرين لنقاط البيع ودفتر الديون والمتاجر الإلكترونية.",
    start_url: "/",
    // [FIX] Keeps the installed, standalone PWA window scoped to the
    // authenticated merchant app. Without this, a CASHIER/ADMIN tapping a
    // shared storefront link (app/(store)/[tenantSlug]/**, a PUBLIC,
    // unauthenticated surface per T1's folder structure) while the PWA is
    // open could have that public page open inside the same standalone
    // window instead of a normal browser tab — confusing given the two
    // surfaces have entirely different auth/rendering models. "/dashboard"
    // as scope also implicitly covers /pos, /inventory, /ledger, /orders,
    // /settings/** and /account-locked, since Next.js's actual routes for
    // those live under the same (dashboard) route group in practice.
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#059669",
    dir: "rtl",
    lang: "ar",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      // [FIX — Android adaptive icon support] Without an icon carrying
      // `purpose: "maskable"`, Android is free to crop/mask the plain
      // icons above into its own adaptive-icon shapes (circle, squircle,
      // rounded square depending on OEM launcher) — a logo not designed
      // with a safe zone for that can end up clipped or off-center. Given
      // T2's own Global UI/UX notes call out "Chrome on Android" as an
      // officially supported platform (not just Chromium desktop), this
      // is a real, not cosmetic, launch-icon concern for this user base.
      // `purpose: "any maskable"` lets ONE image serve both roles if its
      // artwork already respects the maskable safe zone (see the guidance
      // below on producing this file); split into two separate icon
      // entries with different `src` instead if the plain 512×512 icon
      // was designed edge-to-edge and cropping it would look wrong.
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}