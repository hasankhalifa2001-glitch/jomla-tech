"use client";

import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { BillingCheckout } from "@/components/billing/checkout";

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
