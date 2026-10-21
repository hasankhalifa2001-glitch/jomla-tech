import { describe, it, expect } from "vitest";
import { getEffectiveTenantStatus } from "@/lib/subscription/effective-status";
import { SUBSCRIPTION_GRACE_DAYS } from "@/lib/config/subscription";

describe("T6c helper: getEffectiveTenantStatus boundaries", () => {
    const expiresAt = new Date("2026-11-01T00:00:00.000Z");
    const lockAt = new Date(expiresAt.getTime() + SUBSCRIPTION_GRACE_DAYS * 86400e3);

    it("now == expiresAt is still ACTIVE", () => {
        const r = getEffectiveTenantStatus({ subscriptionStatus: "ACTIVE", expiresAt }, expiresAt);
        expect(r.status).toBe("ACTIVE");
        expect(r.writable).toBe(true);
    });
    it("just after expiresAt is GRACE (writable)", () => {
        const r = getEffectiveTenantStatus({ subscriptionStatus: "ACTIVE", expiresAt }, new Date(expiresAt.getTime() + 1));
        expect(r.status).toBe("GRACE");
        expect(r.writable).toBe(true);
    });
    it("now == lockAt is still GRACE; +1ms is EXPIRED", () => {
        expect(getEffectiveTenantStatus({ subscriptionStatus: "ACTIVE", expiresAt }, lockAt).status).toBe("GRACE");
        const r = getEffectiveTenantStatus({ subscriptionStatus: "ACTIVE", expiresAt }, new Date(lockAt.getTime() + 1));
        expect(r.status).toBe("EXPIRED");
        expect(r.writable).toBe(false);
    });
    it("null expiresAt ACTIVE; PENDING locked; unknown status fails closed", () => {
        expect(getEffectiveTenantStatus({ subscriptionStatus: "ACTIVE", expiresAt: null }).status).toBe("ACTIVE");
        expect(getEffectiveTenantStatus({ subscriptionStatus: "PENDING", expiresAt: null }).writable).toBe(false);
        expect(getEffectiveTenantStatus({ subscriptionStatus: null, expiresAt: null }).status).toBe("EXPIRED");
    });
});