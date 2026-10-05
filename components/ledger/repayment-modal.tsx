"use client";

/**
 * components/ledger/repayment-modal.tsx
 *
 * T4e — the "تسديد دفعة" dialog. Deliberately a thin form over two ALREADY
 * existing write paths, with no repayment rules of its own:
 *
 *   ONLINE  → POST /api/ledger/repayments  (body: customerId, amountSYP,
 *             paymentMethod, receiptNo, notes, offlineId)
 *   OFFLINE → lib/offline/pos-service.ts's submitOfflinePayment() — the local
 *             Dexie queue, replayed later by /api/sync's Payment pass.
 *
 * Both land on the same server core (lib/ledger/repayment.ts's
 * recordRepayment), so the dialog never computes a ledger balance, an exchange
 * rate for the write, or a persisted USD figure — it displays them.
 *
 * OFFLINE FALLBACK: only a fetch-level failure (the browser is offline) falls
 * back to the local queue. A server REJECTION (403 / 400 / "amount above
 * balance") is surfaced as-is and is never queued — queueing a rejected
 * repayment would just produce a FAILED sync item the merchant never sees.
 *
 * The SAME offlineId is generated once when the dialog opens and sent to BOTH
 * paths: if the online POST actually committed but its response was lost, the
 * later sync of that offlineId finds the existing row instead of writing a
 * second payment. That is the whole point of the key.
 *
 * Rendered by the caller ONLY for an ADMIN session, ONLY for a real customer
 * (never the system cash bucket), and ONLY when the balance is > 0 — see
 * lib/ledger/repayment-ui.ts's canShowRepaymentButton(). The CASHIER case is
 * absent from the DOM, and rejected server-side regardless.
 */

import { useEffect, useState } from "react";
import { BanknoteArrowUp, Loader2, WifiOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMoney } from "@/lib/utils/money";
import { generateOfflineId } from "@/lib/offline/id";
import { getCachedRate } from "@/lib/offline/exchange-rate";
import { submitOfflinePayment } from "@/lib/offline/pos-service";
import type { PaymentMethod } from "@prisma/client";
import {
  canSubmitRepayment,
  computeRemainingBalanceSYP,
  fullBalanceAmountSYP,
  parseAmountInput,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS_AR,
  repaymentConfirmationLine,
  usdApproxFromSyp,
} from "@/lib/ledger/repayment-ui";

export interface RepaymentTarget {
  id: string;
  name: string;
  balanceSYP: string;
}

interface RepaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  customer: RepaymentTarget | null;
  isAdmin: boolean;
  /**
   * Called after a successful ONLINE repayment, or after a repayment was
   * queued offline. Carries the balance the card must now show — the server's
   * own balanceAfter for the online case, the locally-decremented cached
   * balance for the queued case. The card updates in place; nothing reloads.
   */
  onSuccess: (result: {
    customerId: string;
    balanceSYP: string;
    queuedOffline: boolean;
    amountSYP: string;
  }) => void;
}

function UsdApprox({ amountSYP, rate }: { amountSYP: string; rate: string | null }) {
  const usd = usdApproxFromSyp(amountSYP, rate);
  if (!usd) return null;
  return (
    <span className="block text-[11px] font-normal text-zinc-400">
      ≈ {formatMoney(usd, "USD")}
    </span>
  );
}

