"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";
import type { SelectedCustomer } from "@/lib/offline";

export type PaymentMode = "FULL_CASH" | "FULL_DEBT" | "PARTIAL";

export type PaymentRail = "CASH" | "SHAM_CASH" | "SYRIATEL_CASH" | "BANK_TRANSFER" | "OTHER";

interface PaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalUSD: number;
  exchangeRate: number;
  selectedCustomer: SelectedCustomer | null;
  onOpenCustomerModal: () => void;
  onConfirmCheckout: (paymentData: {
    paidAmountUSD: number;
    debtAmountUSD: number;
    paymentMethod: string;
  }) => Promise<void>;
}

const PAYMENT_RAILS: { id: PaymentRail; label: string; icon: typeof Banknote; sub: string }[] = [
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
  onOpenCustomerModal,
  onConfirmCheckout,
}: PaymentModalProps) {
  const [mode, setMode] = useState<PaymentMode>("FULL_CASH");
  const [selectedRail, setSelectedRail] = useState<PaymentRail>("CASH");
  const [paidUSDInput, setPaidUSDInput] = useState<string>("");
  const [paidSYPInput, setPaidSYPInput] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const totalSYP = totalUSD * exchangeRate;

  // Reset/Initialize values when opened or total changes
  useEffect(() => {
    if (open) {
      setMode("FULL_CASH");
      setSelectedRail("CASH");
      setPaidUSDInput(totalUSD.toFixed(2));
      setPaidSYPInput(Math.round(totalSYP).toString());
      setErrorMessage(null);
      setIsSubmitting(false);
    }
  }, [open, totalUSD, totalSYP]);

  // Handle Mode Change
  function handleModeChange(newMode: PaymentMode) {
    setMode(newMode);
    setErrorMessage(null);

    if (newMode === "FULL_CASH") {
      setPaidUSDInput(totalUSD.toFixed(2));
      setPaidSYPInput(Math.round(totalSYP).toString());
    } else if (newMode === "FULL_DEBT") {
      setPaidUSDInput("0");
      setPaidSYPInput("0");
    } else if (newMode === "PARTIAL") {
      const half = totalUSD / 2;
      setPaidUSDInput(half.toFixed(2));
      setPaidSYPInput(Math.round(half * exchangeRate).toString());
    }
  }

  // Handle Paid USD input
  function handlePaidUSDChange(val: string) {
    setPaidUSDInput(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0) {
      setPaidSYPInput(Math.round(num * exchangeRate).toString());
    } else {
      setPaidSYPInput("");
    }
  }

  // Handle Paid SYP input
  function handlePaidSYPChange(val: string) {
    setPaidSYPInput(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0 && exchangeRate > 0) {
      setPaidUSDInput((num / exchangeRate).toFixed(2));
    } else {
      setPaidUSDInput("");
    }
  }

  // Computed amounts
  const computedPaidUSD =
    mode === "FULL_CASH"
      ? totalUSD
      : mode === "FULL_DEBT"
      ? 0
      : Math.min(totalUSD, Math.max(0, parseFloat(paidUSDInput) || 0));

  const computedDebtUSD = Math.max(0, totalUSD - computedPaidUSD);
  const computedPaidSYP = computedPaidUSD * exchangeRate;
  const computedDebtSYP = computedDebtUSD * exchangeRate;

  async function handleConfirm() {
    setErrorMessage(null);

    // Debt validation
    if (computedDebtUSD > 0 && !selectedCustomer) {
      setErrorMessage("يتطلب تسجيل الدين (الكامل أو الجزئي) تحديد أو إنشاء زبون لحفظ رصيده.");
      return;
    }

    if (exchangeRate <= 0) {
      setErrorMessage("لا يمكن إتمام البيع بدون سعر صرف يومي صحيح.");
      return;
    }

    const effectivePaymentMethod = mode === "FULL_DEBT" ? "DEBT" : selectedRail;

    setIsSubmitting(true);
    try {
      await onConfirmCheckout({
        paidAmountUSD: computedPaidUSD,
        debtAmountUSD: computedDebtUSD,
        paymentMethod: effectivePaymentMethod,
      });
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "فشل حفظ الفاتورة محلياً.");
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between text-lg font-bold text-zinc-900 dark:text-zinc-100">
            <span className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-emerald-600" />
              إتمام الدفع واختيار وسيلة التحصيل
            </span>
            <Badge variant="outline" className="text-xs">
              سعر الصرف: {exchangeRate.toLocaleString("ar-SY")} ل.س
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            حدد طريقة التحصيل: نقدي بالكامل، على الحساب (دين)، أو دفع جزئي مع تحديد محفظة الدفع.
          </DialogDescription>
        </DialogHeader>

        {errorMessage && (
          <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300 border border-red-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Customer Header Info */}
        <div className="flex items-center justify-between rounded-xl bg-zinc-50 p-3 border border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
              <User className="h-4 w-4" />
            </div>
            <div>
              <span className="text-[10px] text-zinc-400 block">الزبون المرفق بالفاتورة</span>
              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                {selectedCustomer ? selectedCustomer.name : "زبون نقدي عام (غير مسجل)"}
              </span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenCustomerModal}
            className="text-xs h-7 gap-1"
          >
            تغيير الزبون
          </Button>
        </div>

        {/* Total Overview Cards */}
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-emerald-50/70 p-2.5 border border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900">
            <span className="text-[11px] text-emerald-800 dark:text-emerald-300 font-semibold block">
              إجمالي الفاتورة بالدولار
            </span>
            <span className="text-xl font-extrabold text-emerald-700 dark:text-emerald-400">
              ${totalUSD.toFixed(2)}
            </span>
          </div>

          <div className="rounded-xl bg-purple-50/70 p-2.5 border border-purple-200 dark:bg-purple-950/30 dark:border-purple-900">
            <span className="text-[11px] text-purple-800 dark:text-purple-300 font-semibold block">
              المعادل بالليرة السورية
            </span>
            <span className="text-xl font-extrabold text-purple-700 dark:text-purple-400">
              {Math.round(totalSYP).toLocaleString("ar-SY")} ل.س
            </span>
          </div>
        </div>

        {/* Step 1: Payment Mode Toggles */}
        <div className="space-y-2">
          <Label className="text-xs font-bold text-zinc-700 dark:text-zinc-300">نوع السداد</Label>
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant={mode === "FULL_CASH" ? "default" : "outline"}
              onClick={() => handleModeChange("FULL_CASH")}
              className={`h-11 flex-col gap-0.5 text-xs font-bold ${
                mode === "FULL_CASH" ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""
              }`}
            >
              <div className="flex items-center gap-1">
                <Banknote className="h-3.5 w-3.5" />
                <span>نقدي بالكامل</span>
              </div>
              <span className="text-[10px] opacity-80">${totalUSD.toFixed(2)}</span>
            </Button>

            <Button
              type="button"
              variant={mode === "FULL_DEBT" ? "default" : "outline"}
              onClick={() => handleModeChange("FULL_DEBT")}
              className={`h-11 flex-col gap-0.5 text-xs font-bold ${
                mode === "FULL_DEBT" ? "bg-red-600 hover:bg-red-700 text-white" : ""
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
              className={`h-11 flex-col gap-0.5 text-xs font-bold ${
                mode === "PARTIAL" ? "bg-blue-600 hover:bg-blue-700 text-white" : ""
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
                <span className="text-[10px] text-zinc-500 mb-1 block">المبلغ بالدولار ($)</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max={totalUSD}
                  value={paidUSDInput}
                  onChange={(e) => handlePaidUSDChange(e.target.value)}
                  className="text-xs font-bold text-center bg-white dark:bg-zinc-900"
                />
              </div>

              <div>
                <span className="text-[10px] text-zinc-500 mb-1 block">المعادل بالليرة (ل.س)</span>
                <Input
                  type="number"
                  step="100"
                  min="0"
                  value={paidSYPInput}
                  onChange={(e) => handlePaidSYPChange(e.target.value)}
                  className="text-xs font-bold text-center bg-white dark:bg-zinc-900"
                />
              </div>
            </div>

            {/* Calculated Breakdown */}
            <div className="flex items-center justify-between text-xs pt-1 border-t border-blue-100 dark:border-blue-900">
              <span className="text-zinc-600 dark:text-zinc-400">المتبقي على الحساب (دين):</span>
              <span className="font-bold text-red-600 dark:text-red-400">
                ${computedDebtUSD.toFixed(2)} ({Math.round(computedDebtSYP).toLocaleString("ar-SY")} ل.س)
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
                    className={`cursor-pointer rounded-lg border p-2 text-center transition-all ${
                      isSelected
                        ? "border-emerald-600 bg-emerald-50/70 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200 font-bold shadow-xs"
                        : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-850 text-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    <Icon className="mx-auto h-4 w-4 mb-1 text-emerald-600 dark:text-emerald-400" />
                    <p className="text-[11px] font-semibold">{rail.label}</p>
                    <p className="text-[9px] text-zinc-400 truncate">{rail.sub}</p>
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
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className="text-xs"
          >
            إلغاء
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-5"
          >
            {isSubmitting ? "جاري الحفظ محلياً..." : "تأكيد وحفظ الفاتورة محلياً"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
