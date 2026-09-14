import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("T4a2 — PWA Shell & Offline Reachability (Service Worker)", () => {
  const rootDir = process.cwd();

  describe("1. Static Shell Precache & Scope Contract", () => {
    it("verifies public/sw.js exists and defines all required dashboard precache route shells", () => {
      const swPath = path.join(rootDir, "public", "sw.js");
      expect(fs.existsSync(swPath)).toBe(true);

      const swContent = fs.readFileSync(swPath, "utf-8");
      const requiredRoutes = [
        "/offline",
        "/dashboard",
        "/pos",
        "/dashboard/pos",
        "/inventory",
        "/dashboard/inventory",
        "/ledger",
        "/dashboard/ledger",
        "/orders",
        "/dashboard/orders",
      ];

      for (const route of requiredRoutes) {
        expect(swContent).toContain(route);
      }
    });

    it("verifies offline fallback page app/offline/page.tsx exists and provides Arabic RTL links", () => {
      const offlinePath = path.join(rootDir, "app", "offline", "page.tsx");
      expect(fs.existsSync(offlinePath)).toBe(true);

      const offlineContent = fs.readFileSync(offlinePath, "utf-8");
      expect(offlineContent).toContain("أنت غير متصل بالإنترنت");
      expect(offlineContent).toContain("/pos");
      expect(offlineContent).toContain("/dashboard");
      expect(offlineContent).toContain("/inventory");
      expect(offlineContent).toContain("/ledger");
      expect(offlineContent).toContain("/orders");
      expect(offlineContent).toContain('dir="rtl"');
    });

    it("verifies Web App Manifest is configured with Arabic metadata and standalone display", () => {
      const manifestPath = path.join(rootDir, "app", "manifest.ts");
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifestContent = fs.readFileSync(manifestPath, "utf-8");
      expect(manifestContent).toContain("جملة تك - Jomla Tech");
      expect(manifestContent).toContain('"standalone"');
      expect(manifestContent).toContain('"rtl"');
      expect(manifestContent).toContain('"ar"');
    });
  });

  describe("2. Asset Cache Strategy & Network-Only API Rules", () => {
    it("enforces /api/* is strictly NETWORK-ONLY with no service worker caching", () => {
      const swPath = path.join(rootDir, "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf-8");
      expect(swContent).toMatch(/url\.pathname\.startsWith\(\s*["']\/api\/["']\s*\)/);
    });

    it("enforces Cache-First strategy for static JS/CSS bundles and fonts", () => {
      const swPath = path.join(rootDir, "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf-8");
      expect(swContent).toContain("/_next/static/");
      expect(swContent).toContain("fonts.googleapis.com");
      expect(swContent).toContain("STATIC_CACHE_NAME");
    });

    it("enforces Stale-While-Revalidate strategy for dashboard HTML page navigations", () => {
      const swPath = path.join(rootDir, "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf-8");
      expect(swContent).toContain('request.mode === "navigate"');
      expect(swContent).toContain("RUNTIME_CACHE_NAME");
      expect(swContent).toContain('match("/offline")');
    });
  });

  describe("3. Cache Versioning & Update Lifecycle", () => {
    it("purges stale cache entries on activate event to prevent unbounded cache growth", () => {
      const swPath = path.join(rootDir, "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf-8");
      expect(swContent).toContain('addEventListener("activate"');
      expect(swContent).toContain("caches.delete");
    });

    it("does NOT invoke self.skipWaiting() on install to protect cashier mid-sale", () => {
      const swPath = path.join(rootDir, "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf-8");
      const installBlockMatch = swContent.match(/self\.addEventListener\(\s*["']install["'][\s\S]*?\n\}\);/);
      expect(installBlockMatch).not.toBeNull();
      const installBlock = installBlockMatch ? installBlockMatch[0] : "";
      expect(installBlock).not.toContain("self.skipWaiting()");
    });

    it("guards ServiceWorkerRegister against development mode and localhost", () => {
      const registerPath = path.join(rootDir, "components", "pwa", "service-worker-register.tsx");
      expect(fs.existsSync(registerPath)).toBe(true);
      const registerContent = fs.readFileSync(registerPath, "utf-8");
      expect(registerContent).toContain('process.env.NODE_ENV === "development"');
      expect(registerContent).toContain("localhost");
      expect(registerContent).toContain('navigator.serviceWorker.register("/sw.js"');
    });
  });

  describe("4. Session-Agnostic Dashboard Shell Verification", () => {
    it("confirms root layout mounts ServiceWorkerRegister and declares manifest", () => {
      const layoutPath = path.join(rootDir, "app", "layout.tsx");
      const layoutContent = fs.readFileSync(layoutPath, "utf-8");
      expect(layoutContent).toContain("<ServiceWorkerRegister />");
      expect(layoutContent).toContain('manifest: "/manifest.webmanifest"');
    });

    it("confirms dashboard layout is session-agnostic without server-rendered tenant claims", () => {
      const dashLayoutPath = path.join(rootDir, "app", "(dashboard)", "layout.tsx");
      const dashLayoutContent = fs.readFileSync(dashLayoutPath, "utf-8");
      expect(dashLayoutContent).not.toContain("await auth()");
      expect(dashLayoutContent).not.toContain("getServerSession");
      expect(dashLayoutContent).toContain("<SessionProvider");
    });
  });

  describe("5. Direct useSession() Audit — useSessionWithOfflineFallback Enforcement", () => {
    it("ensures all client components in dashboard tree use useSessionWithOfflineFallback instead of raw useSession", () => {
      const targetDirs = [
        path.join(rootDir, "app", "(dashboard)"),
        path.join(rootDir, "components", "dashboard"),
        path.join(rootDir, "components", "pos"),
        path.join(rootDir, "components", "inventory"),
      ];

      const violations: string[] = [];

      function checkDir(dir: string) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkDir(fullPath);
          } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, "utf-8");
            if (
              /import\s+{[^}]*useSession[^}]*}\s+from\s+["']next-auth\/react["']/.test(content)
            ) {
              violations.push(fullPath);
            }
          }
        }
      }

      for (const dir of targetDirs) {
        checkDir(dir);
      }

      expect(violations).toEqual([]);
    });
  });
});