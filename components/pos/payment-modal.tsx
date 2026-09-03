"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  CreditCard,
  Banknote,
  DollarSign,
  AlertTriangle,
  Receipt,
  User,
  Smartphone,
  Building2,
  HelpCircle,
  UserCheck,
  UserPlus,
} from "lucide-react";
import type { SelectedCustomer, PaymentMethod } from "@/lib/offline";
import { isSystemCashCustomer } from "@/lib/offline";
import {
  subtractMoney,
  convertCurrency,
  compareMoney,
  formatMoney,
  serializeMoney,
  toDecimal,
  type MoneyInput,
} from "@/lib/utils/money";

export type PaymentMode = "FULL_CASH" | "FULL_DEBT" | "PARTIAL";

interface PaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalUSD: MoneyInput;
  exchangeRate: number;
  selectedCustomer: SelectedCustomer | null;
  onPaymentModeChange?: (mode: PaymentMode) => void;
  onOpenCustomerModal: () => void;
  onConfirmCheckout: (paymentData: {
    paidAmountUSD: string;
    debtAmountUSD: string;
    paymentMethod?: PaymentMethod;
  }) => Promise<void>;
}

const PAYMENT_RAILS: {
  id: PaymentMethod;
  label: string;
  icon: typeof Banknote;
  sub: string;
}[] = [
    { id: "CASH", label: "نقداً (كاش)", icon: Banknote, sub: "دفع نقدي ورقي مباشر" },
    { id: "SHAM_CASH", label: "شام كاش (Sham Cash)", icon: Smartphone, sub: "محفظة شام كاش الإلكترونية" },
    { id: "SYRIATEL_CASH", label: "سيرياتيل كاش (Syriatel)", icon: Smartphone, sub: "سيرياتيل كاش / MTN كاش" },
    { id: "BANK_TRANSFER", label: "تحويل بنكي / مكتب", icon: Building2, sub: "حوالة مصرفية أو مكتب صرافة" },
    { id: "OTHER", label: "وسيلة دفع أخرى", icon: HelpCircle, sub: "وسيلة دفع بديلة" },
  ];

