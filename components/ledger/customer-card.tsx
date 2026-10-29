"use client";

/**
 * components/ledger/customer-card.tsx
 *
 * T4e — one ledger customer card, extracted from ledger-client.tsx so the
 * "تسديد دفعة" affordance has exactly one home and one guard:
 *
 *   {canShowRepaymentButton(isAdmin, balanceSYP, isSystemGenerated) && <Button …>}
 *
 * A CASHIER gets NO button — absent from the DOM, never rendered disabled —
 * and the system-generated cash customer never gets one either, regardless of
 * role. Both facts are pure-function decisions (lib/ledger/repayment-ui.ts), so
 * they are tested outside the DOM; the server rejects both cases independently
 * (ledger:log_repayment → 403, and recordRepayment()'s own customer checks).
 *
 * The card also renders the repayment dialog and, on success, hands the new
 * balance back up to the parent — the parent owns the customer list state, so
 * the card's balance updates in place with no reload and no refetch.
 *
 * "بانتظار المزامنة": when this device still holds a queued (not yet synced)
 * repayment for this customer, the card says so — the balance it displays
 * already includes that queued amount locally, and the merchant must be able to
 * see why the server has not confirmed it yet.
 *
 * [v4.5 — polish pass, presentation only] An initial-letter avatar tile tinted
 * by state (debt / settled / cash), a balance panel that reads at a glance, a
 * full-width 44px repayment button, and a card that fills its grid cell so
 * rows align. Light mode only.
 *
 * [v6.1] "عرض تعديلات الرصيد" opens the read-only adjustment history. It is
 * available to ADMIN and CASHIER alike (viewing is read-only for both), and is
 * shown only for a real customer that actually has adjustments — the system
 * cash customer can never receive one, and an always-present button on a card
 * with nothing behind it would only be noise. Money comparisons here go through
 * lib/utils/money.ts (compareMoney), never native Number.
 */

