"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Printer,
  PlusCircle,
  CloudOff,
  User,
  Calendar,
} from "lucide-react";
import type { OfflineInvoice, SelectedCustomer, CartLineItem } from "@/lib/offline";
import { formatMoney, compareMoney, multiplyMoney } from "@/lib/utils/money";

interface CheckoutSuccessModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: OfflineInvoice | null;
  customer: SelectedCustomer | null;
  items: CartLineItem[];
  onStartNewSale: () => void;
}

export function CheckoutSuccessModal({
  open,
  onOpenChange,
  invoice,
  customer,
  items,
  onStartNewSale,
}: CheckoutSuccessModalProps) {
  if (!invoice) return null;

  function handlePrint() {
    window.print();
  }

  const paymentMethodLabels: Record<string, string> = {
    CASH: "نقداً (كاش)",
    SHAM_CASH: "شام كاش (Sham Cash)",
    SYRIATEL_CASH: "سيرياتيل كاش (Syriatel)",
    BANK_TRANSFER: "تحويل بنكي / مكتب",
    OTHER: "وسيلة أخرى",
  };

  const currentMethod = invoice.paymentMethod;
  const paymentLabel = currentMethod
    ? paymentMethodLabels[currentMethod] || currentMethod
    : "على الحساب بالكامل (دين)";

  const isDebtPresent = compareMoney(invoice.debtAmountUSD, 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" dir="rtl">
        <DialogHeader>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-600 mb-2">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <DialogTitle className="text-center text-lg font-bold text-zinc-900 dark:text-zinc-100">
            تم حفظ الفاتورة محلياً بنجاح
          </DialogTitle>
          <DialogDescription className="text-center text-xs text-zinc-500">
            تم تسجيل الفاتورة في قاعدة بيانات المتصفح (Dexie) وحفظها في طابور
            المزامنة المحلي.
          </DialogDescription>
        </DialogHeader>

        {/* Clear Local Save vs Synced Status Distinction Alert */}
        <div className="rounded-xl border border-amber-300 bg-amber-50/80 p-3 dark:border-amber-900 dark:bg-amber-950/40 space-y-1.5">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-bold text-xs">
            <CloudOff className="h-4 w-4 shrink-0 text-amber-600" />
            <span>حالة الفاتورة: محفوظة محلياً — بانتظار المزامنة (PENDING)</span>
          </div>
          <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
            ⚠️ تنبيه للكاشير: هذه الفاتورة{" "}
            <strong>مخزنة على هذا الجهاز فقط</strong> حالياً. ستتم المزامنة
            التلقائية مع السيرفر المركزي فور توفر اتصال بالإنترنت (T4c).
          </p>
        </div>

        {/* Invoice Summary Printable Card */}
        <div
          id="printable-receipt"
          className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 space-y-3 dark:border-zinc-800 dark:bg-zinc-900/60 text-xs"
        >
          {/* Top metadata */}
          <div className="grid grid-cols-2 gap-2 border-b border-zinc-200 pb-2.5 dark:border-zinc-800">
            <div>
              <span className="text-[10px] text-zinc-400 block">
                رقم الفاتورة المحلي (UUID)
              </span>
              <span className="font-mono text-[11px] font-bold text-zinc-800 dark:text-zinc-200 truncate block">
                {invoice.offlineId}
              </span>
            </div>

            <div className="text-left">
              <span className="text-[10px] text-zinc-400 block">
                التاريخ والوقت
              </span>
              <span className="text-[11px] text-zinc-600 dark:text-zinc-400 flex items-center justify-end gap-1">
                <Calendar className="h-3 w-3" />
                {new Date(invoice.createdAt).toLocaleTimeString("ar-SY", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <div>
              <span className="text-[10px] text-zinc-400 block">الزبون</span>
              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 flex items-center gap-1">
                <User className="h-3 w-3 text-zinc-400" />
                {customer ? customer.name : "زبون نقدي عام"}
              </span>
            </div>

            <div className="text-left">
              <span className="text-[10px] text-zinc-400 block">
                طريقة السداد
              </span>
              <Badge variant="outline" className="text-[10px] font-semibold">
                {paymentLabel}
              </Badge>
            </div>
          </div>

          {/* Items Summary Table */}
          <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
            <div className="grid grid-cols-12 text-[10px] font-bold text-zinc-400 pb-1 border-b border-zinc-200 dark:border-zinc-800">
              <span className="col-span-6">الصنف / الوحدة</span>
              <span className="col-span-2 text-center">الكمية</span>
              <span className="col-span-4 text-left">الإجمالي</span>
            </div>

            {items.map((item, idx) => {
              const lineUSD = multiplyMoney(item.unitPriceUSD, item.quantity);
              return (
                <div
                  key={idx}
                  className="grid grid-cols-12 text-xs py-1 border-b border-zinc-100 dark:border-zinc-850"
                >
                  <div className="col-span-6 truncate">
                    <p className="font-semibold text-zinc-800 dark:text-zinc-200">
                      {item.product.name}
                    </p>
                    <p className="text-[10px] text-zinc-400">{item.unitName}</p>
                  </div>
                  <span className="col-span-2 text-center font-mono">
                    {item.quantity}
                  </span>
                  <div className="col-span-4 text-left font-bold text-zinc-800 dark:text-zinc-200 font-mono">
                    ${formatMoney(lineUSD, "USD")}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Financial Totals */}
          <div className="space-y-1 pt-2 border-t border-zinc-200 dark:border-zinc-800">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-zinc-600 dark:text-zinc-400">
                إجمالي الفاتورة:
              </span>
              <div className="text-left">
                <span className="text-emerald-700 dark:text-emerald-400 font-extrabold ml-2 font-mono">
                  ${formatMoney(invoice.totalUSD, "USD")}
                </span>
                <span className="text-purple-600 dark:text-purple-400 text-[11px]">
                  ({formatMoney(invoice.totalSYP, "SYP")} ل.س)
                </span>
              </div>
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">سعر الصرف المعتمد:</span>
              <span className="font-mono text-zinc-600 dark:text-zinc-400">
                {formatMoney(invoice.exchangeRateUsed, "SYP")} ل.س / $
              </span>
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">المبلغ المدفوع:</span>
              <span className="font-bold text-emerald-600 font-mono">
                ${formatMoney(invoice.paidAmountUSD, "USD")}
              </span>
            </div>

            {isDebtPresent && (
              <div className="flex justify-between text-xs font-bold text-red-600 dark:text-red-400">
                <span>المتبقي على الحساب (دين):</span>
                <span className="font-mono">
                  ${formatMoney(invoice.debtAmountUSD, "USD")}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-between gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handlePrint}
            className="text-xs gap-1.5"
          >
            <Printer className="h-4 w-4" />
            طباعة إيصال الفاتورة
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onStartNewSale();
            }}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold gap-1.5 px-6"
          >
            <PlusCircle className="h-4 w-4" />
            فاتورة جديدة (جديد)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}