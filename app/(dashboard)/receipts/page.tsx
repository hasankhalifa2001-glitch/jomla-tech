import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { ReceiptsLogClient } from "@/components/receipts/receipts-log-client";

/**
 * v4.7 Phase 7 — /receipts
 *
 * Thin server wrapper on the convention app/(dashboard)/inventory/page.tsx
 * and app/(dashboard)/sales-log/page.tsx established: the screen itself is a
 * client component; this file pins the route and, because the screen is
 * ADMIN-only, resolves the session role ONCE here.
 *
 * [DEFENSE IN DEPTH — not the security boundary] A CASHIER who types the
 * URL directly is bounced to /inventory before any client code runs, but
 * the real boundary is unchanged and independent: GET/PATCH /api/receipts
 * assert inventory:mutate (403, zero queries) for every request regardless
 * of how this page was reached. Middleware already requires a logged-in
 * session for /inventory/**.
 */
export default async function ReceiptsLogPage() {
  const session = await auth();

  if (!session?.user?.tenantId) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/inventory");
  }

  return <ReceiptsLogClient />;
}
