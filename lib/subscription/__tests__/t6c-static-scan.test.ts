/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * T6c — Static scan: enforce that no code outside
 * `lib/subscription/effective-status.ts` compares `subscriptionStatus` or
 * `expiresAt` directly. All status/lock decisions must flow through
 * `getEffectiveTenantStatus()`.
 *
 * Also verifies the middleware's mirror grace-days constant stays aligned
 * with `SUBSCRIPTION_GRACE_DAYS` (the static scan test fails if they drift).
 *
 * MOCKED: none — reads source files directly via fs.
 * REAL: fs reads + regex scanning.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const HELPER_FILE = path.join(ROOT, "lib/subscription/effective-status.ts");

// Files explicitly sanctioned to contain direct subscriptionStatus/expiresAt
// comparisons (mirror implementations, display-only reads, expiry computation).
const SANCTIONED_FILES = new Set([
  "middleware.ts", // Edge-safe mirror; documented, T6C_GRACE_DAYS_MS checked below
  "lib/data/platform-admin.ts", // Expiry computation (previewNewExpiry), not status gating
  "app/(locked)/account-locked/page.tsx", // Display-only: reads session status for UI text
  "app/api/tenant/status/route.ts", // Display-only: returns effective status payload
  "app/api/billing/status/route.ts", // Display-only: returns effective status payload
  "components/dashboard/sync-worker-initializer.tsx", // Client-side init hint only (stale JWT OK); server gating via assertTenantWritable
]);

// Patterns that indicate a direct comparison of subscriptionStatus or expiresAt
// (i.e., NOT going through getEffectiveTenantStatus()).
const DIRECT_COMPARISON_PATTERNS = [
  // subscriptionStatus compared directly to a string literal
  /subscriptionStatus\s*===\s*["'](ACTIVE|PENDING|EXPIRED)["']/,
  /subscriptionStatus\s*!==\s*["'](ACTIVE|PENDING|EXPIRED)["']/,
  /\.\s*subscriptionStatus\s*===\s*["'](ACTIVE|PENDING|EXPIRED)["']/,
  /\.\s*subscriptionStatus\s*!==\s*["'](ACTIVE|PENDING|EXPIRED)["']/,
  // expiresAt compared with relational operators or .getTime() for gating
  /\.expiresAt\s*<\s*now/,
  /\.expiresAt\s*>\s*now/,
  /\.expiresAt\s*<=\s*now/,
  /\.expiresAt\s*>=\s*now/,
  /\.expiresAt\.getTime\(\)\s*[<>]=?/,
  /now\s*[<>]=?\s*\.expiresAt/,
];

// Middleware grace-days constant must match SUBSCRIPTION_GRACE_DAYS × DAY_MS
const MIDDLEWARE_FILE = path.join(ROOT, "middleware.ts");
const SUBSCRIPTION_CONFIG_FILE = path.join(
  ROOT,
  "lib/config/subscription.ts"
);

function listSourceFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".next" ||
          entry.name === ".git"
        ) {
          continue;
        }
        walk(full);
      } else if (entry.name.match(/\.(ts|tsx)$/)) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function relativePath(full: string): string {
  return path.relative(ROOT, full).replace(/\\/g, "/");
}

describe("T6c — static scan", () => {
  it("no direct subscriptionStatus/expiresAt comparison outside the helper", () => {
    const files = listSourceFiles(ROOT);
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of files) {
      const rel = relativePath(file);

      // Skip sanctioned files and the helper itself.
      if (SANCTIONED_FILES.has(rel)) continue;
      if (rel === "lib/subscription/effective-status.ts") continue;
      if (rel.startsWith("lib/subscription/__tests__/")) continue;
      if (rel.startsWith("lib/auth/__tests__/")) continue;
      if (rel.startsWith("app/api/sync/__tests__/")) continue;
      if (rel.endsWith(".test.ts")) continue;
      if (rel.endsWith(".test.tsx")) continue;

      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of DIRECT_COMPARISON_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              file: rel,
              line: i + 1,
              match: line.trim().slice(0, 120),
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  ${v.file}:${v.line} — ${v.match}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} direct subscriptionStatus/expiresAt comparison(s) outside getEffectiveTenantStatus():\n${detail}`
      );
    }
  });

  it("middleware T6C_GRACE_DAYS_MS matches SUBSCRIPTION_GRACE_DAYS × DAY_MS", () => {
    const middleware = fs.readFileSync(MIDDLEWARE_FILE, "utf8");
    const config = fs.readFileSync(SUBSCRIPTION_CONFIG_FILE, "utf8");

    const middlewareMatch = middleware.match(
      /T6C_GRACE_DAYS_MS\s*=\s*(\d+)\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/
    );
    const configMatch = config.match(
      /SUBSCRIPTION_GRACE_DAYS\s*=\s*(\d+)/
    );

    expect(middlewareMatch).not.toBeNull();
    expect(configMatch).not.toBeNull();

    const middlewareGraceDays = parseInt(middlewareMatch![1], 10);
    const configGraceDays = parseInt(configMatch![1], 10);
    expect(middlewareGraceDays).toBe(configGraceDays);
  });
});