export function PaymentModal({
  open,
  onOpenChange,
  totalUSD,
  exchangeRate,
  selectedCustomer,
  onPaymentModeChange,
  onOpenCustomerModal,
  onConfirmCheckout,
}: PaymentModalProps) {
  const [mode, setMode] = useState<PaymentMode>("FULL_CASH");
  const [selectedRail, setSelectedRail] = useState<PaymentMethod>("CASH");
  const [paidUSDInput, setPaidUSDInput] = useState<string>("");
  const [paidSYPInput, setPaidSYPInput] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // [FIX — close-during-submit] Every dialog close path in this file
  // (Cancel button, the confirm button's own submit handler) now routes
  // through this single guarded wrapper instead of the raw `onOpenChange`
  // prop. `onConfirmCheckout` is async — it writes the invoice to Dexie —
  // and while it's in flight the cashier can still dismiss the dialog via
  // the X button, an outside click, or Escape, none of which went through
  // the (disabled) Cancel button's guard. Previously that closed the
  // dialog visually while the write kept running invisibly in the
  // background: if it then succeeded, the cashier — who believed they'd
  // cancelled — would have an invoice they never confirmed seeing.
  // Blocking every close path during `isSubmitting` closes that gap.
  function guardedOnOpenChange(next: boolean) {
    if (isSubmitting) return;
    onOpenChange(next);
  }

  // [FIX — fail-loud, not fail-silent] Previously this (and every other
  // computed value below) was wrapped in `try { ... } catch { return
  // "0.0000"; }`. That directly contradicts lib/utils/money.ts's own
  // stated philosophy ("a silently-wrong number is strictly worse than a
  // thrown error") — a genuinely malformed `totalUSD` reaching this modal
  // (a real upstream bug) would have silently rendered "$0.00" and let the
  // cashier attempt to check out a free sale, instead of surfacing the
  // problem. `totalUSDValue` is now `null` on error instead of a fake
  // zero, and the component renders a blocking error state (see below)
  // rather than a payment form built on an untrustworthy number.
  const totalUSDValue = useMemo(() => {
    try {
      return serializeMoney(totalUSD);
    } catch {
      return null;
    }
  }, [totalUSD]);

  // Unlike totalUSDValue above, a `null` SYP equivalent is a legitimate,
  // already-communicated state ("غير متاح" in the UI below) — it just
  // means no exchange rate is cached yet, not a computation error. USD
  // remains the source of truth throughout this modal regardless, so this
  // one is fine to keep as a soft fallback.
  const safeTotalSYP = useMemo(() => {
    try {
      if (exchangeRate > 0 && totalUSDValue !== null) {
        return convertCurrency(totalUSDValue, exchangeRate, "USD", "SYP");
      }
      return null;
    } catch {
      return null;
    }
  }, [totalUSDValue, exchangeRate]);

  // [FIX — setState-in-effect] `totalUSDValue`/`safeTotalSYP` are already
  // computed synchronously above (they're plain `useMemo`s, not state), so
  // this effect's body was calling six `setState` functions back-to-back,
  // directly and synchronously, the moment the effect ran — exactly the
  // pattern React flags ("Calling setState synchronously within an effect
  // can trigger cascading renders"). An effect is meant to synchronize
  // with an external system or react to one via a callback, not fire a
  // batch of setState calls as its own first action. Deferring via
  // `setTimeout(0)` moves the calls into a macrotask callback — the same
  // fix already applied to the equivalent reset effect in
  // walk-in-customer-modal.tsx — which satisfies React's effect model
  // without changing when initialization actually happens from the
  // cashier's perspective (still "as soon as the modal opens"). The
  // `cleared` guard stops the deferred callback from touching state after
  // this effect has already been cleaned up — e.g. `open` flips again, or
  // the modal unmounts, before the timeout fires.
  useEffect(() => {
    if (!open || totalUSDValue === null) return;

    let cleared = false;
    const timeoutId = setTimeout(() => {
      if (cleared) return;
      setMode("FULL_CASH");
      onPaymentModeChange?.("FULL_CASH");
      setSelectedRail("CASH");
      setPaidUSDInput(totalUSDValue);
      if (safeTotalSYP) {
        setPaidSYPInput(toDecimal(safeTotalSYP).toFixed(0));
      } else {
        setPaidSYPInput("");
      }
      setErrorMessage(null);
      setIsSubmitting(false);
    }, 0);

    return () => {
      cleared = true;
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Handle Mode Change
  function handleModeChange(newMode: PaymentMode) {
    if (totalUSDValue === null) return;
    setMode(newMode);
    onPaymentModeChange?.(newMode);
    setErrorMessage(null);

    if (newMode === "FULL_CASH") {
      setPaidUSDInput(totalUSDValue);
      if (safeTotalSYP) {
        setPaidSYPInput(toDecimal(safeTotalSYP).toFixed(0));
      }
    } else if (newMode === "FULL_DEBT") {
      setPaidUSDInput("0.0000");
      setPaidSYPInput("0");
    } else if (newMode === "PARTIAL") {
      try {
        const halfUSD = toDecimal(totalUSDValue).dividedBy(2).toFixed(4);
        setPaidUSDInput(halfUSD);
        if (exchangeRate > 0) {
          const halfSYP = convertCurrency(halfUSD, exchangeRate, "USD", "SYP");
          setPaidSYPInput(toDecimal(halfSYP).toFixed(0));
        }
      } catch {
        setPaidUSDInput("0.0000");
        setPaidSYPInput("0");
      }
    }

    if (newMode !== "FULL_CASH" && (!selectedCustomer || isSystemCashCustomer(selectedCustomer))) {
      onOpenCustomerModal();
    }
  }

  function handlePaidUSDChange(val: string) {
    setPaidUSDInput(val);
    try {
      if (val.trim() && !isNaN(Number(val)) && Number(val) >= 0 && exchangeRate > 0) {
        const syp = convertCurrency(val.trim(), exchangeRate, "USD", "SYP");
        setPaidSYPInput(toDecimal(syp).toFixed(0));
      } else {
        setPaidSYPInput("");
      }
    } catch {
      setPaidSYPInput("");
    }
  }

  function handlePaidSYPChange(val: string) {
    setPaidSYPInput(val);
    try {
      if (val.trim() && !isNaN(Number(val)) && Number(val) >= 0 && exchangeRate > 0) {
        const usd = convertCurrency(val.trim(), exchangeRate, "SYP", "USD");
        setPaidUSDInput(usd);
      } else {
        setPaidUSDInput("");
      }
    } catch {
      setPaidUSDInput("");
    }
  }

  // [FIX — critical] `paidInputParsed` is the RAW parsed value of what the
  // cashier actually typed — `null` if it isn't a valid number at all.
  // Previously, a partial-payment amount greater than the invoice total
  // was silently CLAMPED down to the total for the value that got saved
  // (`computedPaidUSD`), while the on-screen input field kept showing
  // whatever the cashier had typed. That meant the confirmed invoice could
  // record a different `paidAmountUSD` than the number the cashier saw
  // and approved — a real accounting discrepancy, not just a UI quirk.
  // There is no more clamping anywhere in this file: an out-of-range or
  // invalid amount is surfaced as a blocking validation error instead
  // (see `paidValidationError` below), and the confirm button is disabled
  // until it's fixed. What's on screen and what gets saved are now
  // guaranteed to be the same value.
  const paidInputParsed = useMemo(() => {
    if (mode === "FULL_CASH") return totalUSDValue;
    if (mode === "FULL_DEBT") return "0.0000";
    if (!paidUSDInput.trim()) return "0.0000";
    try {
      return serializeMoney(paidUSDInput.trim());
    } catch {
      return null;
    }
  }, [mode, paidUSDInput, totalUSDValue]);

  const paidValidationError = useMemo(() => {
    if (mode !== "PARTIAL" || totalUSDValue === null) return null;
    if (paidInputParsed === null) {
      return "المبلغ المدخل غير صالح — يرجى إدخال رقم صحيح.";
    }
    if (compareMoney(paidInputParsed, 0) < 0) {
      return "لا يمكن أن يكون المبلغ المدفوع أقل من صفر.";
    }
    if (compareMoney(paidInputParsed, totalUSDValue) > 0) {
      return `المبلغ المدخل ($${formatMoney(paidInputParsed, "USD")}) أكبر من إجمالي الفاتورة ($${formatMoney(totalUSDValue, "USD")}) — يرجى تصحيح المبلغ.`;
    }
    return null;
  }, [mode, paidInputParsed, totalUSDValue]);

  // Only ever equals what's on screen — never silently adjusted.
  const computedPaidUSD = paidInputParsed ?? "0.0000";

  const computedDebtUSD = useMemo(() => {
    if (totalUSDValue === null || paidValidationError) return "0.0000";
    try {
      const debt = subtractMoney(totalUSDValue, computedPaidUSD);
      return compareMoney(debt, 0) > 0 ? debt : "0.0000";
    } catch {
      return "0.0000";
    }
  }, [totalUSDValue, computedPaidUSD, paidValidationError]);

  const computedPaidSYP = useMemo(() => {
    try {
      if (exchangeRate > 0) {
        return convertCurrency(computedPaidUSD, exchangeRate, "USD", "SYP");
      }
      return null;
    } catch {
      return null;
    }
  }, [computedPaidUSD, exchangeRate]);

  const computedDebtSYP = useMemo(() => {
    try {
      if (exchangeRate > 0) {
        return convertCurrency(computedDebtUSD, exchangeRate, "USD", "SYP");
      }
      return null;
    } catch {
      return null;
    }
  }, [computedDebtUSD, exchangeRate]);

  const isSystemCustomer = isSystemCashCustomer(selectedCustomer);
  const hasCustomer = !!selectedCustomer;
  const isDebtBlockedBySystemCustomer =
    compareMoney(computedDebtUSD, 0) > 0 && (!hasCustomer || isSystemCustomer);

  const canConfirm =
    totalUSDValue !== null &&
    !paidValidationError &&
    !isDebtBlockedBySystemCustomer &&
    exchangeRate > 0;

  async function handleConfirm() {
    setErrorMessage(null);

    if (totalUSDValue === null) {
      // Should be unreachable — the form is replaced by the blocking
      // error state below when this is null — but guarded here too since
      // this is the function that actually commits a sale.
      setErrorMessage("تعذّر حساب إجمالي الفاتورة. أعد فتح السلة والمحاولة من جديد.");
      return;
    }

    if (paidValidationError) {
      setErrorMessage(paidValidationError);
      return;
    }

    if (isDebtBlockedBySystemCustomer) {
      setErrorMessage(
        "البيع على الحساب (دين) أو الدفع الجزئي يتطلب تحديد زبون حقيقي مسجل أو تسجيل زبون جديد لحفظ رصيده."
      );
      return;
    }

    if (exchangeRate <= 0) {
      setErrorMessage("لا يمكن إتمام البيع بدون سعر صرف يومي محدد.");
      return;
    }

    const hasPaidAmount = compareMoney(computedPaidUSD, 0) > 0;
    const effectivePaymentMethod = hasPaidAmount ? selectedRail : undefined;

    setIsSubmitting(true);
    try {
      await onConfirmCheckout({
        paidAmountUSD: computedPaidUSD,
        debtAmountUSD: computedDebtUSD,
        paymentMethod: effectivePaymentMethod,
      });
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "فشل حفظ الفاتورة محلياً."
      );
      setIsSubmitting(false);
    }
  }

  // [ADDED] Fail-loud blocking state: if the invoice total itself could
  // not be computed, this modal does not present a payment form at all —
  // there is nothing trustworthy to build one on top of. No submission
  // can happen from this state, so it uses the raw `onOpenChange` prop
  // directly rather than `guardedOnOpenChange` — there is nothing for the
  // guard to protect against here.
  if (open && totalUSDValue === null) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700 dark:text-red-400 text-base font-bold">
              <AlertTriangle className="h-5 w-5" />
              تعذّر حساب إجمالي الفاتورة
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              حدث خطأ غير متوقع أثناء احتساب إجمالي السلة، ولا يمكن المتابعة إلى شاشة الدفع بأمان. الرجاء إغلاق هذه النافذة والعودة إلى السلة لمراجعتها.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end pt-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              إغلاق
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={guardedOnOpenChange}>
      <DialogContent className="sm:max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between text-lg font-bold text-zinc-900 dark:text-zinc-100">
            <span className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-emerald-600" />
              إتمام الدفع واختيار وسيلة التحصيل
            </span>
            <Badge variant="outline" className="text-xs">
              سعر الصرف: {formatMoney(exchangeRate, "SYP")} ل.س
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            حدد طريقة التحصيل: نقدي بالكامل، على الحساب (دين)، أو دفع جزئي مع
            تحديد محفظة الدفع.
          </DialogDescription>
        </DialogHeader>

        {errorMessage && (
          <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300 border border-red-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Customer Header Info */}
        <div
          className={`flex items-center justify-between rounded-xl p-3 border transition-colors ${isDebtBlockedBySystemCustomer
            ? "bg-red-50/80 border-red-300 dark:bg-red-950/40 dark:border-red-800"
            : "bg-zinc-50 border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800"
            }`}
        >
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-lg ${isSystemCustomer
                ? "bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                }`}
            >
              {isSystemCustomer ? (
                <User className="h-4 w-4" />
              ) : (
                <UserCheck className="h-4 w-4" />
              )}
            </div>
            <div>
              <span className="text-[10px] text-zinc-400 block">
                الزبون المرفق بالفاتورة
              </span>
              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                {isSystemCustomer
                  ? "زبون نقدي عام (مبيعات نقدية فقط)"
                  : selectedCustomer
                    ? selectedCustomer.name
                    : "لم يتم اختيار زبون"}
              </span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenCustomerModal}
            className={`text-xs h-8 gap-1 font-semibold ${isDebtBlockedBySystemCustomer
              ? "bg-red-600 hover:bg-red-700 text-white border-red-600"
              : ""
              }`}
          >
            <UserPlus className="h-3.5 w-3.5" />
            <span>{isDebtBlockedBySystemCustomer ? "اختر زبوناً للدين" : "تغيير الزبون"}</span>
          </Button>
        </div>

        {/* Debt Blocked Alert (when Debt > 0 and Customer is System/Cash) */}
        {isDebtBlockedBySystemCustomer && (
          <div className="rounded-xl border border-red-300 bg-red-50/90 p-3 dark:border-red-900 dark:bg-red-950/60 text-xs space-y-1.5 animate-in fade-in-50">
            <div className="flex items-center gap-2 text-red-800 dark:text-red-200 font-bold">
              <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
              <span>لا يمكن تسجيل دين على حساب &quot;زبون نقدي عام&quot;</span>
            </div>
            <p className="text-[11px] text-red-700 dark:text-red-300 leading-relaxed">
              عمليات البيع الآجل (على الحساب أو الدفع الجزئي) تتطلب تحديد زبون
              مسجل لمعرفة صاحب المديونية. يرجى اختيار زبون مسجل أو تسجيل زبون
              جديد للمتابعة.
            </p>
          </div>
        )}

        {/* Total Overview Cards */}
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-emerald-50/70 p-2.5 border border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900">
            <span className="text-[11px] text-emerald-800 dark:text-emerald-300 font-semibold block">
              إجمالي الفاتورة بالدولار
            </span>
            <span className="text-xl font-extrabold text-emerald-700 dark:text-emerald-400">
              ${formatMoney(totalUSDValue as string, "USD")}
            </span>
          </div>

          <div className="rounded-xl bg-purple-50/70 p-2.5 border border-purple-200 dark:bg-purple-950/30 dark:border-purple-900">
            <span className="text-[11px] text-purple-800 dark:text-purple-300 font-semibold block">
              المعادل بالليرة السورية
            </span>
            <span className="text-xl font-extrabold text-purple-700 dark:text-purple-400">
              {safeTotalSYP ? `${formatMoney(safeTotalSYP, "SYP")} ل.س` : "غير متاح"}
            </span>
          </div>
        </div>

        {/* Step 1: Payment Mode Toggles */}
        <div className="space-y-2">
          <Label className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
            نوع السداد
          </Label>
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant={mode === "FULL_CASH" ? "default" : "outline"}
              onClick={() => handleModeChange("FULL_CASH")}
              className={`h-11 flex-col gap-0.5 text-xs font-bold ${mode === "FULL_CASH"
                ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                : ""
                }`}
            >
              <div className="flex items-center gap-1">
                <Banknote className="h-3.5 w-3.5" />
                <span>نقدي بالكامل</span>
              </div>
              <span className="text-[10px] opacity-80">
                ${formatMoney(totalUSDValue as string, "USD")}
              </span>
            </Button>

            <Button
              type="button"
              variant={mode === "FULL_DEBT" ? "default" : "outline"}
              onClick={() => handleModeChange("FULL_DEBT")}
              className={`h-11 flex-col gap-0.5 text-xs font-bold ${mode === "FULL_DEBT"
                ? "bg-red-600 hover:bg-red-700 text-white"
                : ""
                }`}
            >
              <div className="flex items-center gap-1">
                <CreditCard className="h-3.5 w-3.5" />
                <span>على الحساب (دين)</span>
              </div>
              <span className="text-[10px] opacity-80">0$ مدفوع</span>
            </Button>

            <Button
              type="button"
              variant={mode === "PARTIAL" ? "default" : "outline"}
              onClick={() => handleModeChange("PARTIAL")}
              className={`h-11 flex-col gap-0.5 text-xs font-bold ${mode === "PARTIAL"
                ? "bg-blue-600 hover:bg-blue-700 text-white"
                : ""
                }`}
            >
              <div className="flex items-center gap-1">
                <DollarSign className="h-3.5 w-3.5" />
                <span>دفع جزئي</span>
              </div>
              <span className="text-[10px] opacity-80">كاش + دين</span>
            </Button>
          </div>
        </div>

        {/* Step 2: Partial Amount Inputs (if PARTIAL selected) */}
        {mode === "PARTIAL" && (
          <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3 dark:border-blue-900/60 dark:bg-blue-950/20 space-y-2">
            <Label className="text-xs font-bold text-blue-900 dark:text-blue-200">
              المبلغ المدفوع حالياً (كاش / إلكتروني)
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-[10px] text-zinc-500 mb-1 block">
                  المبلغ بالدولار ($)
                </span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={paidUSDInput}
                  onChange={(e) => handlePaidUSDChange(e.target.value)}
                  className={`text-xs font-bold text-center bg-white dark:bg-zinc-900 font-mono ${paidValidationError ? "border-red-400 focus-visible:ring-red-400" : ""
                    }`}
                />
              </div>

              <div>
                <span className="text-[10px] text-zinc-500 mb-1 block">
                  المعادل بالليرة (ل.س)
                </span>
                <Input
                  type="number"
                  step="1000"
                  min="0"
                  value={paidSYPInput}
                  onChange={(e) => handlePaidSYPChange(e.target.value)}
                  className="text-xs font-bold text-center bg-white dark:bg-zinc-900 font-mono"
                />
              </div>
            </div>

            {/* [ADDED] Blocking validation message — replaces the old
                silent clamp. The cashier must fix the number themselves;
                nothing here quietly substitutes a different amount. */}
            {paidValidationError && (
              <div className="flex items-center gap-1.5 text-[11px] text-red-700 dark:text-red-400 font-semibold">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{paidValidationError}</span>
              </div>
            )}

            {/* Calculated Breakdown */}
            <div className="flex items-center justify-between text-xs pt-1 border-t border-blue-100 dark:border-blue-900">
              <span className="text-zinc-600 dark:text-zinc-400">
                المتبقي على الحساب (دين):
              </span>
              <span className="font-bold text-red-600 dark:text-red-400 font-mono">
                ${formatMoney(computedDebtUSD, "USD")} (
                {computedDebtSYP ? `${formatMoney(computedDebtSYP, "SYP")} ل.س` : ""}
                )
              </span>
            </div>
          </div>
        )}

        {/* Step 3: Cash-equivalent Rail Selection (if paid amount > 0) */}
        {mode !== "FULL_DEBT" && (
          <div className="space-y-1.5">
            <Label className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
              طريقة تسليم الدفعة النقدية (Payment Rail)
            </Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PAYMENT_RAILS.map((rail) => {
                const isSelected = selectedRail === rail.id;
                const Icon = rail.icon;
                return (
                  <div
                    key={rail.id}
                    onClick={() => setSelectedRail(rail.id)}
                    className={`cursor-pointer rounded-lg border p-2 text-center transition-all ${isSelected
                      ? "border-emerald-600 bg-emerald-50/70 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200 font-bold shadow-xs"
                      : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-850 text-zinc-700 dark:text-zinc-300"
                      }`}
                  >
                    <Icon className="mx-auto h-4 w-4 mb-1 text-emerald-600 dark:text-emerald-400" />
                    <p className="text-[11px] font-semibold">{rail.label}</p>
                    <p className="text-[9px] text-zinc-400 truncate">
                      {rail.sub}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Final Confirmation Buttons */}
        <div className="flex justify-end gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => guardedOnOpenChange(false)}
            disabled={isSubmitting}
            className="text-xs"
          >
            إلغاء
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleConfirm}
            disabled={isSubmitting || !canConfirm}
            className={`text-xs font-bold px-5 ${!canConfirm
              ? "bg-zinc-300 dark:bg-zinc-800 text-zinc-500 cursor-not-allowed"
              : "bg-emerald-600 hover:bg-emerald-700 text-white"
              }`}
          >
            {isSubmitting
              ? "جاري الحفظ محلياً..."
              : isDebtBlockedBySystemCustomer
                ? "اختر زبوناً لإتمام الدين"
                : paidValidationError
                  ? "صحّح المبلغ المدخل"
                  : "تأكيد وحفظ الفاتورة محلياً"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}