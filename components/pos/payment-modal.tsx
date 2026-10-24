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
import { isSystemCashCustomer, FirstTimeCreditConfirmationRequiredError } from "@/lib/offline";
import {
  subtractMoney,
  convertCurrency,
  compareMoney,
  serializeMoney,
  toDecimal,
  type MoneyInput,
} from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import { fmtMoney } from "@/lib/utils/digits";
import { Money } from "./money";

export type PaymentMode = "FULL_CASH" | "FULL_DEBT" | "PARTIAL";

/**
 * What the modal hands to `onConfirmCheckout`. `firstTimeCreditConfirmed` is
 * set only on the second call, after the cashier confirmed a first-time
 * credit sale (see FirstTimeCreditConfirmationRequiredError in pos-service.ts).
 */
export type PaymentConfirmData = {
  paidAmountSYP: string;
  debtAmountSYP: string;
  paymentMethod?: PaymentMethod;
  firstTimeCreditConfirmed?: boolean;
};

interface PaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // [v3.6] AUTHORITATIVE — the field every validation and the confirm
  // action itself are built on. Always a valid numeric string once the
  // cart has items (CartTotalsResult.totalSYP is never null).
  totalSYP: MoneyInput;
  // [v3.6] Accepted for interface compatibility with callers that already
  // pass the cart's derived USD figure (e.g. pos-layout.tsx), but
  // deliberately NOT read anywhere below. This modal derives its own USD
  // display value from `totalSYP` + `exchangeRate` internally (see
  // `safeTotalUSD`) — the same "never trust a second, independently-
  // supplied number for the same amount" principle pos-service.ts and
  // db.ts already apply (see the removed USD cross-check note in
  // pos-service.ts). Accepting-but-ignoring it here means a caller can't
  // accidentally feed this modal a USD figure that drifted from totalSYP.
  totalUSD?: MoneyInput | null;
  exchangeRate: number;
  selectedCustomer: SelectedCustomer | null;
  // [T4b] When false, checkout is NOT gated on exchangeRate > 0 — i.e.
  // the cart contains only SYP-priced items and resolves without a rate.
  // Defaults to true for backward compatibility with any caller that
  // doesn't inspect the cart's pricingCurrency mix.
  requiresExchangeRate?: boolean;
  onPaymentModeChange?: (mode: PaymentMode) => void;
  onOpenCustomerModal: () => void;
  onConfirmCheckout: (paymentData: PaymentConfirmData) => Promise<void>;
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

type ModeTone = "emerald" | "red" | "blue";

const MODE_ACTIVE: Record<ModeTone, string> = {
  emerald: "border-emerald-600 bg-emerald-600 text-white shadow-sm shadow-emerald-900/20",
  red: "border-red-600 bg-red-600 text-white shadow-sm shadow-red-900/20",
  blue: "border-blue-600 bg-blue-600 text-white shadow-sm shadow-blue-900/20",
};

/** One of the three "نوع السداد" choices. */
function ModeButton({
  active,
  tone,
  icon,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  tone: ModeTone;
  icon: React.ReactNode;
  label: string;
  sub: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl border px-2 py-2 text-xs font-extrabold transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 active:scale-[0.98]",
        active
          ? MODE_ACTIVE[tone]
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
      )}
    >
      <span className="flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className={cn("text-[10px] font-semibold", active ? "text-white/80" : "text-slate-500")}>{sub}</span>
    </button>
  );
}