import { useState } from "react";
import { Building2, CreditCard, FileText, History, List, Phone, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { compareMoney, formatMoney } from "@/lib/utils/money";
import { canShowRepaymentButton, FAILED_SYNC_LABEL, PENDING_SYNC_LABEL } from "@/lib/ledger/repayment-ui";
import { RepaymentModal, type RepaymentTarget } from "./repayment-modal";
import { AdjustmentsHistoryDrawer } from "./adjustments-history-drawer";

export interface LedgerCustomerCardData {
  id: string;
  name: string;
  phone: string | null;
  shopName: string | null;
  cachedBalanceDebtSYP: string;
  cachedBalanceDebtUSD?: string;
  isSystemGenerated: boolean;
  invoiceCount?: number;
  adjustmentCount?: number;
}

export interface RepaymentAppliedResult {
  customerId: string;
  balanceSYP: string;
  queuedOffline: boolean;
  amountSYP: string;
}

interface CustomerCardProps {
  tenantId: string;
  customer: LedgerCustomerCardData;
  isAdmin: boolean;
  /** Total SYP queued on this device for this customer (0 when none). */
  pendingRepaymentSYP?: string;
  /** FAILED queued repayments for this customer (never lumped with pending). */
  failedRepayments?: { offlineId: string; failureReason?: string }[];
  onRepaymentApplied: (result: RepaymentAppliedResult) => void;
}

export function CustomerCard({
  tenantId,
  customer,
  isAdmin,
  pendingRepaymentSYP,
  failedRepayments,
  onRepaymentApplied,
}: CustomerCardProps) {
  const [isRepaymentOpen, setIsRepaymentOpen] = useState(false);
  const [isAdjustmentsOpen, setIsAdjustmentsOpen] = useState(false);

  const balanceSYP = customer.cachedBalanceDebtSYP;
  const canRepay = canShowRepaymentButton(isAdmin, balanceSYP, customer.isSystemGenerated);
  const showPendingSync = isPositiveMoney(pendingRepaymentSYP);
  const failedForCard = failedRepayments ?? [];
  const hasAdjustments = !customer.isSystemGenerated && (customer.adjustmentCount ?? 0) > 0;

  const repaymentTarget: RepaymentTarget = {
    id: customer.id,
    name: customer.name,
    balanceSYP,
  };

  const inDebt = isPositiveMoney(balanceSYP);
  const initial = Array.from(customer.name.trim())[0] ?? "؟";

  // Avatar tint follows the account's state: cash bucket → neutral,
  // owes money → rose, settled → emerald.
  const avatarTone = customer.isSystemGenerated
    ? "bg-zinc-100 text-zinc-600"
    : inDebt
      ? "bg-rose-50 text-rose-700"
      : "bg-emerald-50 text-emerald-700";

  return (
    <div className="flex h-full flex-col justify-between rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md motion-reduce:transform-none">
      <div>
        <div className="mb-3 flex items-start justify-between gap-2 border-b border-zinc-100 pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-xl text-lg font-extrabold",
                avatarTone
              )}
              aria-hidden
            >
              {initial}
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-base font-extrabold text-zinc-900">{customer.name}</h3>
              {customer.shopName && (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                  <Building2 className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                  <span className="truncate">{customer.shopName}</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            {customer.isSystemGenerated ? (
              <Badge variant="secondary" className="text-[10px] font-bold">
                نقدي عام
              </Badge>
            ) : inDebt ? (
              <Badge
                variant="outline"
                className="border-rose-200 bg-rose-50 text-[10px] font-bold text-rose-700"
              >
                مدين
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-emerald-200 bg-emerald-50 text-[10px] font-bold text-emerald-700"
              >
                مستوفى
              </Badge>
            )}

            {showPendingSync && (
              <Badge
                variant="outline"
                className="border-amber-300 bg-amber-50 text-[10px] font-bold text-amber-800"
              >
                {PENDING_SYNC_LABEL}
              </Badge>
            )}
            {failedForCard.length > 0 && (
              <Badge
                variant="outline"
                className="border-rose-300 bg-rose-50 text-[10px] font-bold text-rose-800"
                title={failedForCard.map((row) => row.failureReason).filter(Boolean).join(" — ")}
              >
                {FAILED_SYNC_LABEL}
              </Badge>
            )}
          </div>
        </div>

        <div className="mb-3 space-y-2 text-xs text-zinc-600">
          {customer.phone && (
            <div className="flex items-center gap-2">
              <Phone className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
              <span dir="ltr" className="font-mono font-semibold text-zinc-800 [unicode-bidi:isolate]">
                {customer.phone}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <FileText className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
            <span>عدد الفواتير:</span>
            <span className="font-bold tabular-nums text-zinc-800">{customer.invoiceCount ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <List className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
            <span>تعديلات الرصيد:</span>
            <span className="font-bold tabular-nums text-zinc-800">
              {customer.adjustmentCount ?? 0}
            </span>
          </div>
        </div>
      </div>

      <div>
        <div
          className={cn(
            "flex items-center justify-between gap-2 rounded-xl px-3 py-2.5",
            inDebt ? "bg-rose-50/70" : "bg-emerald-50/70"
          )}
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-500">
            <CreditCard className="size-3.5 text-zinc-400" aria-hidden />
            الرصيد
          </span>
          <div className="text-end text-sm font-extrabold tabular-nums">
            <span className={inDebt ? "text-rose-700" : "text-emerald-700"}>
              {formatMoney(balanceSYP, "SYP")}
            </span>
            {customer.cachedBalanceDebtUSD && (
              <span className="block text-[11px] font-normal text-zinc-400">
                ≈ {formatMoney(customer.cachedBalanceDebtUSD, "USD")}
              </span>
            )}
          </div>
        </div>

        {canRepay && (
          <div className="mt-3">
            <Button
              onClick={() => setIsRepaymentOpen(true)}
              className="flex h-11 w-full items-center gap-2 rounded-xl bg-emerald-600 text-sm font-bold text-white shadow-sm shadow-emerald-600/25 transition-all hover:bg-emerald-700 active:scale-[0.98]"
            >
              <Wallet className="size-4" aria-hidden />
              <span>تسديد دفعة</span>
            </Button>
          </div>
        )}

        {hasAdjustments && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setIsAdjustmentsOpen(true)}
            className="mt-2 h-10 w-full gap-2 rounded-xl border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            <History className="size-3.5" aria-hidden />
            <span>عرض تعديلات الرصيد</span>
          </Button>
        )}
      </div>

      {canRepay && (
        <RepaymentModal
          open={isRepaymentOpen}
          onOpenChange={setIsRepaymentOpen}
          tenantId={tenantId}
          customer={repaymentTarget}
          isAdmin={isAdmin}
          onSuccess={onRepaymentApplied}
        />
      )}

      {hasAdjustments && (
        <AdjustmentsHistoryDrawer
          open={isAdjustmentsOpen}
          onOpenChange={setIsAdjustmentsOpen}
          customerId={customer.id}
          customerName={customer.name}
        />
      )}
    </div>
  );
}

/**
 * Display-only "is this amount strictly positive" check, through money.ts.
 * compareMoney fails loud on a malformed string (by design, for ledger maths);
 * a card must not crash the whole ledger page over one bad display value, so
 * a malformed or missing amount simply reads as "not positive".
 */
function isPositiveMoney(amount: string | undefined): boolean {
  if (!amount) return false;
  try {
    return compareMoney(amount, "0") > 0;
  } catch {
    return false;
  }
}