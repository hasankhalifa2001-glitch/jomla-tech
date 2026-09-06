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
  onPaymentModeChange?: (mode: PaymentMode) => void;
  onOpenCustomerModal: () => void;
  onConfirmCheckout: (paymentData: {
    paidAmountSYP: string;
    debtAmountSYP: string;
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
  totalSYP,
  exchangeRate,
  selectedCustomer,
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
      return `المبلغ المدخل (${formatMoney(paidInputParsed, "SYP")} ل.س) أكبر من إجمالي الفاتورة (${formatMoney(totalSYPValue, "SYP")} ل.س) — يرجى تصحيح المبلغ.`;
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
  const computedPaidUSD = useMemo(() => {
    try {
      if (exchangeRate > 0) {
        return convertCurrency(computedPaidSYP, exchangeRate, "SYP", "USD");
      }
      return null;
    } catch {
      return null;
    }
  }, [computedPaidSYP, exchangeRate]);

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

  const canConfirm =
    totalSYPValue !== null &&
    !paidValidationError &&
    !isDebtBlockedBySystemCustomer &&
    exchangeRate > 0;

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

    if (exchangeRate <= 0) {
      setErrorMessage("لا يمكن إتمام البيع بدون سعر صرف يومي محدد.");
      return;
    }

    const hasPaidAmount = compareMoney(computedPaidSYP, 0) > 0;
    const effectivePaymentMethod = hasPaidAmount ? selectedRail : undefined;

    setIsSubmitting(true);
    try {
      // [v3.6] Sends only the SYP-authoritative fields — matches
      // OfflineSalePayload (pos-service.ts), which no longer accepts
      // totalUSD/paidAmountUSD/debtAmountUSD at all.
      await onConfirmCheckout({
        paidAmountSYP: computedPaidSYP,
        debtAmountSYP: computedDebtSYP,
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
  if (open && totalSYPValue === null) {
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
      {/*
        [FIX — mobile overflow] `sm:max-w-xl` only caps the width from the
        `sm` breakpoint up; below that shadcn's default Dialog width is a
        fixed inset from the viewport edges, which is fine. Added
        `max-h-[90vh] overflow-y-auto` because this dialog's content
        (title + customer row + totals + 3 mode buttons + rail grid +
        footer) is tall enough to exceed the viewport height on a short
        phone screen in landscape or with the on-screen keyboard open —
        without a scroll container the footer confirm button could end up
        pushed off-screen and unreachable.
      */}
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          {/*
            [FIX — mobile overflow] The title text ("إتمام الدفع واختيار
            وسيلة التحصيل") plus the exchange-rate Badge used to share one
            `justify-between` row. On a ~320-375px phone, after dialog
            padding, that combination doesn't reliably fit on one line —
            stacked here below `sm`, side-by-side from `sm` up where
            there's room.
          */}
          <DialogTitle className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:justify-between text-lg font-bold text-zinc-900 dark:text-zinc-100">
            <span className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-emerald-600 shrink-0" />
              إتمام الدفع واختيار وسيلة التحصيل
            </span>
            <Badge variant="outline" className="text-xs shrink-0">
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

        {/*
          Customer Header Info.
          [FIX — mobile overflow] Neither side of this row could shrink or
          truncate before: a long registered customer name on the left
          and a long button label ("اختر زبوناً للدين") on the right, both
          sitting in a plain `justify-between` flex row, could together
          exceed a narrow dialog's width with nothing able to give way.
          `flex-wrap` lets the button drop to its own line if needed, and
          `min-w-0` + `truncate` on the name block lets a long customer
          name shorten instead of forcing an overflow.
        */}
        <div
          className={`flex flex-wrap items-center justify-between gap-2 rounded-xl p-3 border transition-colors ${isDebtBlockedBySystemCustomer
            ? "bg-red-50/80 border-red-300 dark:bg-red-950/40 dark:border-red-800"
            : "bg-zinc-50 border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800"
            }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isSystemCustomer
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
            <div className="min-w-0">
              <span className="text-[10px] text-zinc-400 block">
                الزبون المرفق بالفاتورة
              </span>
              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block truncate">
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
            className={`text-xs h-8 gap-1 font-semibold shrink-0 ${isDebtBlockedBySystemCustomer
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

        {/*
          Total Overview Cards.
          [v3.6] FIX — SYP is now the primary/authoritative card (was the
          "المعادل" secondary card before); USD is now the derived,
          possibly-unavailable secondary card (was the primary "إجمالي
          الفاتورة بالدولار" card before).
          [FIX — mobile overflow] Large SYP totals (6-7 digits + "ل.س")
          at `text-xl font-extrabold` could get tight inside a ~150px-wide
          card on a 320px phone. Stepped the size down to `text-lg` below
          `sm` and back up to `text-xl` from `sm` up, and allowed the
          figure to wrap onto a second line (`break-words`) instead of
          silently overflowing its card on the narrowest screens.
        */}
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-emerald-50/70 p-2.5 border border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900">
            <span className="text-[11px] text-emerald-800 dark:text-emerald-300 font-semibold block">
              إجمالي الفاتورة بالليرة السورية
            </span>
            <span className="text-lg sm:text-xl font-extrabold text-emerald-700 dark:text-emerald-400 wrap-break-word">
              {formatMoney(totalSYPValue as string, "SYP")} ل.س
            </span>
          </div>

          <div className="rounded-xl bg-purple-50/70 p-2.5 border border-purple-200 dark:bg-purple-950/30 dark:border-purple-900">
            <span className="text-[11px] text-purple-800 dark:text-purple-300 font-semibold block">
              المعادل بالدولار
            </span>
            <span className="text-lg sm:text-xl font-extrabold text-purple-700 dark:text-purple-400 wrap-break-word">
              {safeTotalUSD ? `$${formatMoney(safeTotalUSD, "USD")}` : "غير متاح"}
            </span>
          </div>
        </div>

        {/* Step 1: Payment Mode Toggles */}
        <div className="space-y-2">
          <Label className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
            نوع السداد
          </Label>
          {/*
            [FIX — mobile clipping] Three Arabic labels — including
            "على الحساب (دين)" — plus an amount line, squeezed into
            `grid-cols-3` at a fixed `h-11`, is workable on a tablet/
            desktop-width dialog but too tight on a 320-375px phone: the
            label can wrap inside a height that wasn't sized for two
            lines, clipping it. Stacked to one column below `sm` (each
            button becomes a full-width row with plenty of room) and back
            to three columns from `sm` up. `min-h-11` (was `h-11`) lets a
            button grow if its content ever needs a touch more vertical
            space, without shrinking below a comfortable tap target.
          */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Button
              type="button"
              variant={mode === "FULL_CASH" ? "default" : "outline"}
              onClick={() => handleModeChange("FULL_CASH")}
              className={`min-h-11 flex-col gap-0.5 text-xs font-bold ${mode === "FULL_CASH"
                ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                : ""
                }`}
            >
              <div className="flex items-center gap-1">
                <Banknote className="h-3.5 w-3.5" />
                <span>نقدي بالكامل</span>
              </div>
              <span className="text-[10px] opacity-80">
                {formatMoney(totalSYPValue as string, "SYP")} ل.س
              </span>
            </Button>

            <Button
              type="button"
              variant={mode === "FULL_DEBT" ? "default" : "outline"}
              onClick={() => handleModeChange("FULL_DEBT")}
              className={`min-h-11 flex-col gap-0.5 text-xs font-bold ${mode === "FULL_DEBT"
                ? "bg-red-600 hover:bg-red-700 text-white"
                : ""
                }`}
            >
              <div className="flex items-center gap-1">
                <CreditCard className="h-3.5 w-3.5" />
                <span>على الحساب (دين)</span>
              </div>
              <span className="text-[10px] opacity-80">0 ل.س مدفوع</span>
            </Button>

            <Button
              type="button"
              variant={mode === "PARTIAL" ? "default" : "outline"}
              onClick={() => handleModeChange("PARTIAL")}
              className={`min-h-11 flex-col gap-0.5 text-xs font-bold ${mode === "PARTIAL"
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
                  المبلغ بالليرة (ل.س)
                </span>
                <Input
                  type="number"
                  step="1000"
                  min="0"
                  value={paidSYPInput}
                  onChange={(e) => handlePaidSYPChange(e.target.value)}
                  className={`text-xs font-bold text-center bg-white dark:bg-zinc-900 font-mono ${paidValidationError ? "border-red-400 focus-visible:ring-red-400" : ""
                    }`}
                />
              </div>

              <div>
                <span className="text-[10px] text-zinc-500 mb-1 block">
                  المعادل بالدولار ($)
                </span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={paidUSDInput}
                  onChange={(e) => handlePaidUSDChange(e.target.value)}
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

            {/*
              Calculated Breakdown.
              [FIX — mobile overflow] Was a single `justify-between` row
              with a long label on one side and a long, two-currency
              figure ("270,000 ل.س (≈ $2.00)") on the other — the exact
              combination most likely to overflow a narrow dialog. Allowed
              wrapping and let the figure take its own line under the
              label when space is tight, instead of forcing one line.
            */}
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs pt-1 border-t border-blue-100 dark:border-blue-900">
              <span className="text-zinc-600 dark:text-zinc-400">
                المتبقي على الحساب (دين):
              </span>
              <span className="font-bold text-red-600 dark:text-red-400 font-mono">
                {formatMoney(computedDebtSYP, "SYP")} ل.س
                {computedDebtUSD ? ` (≈ $${formatMoney(computedDebtUSD, "USD")})` : ""}
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

        {/*
          Final Confirmation Buttons.
          [FIX — mobile overflow] Two buttons in a plain `justify-end` row
          don't wrap or shrink — the confirm button's label changes
          dynamically ("اختر زبوناً لإتمام الدين", "تأكيد وحفظ الفاتورة
          محلياً") and some of those strings are long enough that, next to
          the Cancel button, the pair can exceed a narrow dialog's width
          with no fallback. Stacked full-width (confirm on top, since
          it's the primary action) below `sm`, back to a compact
          right-aligned row from `sm` up.
        */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => guardedOnOpenChange(false)}
            disabled={isSubmitting}
            className="text-xs w-full sm:w-auto"
          >
            إلغاء
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleConfirm}
            disabled={isSubmitting || !canConfirm}
            className={`text-xs font-bold px-5 w-full sm:w-auto ${!canConfirm
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