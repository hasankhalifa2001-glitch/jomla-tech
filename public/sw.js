/**
 * Jomla Tech — Service Worker (T4a2)
 */

const SW_VERSION = "jomla-pwa-v1.0.1";
const PRECACHE_NAME = `jomla-precache-${SW_VERSION}`;
const STATIC_CACHE_NAME = `jomla-static-${SW_VERSION}`;
const RUNTIME_CACHE_NAME = `jomla-runtime-${SW_VERSION}`;

const CURRENT_CACHES = [PRECACHE_NAME, STATIC_CACHE_NAME, RUNTIME_CACHE_NAME];

const PRECACHE_URLS = [
  "/offline",
  "/dashboard",
  "/pos",
  "/inventory",
  "/ledger",
  "/orders",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE_NAME).then(async (cache) => {
      const promises = PRECACHE_URLS.map(async (url) => {
        try {
          const response = await fetch(url, { credentials: "same-origin" });
          if (response && response.ok && response.type === "basic" && !response.redirected) {
            await cache.put(url, response);
          }
        } catch (err) {
          console.warn(`[SW] Precache skipped for: ${url}`, err);
        }
      });
      return Promise.all(promises);
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (!CURRENT_CACHES.includes(key)) {
              console.log(`[SW] Purging stale cache: ${key}`);
              return caches.delete(key);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isCacheableStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/static/") ||
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com") ||
    /\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|svg|ico|webp)$/i.test(url.pathname)
  );
}

async function safeCachePut(cacheName, request, response) {
  try {
    if (!response || !response.ok || response.type !== "basic" || response.redirected) return;
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch (err) {
    console.warn("[SW] Skipped cache.put:", err);
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (!url.protocol.startsWith("http")) return;

  // Never touch anything that isn't a plain GET — POSTed Server Actions,
  // NextAuth callback POSTs, and any other non-GET request must pass
  // straight through untouched. Cache.put() throws synchronously for a
  // non-GET request; that throw previously happened inside a .then()
  // success handler (not the surrounding .catch()), producing an
  // unhandled rejection that surfaced to the browser as ERR_FAILED on
  // the very next navigation.
  if (request.method !== "GET") return;

  // Never intercept Next.js's own internal RSC/prefetch data requests —
  // these are not full HTML documents, must never be cached or replayed
  // as if they were, and interfering with them breaks App Router's own
  // navigation/hydration machinery in ways that surface as ERR_FAILED or
  // a broken/blank shell after reload.
  if (
    request.headers.has("RSC") ||
    request.headers.has("Next-Router-Prefetch") ||
    request.headers.has("Next-Router-State-Tree") ||
    request.headers.has("Next-Action")
  ) {
    return;
  }

  // RULE 1: /api/* is NETWORK-ONLY.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // RULE 2: JS/CSS bundles, fonts, static assets -> CACHE-FIRST.
  if (isCacheableStaticAsset(url)) {
    event.respondWith(
      (async () => {
        try {
          const cached = await caches.match(request);
          if (cached) return cached;

          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            await safeCachePut(STATIC_CACHE_NAME, request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          console.warn("[SW] Static asset fetch failed, no cache available:", err);
          // Let the browser report its own native network error for
          // this sub-resource instead of fabricating a fake 408 Response
          // — a synthetic Response for a JS/CSS file can be parsed as
          // valid-but-empty content, which is a worse failure mode
          // (silent broken functionality) than a normal, visible network
          // error the browser already knows how to surface correctly.
          throw err;
        }
      })()
    );
    return;
  }

  // RULE 3: HTML page navigations -> NETWORK-FIRST, falling back to a
  // cached copy, then to /offline. Deliberately network-first rather
  // than stale-while-revalidate: these precached routes are
  // authenticated, per-session pages (T4a2's session-leak fix, which
  // strips tenant/session data from the server-rendered shell itself,
  // is a separate, not-yet-verified precondition) — serving a
  // potentially stale/wrong cached copy FIRST on every normal online
  // load is riskier than a brief network round-trip, and was the direct
  // cause of the reload failure this revision fixes: caching a redirect
  // or a transient error response as if it were a valid dashboard shell,
  // then replaying that same broken response on every subsequent load
  // until the cache was manually cleared.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            await safeCachePut(RUNTIME_CACHE_NAME, request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          console.warn("[SW] Navigation fetch failed, falling back to cache:", err);
          try {
            const cached = await caches.match(request);
            if (cached) return cached;
            const offlineFallback = await caches.match("/offline");
            if (offlineFallback) return offlineFallback;
          } catch (cacheErr) {
            console.warn("[SW] Offline fallback lookup failed:", cacheErr);
          }
          throw err;
        }
      })()
    );
    return;
  }
});