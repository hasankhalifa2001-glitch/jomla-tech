import { describe, it, expect } from "vitest";
import { getEffectiveTenantStatus } from "@/lib/subscription/effective-status";
import { SUBSCRIPTION_GRACE_DAYS } from "@/lib/config/subscription";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * T6c — truth table for getEffectiveTenantStatus (the single source of
 * truth). Covers exact boundaries (now == expiresAt, now == lockAt), null
 * expiresAt, and stored PENDING/EXPIRED.
 */
describe("T6c — getEffectiveTenantStatus truth table", () => {
  const expiresAt = new Date("2026-10-10T12:00:00.000Z");
  const lockAt = new Date(expiresAt.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS);

  it("stored PENDING → PENDING, never writable", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: "PENDING", expiresAt },
      new Date("2026-10-01T00:00:00.000Z")
    );
    expect(r.status).toBe("PENDING");
    expect(r.writable).toBe(false);
  });

  it("stored EXPIRED → EXPIRED even before expiry", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: "EXPIRED", expiresAt: new Date("2027-01-01T00:00:00.000Z") },
      new Date("2026-10-01T00:00:00.000Z")
    );
    expect(r.status).toBe("EXPIRED");
    expect(r.writable).toBe(false);
  });

  it("stored ACTIVE with null expiresAt → ACTIVE (platform-internal only)", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: "ACTIVE", expiresAt: null },
      new Date("2026-10-20T00:00:00.000Z")
    );
    expect(r.status).toBe("ACTIVE");
    expect(r.writable).toBe(true);
    expect(r.lockAt).toBeNull();
  });

  it("ACTIVE before expiry → ACTIVE with daysLeft", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: "ACTIVE", expiresAt },
      new Date(expiresAt.getTime() - DAY_MS)
    );
    expect(r.status).toBe("ACTIVE");
    expect(r.writable).toBe(true);
    expect(r.daysLeft).toBe(1);
    expect(r.lockAt?.getTime()).toBe(lockAt.getTime());
  });

  it("now == expiresAt → ACTIVE (boundary inclusive)", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: "ACTIVE", expiresAt },
      new Date(expiresAt.getTime())
    );
    expect(r.status).toBe("ACTIVE");
    expect(r.writable).toBe(true);
    expect(r.daysLeft).toBe(0);
  });

  it("just after expiry → GRACE with graceDaysLeft", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: "ACTIVE", expiresAt },
      new Date(expiresAt.getTime() + 1)
    );
    expect(r.status).toBe("GRACE");
    expect(r.writable).toBe(true);
    expect(r.graceDaysLeft).toBe(SUBSCRIPTION_GRACE_DAYS);
  });

  it("now == lockAt → GRACE (boundary inclusive)", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: "ACTIVE", expiresAt },
      new Date(lockAt.getTime())
    );
    expect(r.status).toBe("GRACE");
    expect(r.writable).toBe(true);
    expect(r.graceDaysLeft).toBe(0);
  });

  it("after lockAt → EXPIRED, not writable", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: "ACTIVE", expiresAt },
      new Date(lockAt.getTime() + 1)
    );
    expect(r.status).toBe("EXPIRED");
    expect(r.writable).toBe(false);
  });

  it("unknown/null stored status fails closed", () => {
    const r = getEffectiveTenantStatus(
      { subscriptionStatus: null, expiresAt },
      new Date(expiresAt.getTime() - DAY_MS)
    );
    expect(r.status).toBe("EXPIRED");
    expect(r.writable).toBe(false);
  });
});
