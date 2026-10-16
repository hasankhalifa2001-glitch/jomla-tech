import { getTenantDb } from "@/lib/db/tenant-scope";

export const PLATFORM_TENANT_SLUG = "platform-internal";

/**
 * The ONLY reader of the platform exchange rate (D3). Reads one field of the
 * single "platform-internal" tenant row, selected by the constant slug.
 * NEVER read the merchant's own Tenant.dailyExchangeRate for subscription
 * pricing: a merchant can edit that value from the top bar.
 *
 * If the tenant-scope extension forces `id = callerTenantId` on the Tenant
 * model, this lookup finds nothing (returns null => checkout blocked, safe
 * failure). In that case T6b's narrow platform gateway replaces this reader.
 */
export async function getPlatformExchangeRate(
    callerTenantId: string
): Promise<string | null> {
    const db = getTenantDb(callerTenantId);
    const row = await db.tenant.findUnique({
        where: { slug: PLATFORM_TENANT_SLUG },
        select: { dailyExchangeRate: true },
    });
    return row?.dailyExchangeRate != null ? row.dailyExchangeRate.toString() : null;
}