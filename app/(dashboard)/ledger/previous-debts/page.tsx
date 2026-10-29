/**
 * app/(dashboard)/ledger/previous-debts/page.tsx
 *
 * T4e v6.1 — entry point of the previous-debts screen. SERVER component.
 *
 * The guard lives here, not in the client component: a "use client" page can
 * never reject a CASHIER server-side, and the spec requires the page itself to
 * refuse a CASHIER regardless of the middleware matcher. The same permission
 * constant that protects POST /api/ledger/adjustments decides here, so the page
 * and the API can never disagree about who is allowed in.
 *
 * (The API remains the real security boundary: this guard only keeps a CASHIER
 * from ever seeing the screen.)
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertRolePermission, ForbiddenRoleError } from "@/lib/auth/role-matrix";
import { PreviousDebtsClient } from "./previous-debts-client";

export default async function PreviousDebtsPage() {
  const session = await auth();
  if (!session?.user?.tenantId) {
    redirect("/login");
  }

  let allowed = true;
  try {
    assertRolePermission(session.user.role, "ledger:add_balance_adjustment");
  } catch (error) {
    if (!(error instanceof ForbiddenRoleError)) throw error;
    allowed = false;
  }

  // A CASHIER can still view the ledger itself — send them back there.
  // (redirect() throws, so it must stay outside the try/catch above.)
  if (!allowed) {
    redirect("/ledger");
  }

  return <PreviousDebtsClient tenantId={session.user.tenantId} />;
}