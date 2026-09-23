import { auth } from "@/auth";
import { LedgerClient } from "@/components/ledger/ledger-client";
import { redirect } from "next/navigation";

export default async function LedgerPage() {
  const session = await auth();

  if (!session?.user?.tenantId) {
    redirect("/login");
  }

  const tenantId = session.user.tenantId;
  const isAdmin = session.user.role === "ADMIN";

  return <LedgerClient tenantId={tenantId} isAdmin={isAdmin} />;
}