export function RepaymentModal({
  open,
  onOpenChange,
  tenantId,
  customer,
  isAdmin,
  onSuccess,
}: RepaymentModalProps) {
  const [amountInput, setAmountInput] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [receiptNo, setReceiptNo] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [offlineId, setOfflineId] = useState("");

  // The cached rate is stored together with the tenant it was loaded for, so
  // the displayed value can be DERIVED during render (null when the dialog is
  // closed, there is no tenant, or the stored rate belongs to another tenant).
  // That removes the need for a synchronous `setCachedRate(null)` reset inside
  // the effect — the effect below only sets state from an async callback.
  const [rateState, setRateState] = useState<{
    tenantId: string;
    rate: string | null;
  } | null>(null);

  // Same render-phase reset pattern as VoidInvoiceModal: reset exactly once per
  // open transition, without an Effect. The idempotency key is generated HERE
  // (once per open) and reused for retries.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setAmountInput("");
      setPaymentMethod("CASH");
      setReceiptNo("");
      setNotes("");
      setConfirming(false);
      setSubmitting(false);
      setOfflineId(generateOfflineId());
    }
  }

  useEffect(() => {
    if (!open || !tenantId) return;
    let cancelled = false;
    void getCachedRate(tenantId).then((cached) => {
      if (!cancelled) setRateState({ tenantId, rate: cached?.rate ?? null });
    });
    return () => {
      cancelled = true;
    };
  }, [open, tenantId]);

  const cachedRate: string | null =
    open && tenantId && rateState?.tenantId === tenantId ? rateState.rate : null;

  // Keep rendering against the last non-null customer while `open` settles to
  // false, so Radix's exit transition can run (same fix as VoidInvoiceModal).
  const [lastCustomer, setLastCustomer] = useState<RepaymentTarget | null>(customer);
  if (customer && customer !== lastCustomer) {
    setLastCustomer(customer);
  }

  const displayCustomer = customer ?? lastCustomer;
  if (!displayCustomer) return null;

  const balanceSYP = displayCustomer.balanceSYP;
  const normalizedAmount = parseAmountInput(amountInput);
  const remainingSYP = computeRemainingBalanceSYP(balanceSYP, amountInput);
  const canSubmit = canSubmitRepayment(balanceSYP, amountInput) && !submitting;

  const handleFullBalance = () => {
    const full = fullBalanceAmountSYP(balanceSYP);
    if (full !== null) setAmountInput(full);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || normalizedAmount === null || remainingSYP === null) return;

    if (!confirming) {
      setConfirming(true);
      return;
    }

    setSubmitting(true);

    try {
      try {
        const res = await fetch("/api/ledger/repayments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: displayCustomer.id,
            amountSYP: normalizedAmount,
            paymentMethod,
            receiptNo: receiptNo.trim() || undefined,
            notes: notes.trim() || undefined,
            offlineId,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          // A real server rejection: shown as-is, never queued offline.
          throw new Error(data.message || "تعذّر تسجيل الدفعة.");
        }

        toast.success(data.message || "تم تسجيل الدفعة بنجاح.");
        onOpenChange(false);
        onSuccess({
          customerId: data.customerId ?? displayCustomer.id,
          balanceSYP: data.balanceSYP ?? "0.0000",
          queuedOffline: false,
          amountSYP: normalizedAmount,
        });
        return;
      } catch (error) {
        // Only a genuine transport failure falls through to the local queue.
        // Anything the server actually answered (403/400/409/500) is rethrown.
        if (!(error instanceof TypeError)) throw error;
      }

      await submitOfflinePayment(tenantId, {
        customerId: displayCustomer.id,
        amountSYP: normalizedAmount,
        actorRole: isAdmin ? "ADMIN" : "CASHIER",
        paymentMethod,
        receiptNo: receiptNo.trim() || undefined,
        notes: notes.trim() || undefined,
        offlineId,
      });

      toast.info("لا يوجد اتصال — تم تسجيل الدفعة على هذا الجهاز وستُزامن تلقائياً.", {
        icon: <WifiOff className="h-4 w-4" />,
      });
      onOpenChange(false);
      onSuccess({
        customerId: displayCustomer.id,
        balanceSYP: remainingSYP ?? balanceSYP,
        queuedOffline: true,
        amountSYP: normalizedAmount,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "حدث خطأ أثناء تسجيل الدفعة.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-emerald-100 p-2 dark:bg-emerald-950/40">
              <BanknoteArrowUp className="h-5 w-5 text-emerald-700 dark:text-emerald-400" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold text-zinc-900">
                تسديد دفعة
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-500">
                {displayCustomer.name}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border bg-zinc-50 p-3 text-sm dark:bg-zinc-900/40">
            <span className="text-zinc-500">الرصيد الحالي</span>
            <div className="text-left">
              <span className="font-bold text-rose-700">
                {formatMoney(balanceSYP, "SYP")} ل.س
              </span>
              <UsdApprox amountSYP={balanceSYP} rate={cachedRate} />
            </div>
          </div>

          {confirming && normalizedAmount && remainingSYP ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              {repaymentConfirmationLine(normalizedAmount, balanceSYP, remainingSYP)}
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="repayment-amount">المبلغ المسدَّد (ل.س)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="repayment-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amountInput}
                    onChange={(event) => setAmountInput(event.target.value)}
                    placeholder="0"
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleFullBalance}
                    className="whitespace-nowrap text-xs"
                  >
                    تسديد كامل الرصيد
                  </Button>
                </div>
                {normalizedAmount && (
                  <UsdApprox amountSYP={normalizedAmount} rate={cachedRate} />
                )}
              </div>

              {normalizedAmount !== null && remainingSYP !== null && (
                <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
                  <span className="text-emerald-800 dark:text-emerald-300">
                    الرصيد بعد التسديد
                  </span>
                  <div className="text-left">
                    <span className="font-bold text-emerald-800 dark:text-emerald-300">
                      {formatMoney(remainingSYP, "SYP")} ل.س
                    </span>
                    <UsdApprox amountSYP={remainingSYP} rate={cachedRate} />
                  </div>
                </div>
              )}

              {amountInput.trim().length > 0 && !canSubmitRepayment(balanceSYP, amountInput) && (
                <p className="text-xs text-rose-600">
                  يجب أن يكون المبلغ أكبر من صفر ولا يتجاوز الرصيد الحالي.
                </p>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="repayment-method">طريقة الدفع</Label>
                <Select
                  value={paymentMethod}
                  onValueChange={(value) => setPaymentMethod(value as PaymentMethod)}
                >
                  <SelectTrigger id="repayment-method" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((method) => (
                      <SelectItem key={method} value={method}>
                        {PAYMENT_METHOD_LABELS_AR[method]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="repayment-receipt">رقم الإيصال (اختياري)</Label>
                <Input
                  id="repayment-receipt"
                  value={receiptNo}
                  onChange={(event) => setReceiptNo(event.target.value)}
                  placeholder="مثال: 1024"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="repayment-notes">ملاحظات (اختياري)</Label>
                <Textarea
                  id="repayment-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                />
              </div>
            </>
          )}

          <DialogFooter>
            {confirming ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirming(false)}
                disabled={submitting}
              >
                تعديل
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                إلغاء
              </Button>
            )}
            <Button
              type="submit"
              disabled={!canSubmit}
              className="flex items-center gap-2 bg-emerald-700 text-white hover:bg-emerald-800"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>{confirming ? "تأكيد التسديد" : "تسجيل الدفعة"}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}