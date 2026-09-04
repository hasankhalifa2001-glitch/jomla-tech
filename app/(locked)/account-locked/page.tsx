import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { signOutAction } from "@/lib/actions/auth";
import { LockKeyhole, Clock } from "lucide-react";

/**
 * T1 / T2 — /account-locked
 *
 * Read-only lockout screen for a CASHIER session whose tenant's
 * subscriptionStatus is EXPIRED or PENDING. Deliberately contains ZERO
 * navigation to any other dashboard route — a locked-out cashier has no
 * permission to act on billing or anything else, so this page's only job
 * is to explain that plainly and point them at their admin. See this
 * route group's layout.tsx for why this renders with no sidebar/topbar.
 *
 * ADMIN sessions never reach this page — T2's middleware routes them to
 * /settings/billing instead, since they CAN act on the subscription. If an
 * ADMIN session somehow lands here directly (e.g. a stale bookmark), we
 * send them to the route that's actually useful to them rather than
 * showing a message that doesn't apply to their role.
 */
export default async function AccountLockedPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role === "ADMIN") {
    redirect("/settings/billing");
  }

  const status = session.user.subscriptionStatus;
  const isPending = status === "PENDING";

  return (
    <div
      dir="rtl"
      className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
        {isPending ? <Clock className="h-7 w-7" /> : <LockKeyhole className="h-7 w-7" />}
      </div>

      <h1 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        {isPending ? "الحساب قيد المراجعة" : "انتهى اشتراك المتجر"}
      </h1>

      <p className="mb-6 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        {isPending
          ? "لم تتم الموافقة على اشتراك هذا المتجر بعد من قبل إدارة المنصة. يرجى التواصل مع مدير المتجر لمتابعة حالة الاشتراك."
          : "انتهت صلاحية اشتراك هذا المتجر. لا يمكن إجراء أي عمليات بيع أو مزامنة حتى يتم تجديد الاشتراك."}
      </p>

      <p className="mb-6 text-sm font-medium text-zinc-900 dark:text-zinc-50">
        فقط مدير المتجر (ADMIN) يمكنه تجديد الاشتراك أو متابعة حالة الموافقة.
      </p>

      <form action={signOutAction}>
        <button
          type="submit"
          className="w-full rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          تسجيل الخروج
        </button>
      </form>
    </div>
  );
}