export function PaymentModal({
  open,
  onOpenChange,
  totalSYP,
  exchangeRate,
  selectedCustomer,
  requiresExchangeRate = true,
  onPaymentModeChange,
  onOpenCustomerModal,
  onConfirmCheckout,
}: PaymentModalProps) {
  const [mode, setMode] = useState<PaymentMode>("FULL_CASH");
  const [selectedRail, setSelectedRail] = useState<PaymentMethod>("CASH");
  const [paidSYPInput, setPaidSYPInput] = useState<string>("");
  const [paidUSDInput, setPaidUSDInput] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // First-time credit confirmation. When set, the dialog shows the
  // confirmation panel (a content swap inside this SAME Dialog — never a
  // nested Radix dialog) instead of the payment form.
  const [creditConfirm, setCreditConfirm] = useState<{
    customerName: string;
    paymentData: PaymentConfirmData;
  } | null>(null);

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
    // Closing the dialog always discards a pending first-time-credit
    // confirmation, so reopening never starts on a stale confirmation panel.
    if (!next) setCreditConfirm(null);
    onOpenChange(next);
  }

  // [v3.6] FIX — this used to be `totalUSDValue`, serializing the
  // (formerly authoritative) `totalUSD` prop. SYP is now the authoritative
  // figure (schema.prisma / pos-service.ts / db.ts), so this modal's
  // "can't build a trustworthy payment form" fail-loud guard now lives on
  // `totalSYP` instead. A genuinely malformed `totalSYP` reaching this
  // modal is a real upstream bug and must be surfaced (see the blocking
  // error state below), never silently treated as "0".
  const totalSYPValue = useMemo(() => {
    try {
      return serializeMoney(totalSYP);
    } catch {
      return null;
    }
  }, [totalSYP]);

  // [v3.6] FIX — this used to be `safeTotalSYP`, converting FROM the
  // authoritative USD figure. Now derives USD (display-only, may
  // legitimately be `null` when no exchange rate is cached yet — same
  // "غير متاح" UI treatment as before, just on the other currency) FROM
  // the authoritative `totalSYPValue`.
  const safeTotalUSD = useMemo(() => {
    try {
      if (exchangeRate > 0 && totalSYPValue !== null) {
        return convertCurrency(totalSYPValue, exchangeRate, "SYP", "USD");
      }
      return null;
    } catch {
      return null;
    }
  }, [totalSYPValue, exchangeRate]);

  // [FIX — setState-in-effect] `totalSYPValue`/`safeTotalUSD` are already
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
    if (!open || totalSYPValue === null) return;

    let cleared = false;
    const timeoutId = setTimeout(() => {
      if (cleared) return;
      setMode("FULL_CASH");
      onPaymentModeChange?.("FULL_CASH");
      setSelectedRail("CASH");
      setPaidSYPInput(toDecimal(totalSYPValue).toFixed(0));
      if (safeTotalUSD) {
        setPaidUSDInput(safeTotalUSD);
      } else {
        setPaidUSDInput("");
      }
      setErrorMessage(null);
      setIsSubmitting(false);
      setCreditConfirm(null);
    }, 0);

    return () => {
      cleared = true;
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Handle Mode Change
  function handleModeChange(newMode: PaymentMode) {
    if (totalSYPValue === null) return;
    setMode(newMode);
    onPaymentModeChange?.(newMode);
    setErrorMessage(null);

    if (newMode === "FULL_CASH") {
      setPaidSYPInput(toDecimal(totalSYPValue).toFixed(0));
      if (safeTotalUSD) {
        setPaidUSDInput(safeTotalUSD);
      }
    } else if (newMode === "FULL_DEBT") {
      setPaidSYPInput("0");
      setPaidUSDInput("0.0000");
    } else if (newMode === "PARTIAL") {
      try {
        const halfSYP = toDecimal(totalSYPValue).dividedBy(2).toFixed(0);
        setPaidSYPInput(halfSYP);
        if (exchangeRate > 0) {
          const halfUSD = convertCurrency(halfSYP, exchangeRate, "SYP", "USD");
          setPaidUSDInput(halfUSD);
        }
      } catch {
        setPaidSYPInput("0");
        setPaidUSDInput("0.0000");
      }
    }

    if (newMode !== "FULL_CASH" && (!selectedCustomer || isSystemCashCustomer(selectedCustomer))) {
      onOpenCustomerModal();
    }
  }

  // [v3.6] Primary editing handler — SYP is the field the cashier's typed
  // amount is trusted from.
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

  // Secondary/convenience handler — editing the USD field back-fills SYP,
  // but SYP (via handlePaidSYPChange / paidSYPInput) remains what's
  // actually validated and submitted below.
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

  // [FIX — critical] `paidInputParsed` is the RAW parsed value of what the
  // cashier actually typed — `null` if it isn't a valid number at all.
  // There is no clamping anywhere in this file: an out-of-range or
  // invalid amount is surfaced as a blocking validation error instead
  // (see `paidValidationError` below), and the confirm button is disabled
  // until it's fixed. What's on screen and what gets saved are guaranteed
  // to be the same value.
  //
  // [v3.6] Now parses `paidSYPInput` (authoritative) instead of
  // `paidUSDInput`.
  const paidInputParsed = useMemo(() => {
    if (mode === "FULL_CASH") return totalSYPValue;
    if (mode === "FULL_DEBT") return "0.0000";
    if (!paidSYPInput.trim()) return "0.0000";
    try {
      return serializeMoney(paidSYPInput.trim());
    } catch {
      return null;
    }
  }, [mode, paidSYPInput, totalSYPValue]);

  const paidValidationError = useMemo(() => {
    if (mode !== "PARTIAL" || totalSYPValue === null) return null;
    if (paidInputParsed === null) {
      return "المبلغ المدخل غير صالح — يرجى إدخال رقم صحيح.";
    }
    if (compareMoney(paidInputParsed, 0) < 0) {
      return "لا يمكن أن يكون المبلغ المدفوع أقل من صفر.";
    }
    if (compareMoney(paidInputParsed, totalSYPValue) > 0) {
      return `المبلغ المدخل (${fmtMoney(paidInputParsed, "SYP")} ل.س) أكبر من إجمالي الفاتورة (${fmtMoney(totalSYPValue, "SYP")} ل.س) — يرجى تصحيح المبلغ.`;
    }
    return null;
  }, [mode, paidInputParsed, totalSYPValue]);

  // Only ever equals what's on screen — never silently adjusted.
  const computedPaidSYP = paidInputParsed ?? "0.0000";

  const computedDebtSYP = useMemo(() => {
    if (totalSYPValue === null || paidValidationError) return "0.0000";
    try {
      const debt = subtractMoney(totalSYPValue, computedPaidSYP);
      return compareMoney(debt, 0) > 0 ? debt : "0.0000";
    } catch {
      return "0.0000";
    }
  }, [totalSYPValue, computedPaidSYP, paidValidationError]);

  // Derived/display-only — may be null with no cached rate. Never sent to
  // onConfirmCheckout.
  const computedDebtUSD = useMemo(() => {
    try {
      if (exchangeRate > 0) {
        return convertCurrency(computedDebtSYP, exchangeRate, "SYP", "USD");
      }
      return null;
    } catch {
      return null;
    }
  }, [computedDebtSYP, exchangeRate]);

  const isSystemCustomer = isSystemCashCustomer(selectedCustomer);
  const hasCustomer = !!selectedCustomer;
  const isDebtBlockedBySystemCustomer =
    compareMoney(computedDebtSYP, 0) > 0 && (!hasCustomer || isSystemCustomer);

  // [T4b] A missing rate blocks checkout only when at least one cart item
  // is priced in USD (requiresExchangeRate === true). A SYP-only cart
  // resolves without any rate and must never be blocked here.
  // Acceptance criteria: "checkout blocks only for a USD-priced item with
  // no cached rate, never for SYP-only carts."
  const rateIsBlocking = requiresExchangeRate && exchangeRate <= 0;

  const canConfirm =
    totalSYPValue !== null &&
    !paidValidationError &&
    !isDebtBlockedBySystemCustomer &&
    !rateIsBlocking;

  async function handleConfirm() {
    setErrorMessage(null);

    if (totalSYPValue === null) {
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

    // [T4b] Only block on a missing rate when the cart contains USD-priced
    // items — mirrors the rateIsBlocking logic computed at render time.
    if (rateIsBlocking) {
      setErrorMessage(
        "لا يمكن إتمام البيع: يوجد في السلة صنف مسعّر بالدولار ولا يوجد سعر صرف يومي محفوظ."
      );
      return;
    }

    const hasPaidAmount = compareMoney(computedPaidSYP, 0) > 0;
    const effectivePaymentMethod = hasPaidAmount ? selectedRail : undefined;

    setIsSubmitting(true);
    // [v3.6] Sends only the SYP-authoritative fields — matches
    // OfflineSalePayload (pos-service.ts), which no longer accepts
    // totalUSD/paidAmountUSD/debtAmountUSD at all.
    const paymentData: PaymentConfirmData = {
      paidAmountSYP: computedPaidSYP,
      debtAmountSYP: computedDebtSYP,
      paymentMethod: effectivePaymentMethod,
    };
    try {
      await onConfirmCheckout(paymentData);
    } catch (err: unknown) {
      // A debt sale to a customer with no prior dealings: nothing was
      // written (the service throws before any Dexie write). Ask the
      // cashier to confirm instead of showing a generic error.
      if (err instanceof FirstTimeCreditConfirmationRequiredError) {
        setCreditConfirm({ customerName: err.customer.name, paymentData });
        setIsSubmitting(false);
        return;
      }
      setErrorMessage(
        err instanceof Error ? err.message : "فشل حفظ الفاتورة محلياً."
      );
      setIsSubmitting(false);
    }
  }

  // Second call, after the cashier confirmed the first-time credit sale.
  async function handleConfirmFirstTimeCredit() {
    if (!creditConfirm) return;
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await onConfirmCheckout({
        ...creditConfirm.paymentData,
        firstTimeCreditConfirmed: true,
      });
      // Success: the parent closes this dialog. Clear the confirmation state
      // so a later reopen never flashes a stale confirmation panel.
      setCreditConfirm(null);
    } catch (err: unknown) {
      setCreditConfirm(null);
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
  if (open && totalSYPValue === null) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-extrabold text-red-700">
              <span className="flex size-8 items-center justify-center rounded-lg bg-red-100">
                <AlertTriangle className="size-4" aria-hidden />
              </span>
              تعذّر حساب إجمالي الفاتورة
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed text-slate-600">
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

  // First-time credit confirmation: a content swap inside the SAME Dialog
  // (one focus trap), not a nested Radix dialog. "رجوع" is the autofocused
  // default so a stray Enter never confirms the debt.
  if (open && creditConfirm) {
    return (
      <Dialog open={open} onOpenChange={guardedOnOpenChange}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-extrabold text-amber-800">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-100">
                <AlertTriangle className="size-4" aria-hidden />
              </span>
              أول تعامل مع الزبون
            </DialogTitle>
            <DialogDescription className="wrap-break-word text-sm leading-relaxed text-slate-700">
              هذا أول تعامل مع <span className="font-extrabold">{creditConfirm.customerName}</span>.
              تسجّل الدين عليه؟
            </DialogDescription>
          </DialogHeader>

          {errorMessage && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700"
            >
              <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              autoFocus
              disabled={isSubmitting}
              onClick={() => setCreditConfirm(null)}
              className="h-11 w-full border-slate-200 text-sm font-semibold text-slate-700 sm:w-auto"
            >
              رجوع
            </Button>
            <Button
              type="button"
              disabled={isSubmitting}
              onClick={() => void handleConfirmFirstTimeCredit()}
              className="h-11 w-full bg-emerald-600 px-6 text-sm font-extrabold text-white shadow-sm shadow-emerald-900/20 hover:bg-emerald-700 sm:w-auto"
            >
              {isSubmitting ? "جاري الحفظ محلياً..." : "تأكيد وتسجيل الدين"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={guardedOnOpenChange}>
      {/*
        [FIX — mobile overflow] `max-h` + `overflow-y-auto`: this dialog's
        content (title + customer row + totals + 3 mode buttons + rail grid +
        footer) is tall enough to exceed the viewport on a short phone screen
        or with the on-screen keyboard open — without a scroll container the
        confirm button could be pushed off-screen. `dvh` follows the real
        visible viewport on mobile browsers.
      */}
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" dir="rtl">
        <DialogHeader>
          {/* Stacked below `sm` (title + rate chip don't fit one line on a
              320–375px phone), side by side from `sm` up. */}
          <DialogTitle className="flex flex-col items-start gap-2 text-lg font-extrabold text-slate-900 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                <Receipt className="size-4.5" aria-hidden />
              </span>
              إتمام الدفع
            </span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-bold",
                rateIsBlocking
                  ? "border-red-300 bg-red-50 text-red-700"
                  : "border-slate-200 bg-slate-50 text-slate-600"
              )}
            >
              {exchangeRate > 0
                ? `سعر الصرف: ${fmtMoney(exchangeRate, "SYP")} ل.س`
                : requiresExchangeRate
                  ? "⚠ سعر الصرف غير محدد"
                  : "أسعار الليرة — لا يلزم سعر صرف"}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            حدد طريقة التحصيل: نقدي بالكامل، على الحساب (دين)، أو دفع جزئي مع
            تحديد محفظة الدفع.
          </DialogDescription>
        </DialogHeader>

        {errorMessage && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700"
          >
            <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden />
            <span>{errorMessage}</span>
          </div>
        )}

        {/*
          Customer row. `flex-wrap` lets the button drop to its own line on a
          narrow dialog, and `min-w-0` + `truncate` on the name block lets a
          long customer name shorten instead of forcing an overflow.
        */}
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 transition-colors",
            isDebtBlockedBySystemCustomer ? "border-red-300 bg-red-50" : "border-slate-200 bg-slate-50"
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                isSystemCustomer ? "bg-slate-200 text-slate-600" : "bg-emerald-100 text-emerald-700"
              )}
              aria-hidden
            >
              {isSystemCustomer ? <User className="size-4" /> : <UserCheck className="size-4" />}
            </span>
            <div className="min-w-0">
              <span className="block text-[11px] text-slate-500">الزبون المرفق بالفاتورة</span>
              <span className="block truncate text-[13px] font-extrabold text-slate-900">
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
            className={cn(
              "h-9 shrink-0 gap-1.5 text-xs font-bold",
              isDebtBlockedBySystemCustomer
                ? "border-red-600 bg-red-600 text-white hover:bg-red-700 hover:text-white"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            )}
          >
            <UserPlus className="size-3.5" aria-hidden />
            {isDebtBlockedBySystemCustomer ? "اختر زبوناً للدين" : "تغيير الزبون"}
          </Button>
        </div>

        {/* Debt Blocked Alert (when Debt > 0 and Customer is System/Cash) */}
        {isDebtBlockedBySystemCustomer && (
          <div className="animate-in space-y-1.5 rounded-xl border border-red-200 bg-red-50 p-3 text-xs duration-200 fade-in-0 motion-reduce:animate-none">
            <div className="flex items-center gap-2 font-extrabold text-red-800">
              <AlertTriangle className="size-4 shrink-0 text-red-600" aria-hidden />
              <span>لا يمكن تسجيل دين على حساب &quot;زبون نقدي عام&quot;</span>
            </div>
            <p className="text-[11px] leading-relaxed text-red-700">
              عمليات البيع الآجل (على الحساب أو الدفع الجزئي) تتطلب تحديد زبون
              مسجل لمعرفة صاحب المديونية. يرجى اختيار زبون مسجل أو تسجيل زبون
              جديد للمتابعة.
            </p>
          </div>
        )}

        {/*
          Totals. [v3.6] SYP is the primary/authoritative card; USD is the
          derived, possibly-unavailable secondary card. `break-words` lets a
          large figure wrap on the narrowest screens instead of overflowing.
        */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-emerald-700 bg-linear-to-br from-emerald-600 to-emerald-800 p-3 text-white shadow-md shadow-emerald-900/20">
            <span className="block text-[11px] font-semibold text-emerald-100">إجمالي الفاتورة</span>
            <Money
              value={totalSYPValue as string}
              className="mt-0.5 wrap-break-word text-xl font-extrabold leading-tight sm:text-2xl"
              unitClassName="text-emerald-100"
            />
          </div>

          <div className="rounded-xl border border-purple-200 bg-purple-50 p-3">
            <span className="block text-[11px] font-semibold text-purple-800">المعادل بالدولار</span>
            <span className="mt-0.5 block wrap-break-word text-xl font-extrabold leading-tight text-purple-700 sm:text-2xl">
              {safeTotalUSD ? (
                <Money value={safeTotalUSD} currency="USD" />
              ) : (
                <span className="text-base font-bold text-purple-400">غير متاح</span>
              )}
            </span>
          </div>
        </div>

        {/* Step 1: Payment Mode */}
        <div className="space-y-2">
          <Label className="text-xs font-extrabold text-slate-700">نوع السداد</Label>
          {/* One column below `sm` (each choice a full-width row), three from `sm` up. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <ModeButton
              active={mode === "FULL_CASH"}
              tone="emerald"
              icon={<Banknote className="size-4" aria-hidden />}
              label="نقدي بالكامل"
              sub={`${fmtMoney(totalSYPValue as string, "SYP")} ل.س`}
              onClick={() => handleModeChange("FULL_CASH")}
            />
            <ModeButton
              active={mode === "FULL_DEBT"}
              tone="red"
              icon={<CreditCard className="size-4" aria-hidden />}
              label="على الحساب (دين)"
              sub="0 ل.س مدفوع"
              onClick={() => handleModeChange("FULL_DEBT")}
            />
            <ModeButton
              active={mode === "PARTIAL"}
              tone="blue"
              icon={<DollarSign className="size-4" aria-hidden />}
              label="دفع جزئي"
              sub="كاش + دين"
              onClick={() => handleModeChange("PARTIAL")}
            />
          </div>
        </div>

        {/* Step 2: Partial Amount Inputs (if PARTIAL selected) */}
        {mode === "PARTIAL" && (
          <div className="animate-in space-y-2.5 rounded-xl border border-blue-200 bg-blue-50/60 p-3 duration-200 fade-in-0 slide-in-from-top-1 motion-reduce:animate-none">
            <Label className="text-xs font-extrabold text-blue-900">
              المبلغ المدفوع حالياً (كاش / إلكتروني)
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="mb-1 block text-[11px] text-slate-600">المبلغ بالليرة (ل.س)</span>
                <Input
                  type="number"
                  lang="en"
                  dir="ltr"
                  inputMode="numeric"
                  step="1000"
                  min="0"
                  value={paidSYPInput}
                  onChange={(e) => handlePaidSYPChange(e.target.value)}
                  className={cn(
                    "h-10 bg-white text-center font-mono text-sm font-bold tabular-nums",
                    paidValidationError && "border-red-400 focus-visible:ring-red-400"
                  )}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-slate-600">المعادل بالدولار ($)</span>
                <Input
                  type="number"
                  lang="en"
                  dir="ltr"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={paidUSDInput}
                  onChange={(e) => handlePaidUSDChange(e.target.value)}
                  className="h-10 bg-white text-center font-mono text-sm font-bold tabular-nums"
                />
              </div>
            </div>

            {/* [ADDED] Blocking validation message — replaces the old silent
                clamp. The cashier must fix the number themselves; nothing here
                quietly substitutes a different amount. */}
            {paidValidationError && (
              <div className="flex items-start gap-1.5 text-[11px] font-semibold text-red-700" role="alert">
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>{paidValidationError}</span>
              </div>
            )}

            {/* Calculated breakdown — wraps instead of overflowing on a narrow dialog. */}
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-t border-blue-100 pt-2 text-xs">
              <span className="text-slate-600">المتبقي على الحساب (دين):</span>
              <span className="font-extrabold text-red-600">
                <Money value={computedDebtSYP} compact />
                {computedDebtUSD && (
                  <span className="ms-1.5 text-[11px] font-semibold text-red-500">
                    (≈ <Money value={computedDebtUSD} currency="USD" />)
                  </span>
                )}
              </span>
            </div>
          </div>
        )}

        {/* Step 3: Cash-equivalent Rail Selection (if paid amount > 0) */}
        {mode !== "FULL_DEBT" && (
          <div className="space-y-2">
            <Label className="text-xs font-extrabold text-slate-700">طريقة تسليم الدفعة</Label>
            <div role="radiogroup" aria-label="طريقة الدفع" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PAYMENT_RAILS.map((rail) => {
                const isSelected = selectedRail === rail.id;
                const Icon = rail.icon;
                return (
                  <button
                    key={rail.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedRail(rail.id)}
                    className={cn(
                      "rounded-xl border p-2.5 text-center transition-all duration-150 active:scale-[0.98]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
                      isSelected
                        ? "border-emerald-600 bg-emerald-50 text-emerald-900 shadow-sm"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                    )}
                  >
                    <Icon
                      className={cn("mx-auto mb-1 size-4", isSelected ? "text-emerald-700" : "text-slate-400")}
                      aria-hidden
                    />
                    <p className="text-[11px] font-extrabold leading-tight">{rail.label}</p>
                    <p className="mt-0.5 truncate text-[10px] text-slate-500">{rail.sub}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/*
          Final confirmation. Stacked full-width below `sm` (confirm on top,
          since it's the primary action) because the confirm label changes
          dynamically and some strings are long; a compact end-aligned row
          from `sm` up.
        */}
        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => guardedOnOpenChange(false)}
            disabled={isSubmitting}
            className="h-11 w-full border-slate-200 text-sm font-semibold text-slate-700 sm:w-auto"
          >
            إلغاء
          </Button>

          <Button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting || !canConfirm}
            className={cn(
              "h-11 w-full px-6 text-sm font-extrabold transition-colors sm:w-auto",
              !canConfirm
                ? "cursor-not-allowed bg-slate-200 text-slate-500"
                : "bg-emerald-600 text-white shadow-sm shadow-emerald-900/20 hover:bg-emerald-700"
            )}
          >
            {isSubmitting
              ? "جاري الحفظ محلياً..."
              : isDebtBlockedBySystemCustomer
                ? "اختر زبوناً لإتمام الدين"
                : paidValidationError
                  ? "صحّح المبلغ المدخل"
                  : "تأكيد وحفظ الفاتورة"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}