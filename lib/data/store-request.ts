import { cache } from "react";
import { resolveStorefrontTenant } from "@/lib/data/store";

/**
 * generateMetadata() and the page both need the tenant. React's cache() memoizes
 * ONE request only (it is NOT a cross-request cache), so the gate stays a fresh
 * DB read per visit (spec §6.1/§6.10) while the two calls share a single read.
 */
export const resolveStorefrontTenantOnce = cache(resolveStorefrontTenant);