import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { signOutAction } from "@/lib/actions/auth";
import { LockKeyhole, Clock, ShieldAlert } from "lucide-react";
import { LogoutSubmitButton } from "@/components/auth/logout-submit-button";
import { Logo } from "@/components/brand/logo";
import s from "@/components/lockout/lockout.module.css";

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
    <div className={s.wrap}>
      <div className={s.brand}>
        <Logo size={34} />
      </div>

      <div className={s.card}>
        <div className={`${s.iconRing} ${isPending ? s.ringPending : s.ringExpired} ${isPending ? s.pulse : ""}`}>
          {isPending ? <Clock size={28} aria-hidden /> : <LockKeyhole size={28} aria-hidden />}
        </div>

        <h1 className={s.title}>
          {isPending ? "الحساب قيد المراجعة" : "انتهى اشتراك المتجر"}
        </h1>

        <p className={s.lead}>
          {isPending
            ? "لم تتم الموافقة على اشتراك هذا المتجر بعد من قبل إدارة المنصة. يرجى التواصل مع مدير المتجر لمتابعة حالة الاشتراك."
            : "انتهت صلاحية اشتراك هذا المتجر. لا يمكن إجراء أي عمليات بيع أو مزامنة حتى يتم تجديد الاشتراك."}
        </p>

        <div className={`${s.note} ${isPending ? s.noteAmber : s.noteRose}`}>
          <ShieldAlert size={16} aria-hidden />
          <span>فقط مدير المتجر (ADMIN) يمكنه تجديد الاشتراك أو متابعة حالة الموافقة.</span>
        </div>

        <div className={s.divider} />

        <form action={signOutAction}>
          <LogoutSubmitButton className={s.signOut}>
            تسجيل الخروج
          </LogoutSubmitButton>
        </form>
      </div>
    </div>
  );
}