"use client";

import { useEffect } from "react";

/**
 * ServiceWorkerRegister — Registers the PWA service worker in production
 * environments.
 *
 * [FIX] The guard is against NODE_ENV === "development" ONLY (mirrors
 * next-pwa's own default: `disable: process.env.NODE_ENV === "development"`,
 * per T4a2's spec). A separate hostname === "localhost" check was
 * previously OR'd in here as well — that's a stricter condition than the
 * spec calls for, and it silently blocks the Service Worker from ever
 * registering during a LOCAL PRODUCTION BUILD TEST (`npm run build &&
 * npm run start`), which is normally tested on localhost before deploy.
 * The whole point of a production-build smoke test is to verify the SW
 * actually registers and precaches — this guard made that impossible to
 * ever observe locally. Removed.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    if (process.env.NODE_ENV === "development") {
      return;
    }

    const registerSW = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });

        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (installingWorker) {
            installingWorker.addEventListener("statechange", () => {
              if (
                installingWorker.state === "installed" &&
                navigator.serviceWorker.controller
              ) {
                console.log("[SW] New version installed and ready for next navigation.");
              }
            });
          }
        });
      } catch (err) {
        console.error("[SW] Service worker registration failed:", err);
      }
    };

    if (document.readyState === "complete") {
      registerSW();
    } else {
      window.addEventListener("load", registerSW, { once: true });
    }
  }, []);

  return null;
}