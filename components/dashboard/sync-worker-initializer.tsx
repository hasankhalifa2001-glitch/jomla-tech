"use client";

import { useSession } from "next-auth/react";
import { useSyncWorker } from "@/lib/offline/sync-worker";

/**
 * Mounts the T4c background sync worker for the signed-in tenant so pending
 * Dexie records are pushed to /api/sync within 5 seconds of reconnection.
 *
 * [FIX] Previously called `useSyncWorker(session?.user?.tenantId)`
 * unconditionally, so an EXPIRED/PENDING tenant's client would still fire a
 * sync request on every reconnection — /api/sync correctly rejects it with
 * 403 and the item stays PENDING (no data-correctness issue), but it's a
 * wasted round trip on every reconnect for a tenant that is already known,
 * client-side, to be locked out. Gated on subscriptionStatus === "ACTIVE"
 * so a locked-out tenant simply doesn't attempt sync until an admin
 * resolves the subscription and this session is refreshed via update().
 */
export function SyncWorkerInitializer() {
  const { data: session } = useSession();
  const tenantId =
    session?.user?.subscriptionStatus === "ACTIVE" ? session.user.tenantId : undefined;
  useSyncWorker(tenantId);
  return null;
}