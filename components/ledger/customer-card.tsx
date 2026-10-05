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
 */

import { useState } from "react";
import { Building2, CreditCard, FileText, Phone, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/utils/money";
import { canShowRepaymentButton, FAILED_SYNC_LABEL, PENDING_SYNC_LABEL } from "@/lib/ledger/repayment-ui";
import { RepaymentModal, type RepaymentTarget } from "./repayment-modal";

export interface LedgerCustomerCardData {
  id: string;
  name: string;
  phone: string | null;
  shopName: string | null;
  cachedBalanceDebtSYP: string;
  cachedBalanceDebtUSD?: string;
  isSystemGenerated: boolean;
  invoiceCount?: number;
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

  const balanceSYP = customer.cachedBalanceDebtSYP;
  const canRepay = canShowRepaymentButton(isAdmin, balanceSYP, customer.isSystemGenerated);
  const showPendingSync = !!pendingRepaymentSYP && Number(pendingRepaymentSYP) > 0;
  const failedForCard = failedRepayments ?? [];

  const repaymentTarget: RepaymentTarget = {
    id: customer.id,
    name: customer.name,
    balanceSYP,
  };
return (
    <div className="flex flex-col justify-between rounded-xl border bg-white p-4 shadow-sm transition-shadow hover:shadow">
      <div>
        <div className="mb-3 flex items-start justify-between gap-2 border-b pb-2">
          <div>
            <h3 className="text-base font-bold text-zinc-900">{customer.name}</h3>
            {customer.shopName && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                <Building2 className="h-3.5 w-3.5 text-zinc-400" />
                <span>{customer.shopName}</span>
              </p>
            )}
          </div>

          <div className="flex flex-col items-end gap-1">
            {customer.isSystemGenerated ? (
              <Badge variant="secondary" className="text-[10px]">
                نقدي عام
              </Badge>
            ) : showDebt(balanceSYP) ? (
              <Badge variant="destructive" className="text-[10px]">
                مدين
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700"
              >
                مستوفى
              </Badge>
            )}

            {showPendingSync && (
              <Badge
                variant="outline"
                className="border-amber-300 bg-amber-50 text-[10px] text-amber-800"
              >
                {PENDING_SYNC_LABEL}
              </Badge>
            )}
            {failedForCard.length > 0 && (
              <Badge
                variant="outline"
                className="border-rose-300 bg-rose-50 text-[10px] text-rose-800"
                title={failedForCard.map((row) => row.failureReason).filter(Boolean).join(" — ")}
              >
                {FAILED_SYNC_LABEL}
              </Badge>
            )}
          </div>
        </div>

        <div className="mb-3 space-y-1.5 text-xs text-zinc-600">
          {customer.phone && (
            <div className="flex items-center gap-1.5">
              <Phone className="h-3.5 w-3.5 text-zinc-400" />
              <span className="font-mono text-zinc-800">{customer.phone}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-zinc-400" />
            <span>عدد الفواتير:</span>
            <span className="font-semibold text-zinc-800">
              {customer.invoiceCount ?? 0}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t pt-3">
        <span className="flex items-center gap-1 text-xs text-zinc-500">
          <CreditCard className="h-3.5 w-3.5 text-zinc-400" />
          الرصيد:
        </span>
        <div className="text-left text-sm font-bold">
          <span className={showDebt(balanceSYP) ? "text-rose-700" : "text-emerald-700"}>
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
            className="flex w-full items-center gap-2 bg-emerald-700 text-sm text-white hover:bg-emerald-800"
          >
            <Wallet className="h-4 w-4" />
            <span>تسديد دفعة</span>
          </Button>
        </div>
      )}

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
    </div>
  );
}

/** Display-only "is this customer in debt" flag, safe against bad input. */
function showDebt(balanceSYP: string): boolean {
  const value = Number(balanceSYP);
  return Number.isFinite(value) && value > 0;
}