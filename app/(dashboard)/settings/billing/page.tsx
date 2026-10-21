"use client";

import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { BillingCheckout } from "@/components/billing/checkout";

/**
 * Accepted deviation from the role matrix: CASHIERs do NOT receive a 403 on
 * this page. Instead, middleware.ts redirects a CASHIER who navigates to
 * /settings/billing to /pos?error=unauthorized (see middleware.ts:240-247).
 * This page itself performs no server-side ADMIN check — that enforcement
 * lives in the API routes (assertAdmin) and the middleware redirect.
 */
export default function BillingSettingsPage() {
  const { data: session } = useSessionWithOfflineFallback();
  return (
    <BillingCheckout
      tenantName={session?.tenantName ?? null}
      tenantSlug={session?.tenantSlug ?? null}
      role={session?.role ?? null}
    />
  );
}
