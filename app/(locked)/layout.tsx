import { SessionProvider } from "@/components/providers/session-provider";
import { auth } from "@/auth";

/**
 * Standalone layout for routes that must render with ZERO dashboard chrome
 * — currently just /account-locked. Deliberately does NOT import
 * DashboardSidebar or DashboardTopBar: a locked-out CASHIER session has no
 * permission to act on ANY dashboard route (POS, inventory, ledger,
 * orders...), so showing those navigation links here would be actively
 * misleading — every one of them would just bounce the user right back via
 * middleware. See T1's folder-structure note on why /account-locked exists
 * as a distinct route from /settings/billing in the first place.
 *
 * This is a SEPARATE route group from (dashboard) specifically so this
 * page does not inherit that group's layout.tsx (Next.js layouts compose
 * top-down within a group — a child page cannot "opt out" of a parent
 * group's sidebar/topbar once that parent renders them). Route groups
 * don't affect the URL, so this still serves at /account-locked exactly as
 * before.
 */
export default async function LockedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <SessionProvider session={session}>
      <div className="flex min-h-screen w-full items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
        {children}
      </div>
    </SessionProvider>
  );
}