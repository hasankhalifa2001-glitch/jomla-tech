/**
 * lib/utils/store-href.ts
 *
 * T5a - single source of truth for building store URLs. The storefront is
 * reachable under a path (/store/<slug>/...) today; the same links must keep
 * working if the deployment later serves each store on its own subdomain
 * (<slug>.<domain>/...). Routing every internal link, canonical/OG URL and the
 * WhatsApp text through storeHref() means that switch is a change in ONE place,
 * not a scavenger hunt across pages.
 *
 * storePath(slug, path?)  -> the path portion, e.g. "/store/acme/products".
 * storeHref(slug, path?)  -> absolute URL when an origin is known, else the
 *                           path portion (safe for <Link href> and metadata).
 */

export function storePath(slug: string, path = ""): string {
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const base = `/store/${encodeURIComponent(slug)}`;
  return clean ? `${base}/${clean}` : base;
}

/**
 * Absolute store URL. `origin` should be a scheme+host (no trailing slash),
 * e.g. NEXT_PUBLIC_APP_URL or the incoming request origin. When omitted,
 * returns the path portion (correct for <Link>, canonical tags resolve it
 * against metadataBase, and the WhatsApp link is only ever built client-side
 * where window.location.origin is available).
 */
export function storeHref(slug: string, path = "", origin?: string): string {
  const p = storePath(slug, path);
  if (!origin) return p;
  return `${origin.replace(/\/+$/, "")}${p}`;
}