"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ShoppingCart,
  Trash2,
  Plus,
  Minus,
  User,
  DollarSign,
  AlertTriangle,
  ArrowLeftRight,
  UserPlus,
  CreditCard,
} from "lucide-react";
import type { CartLineItem, SelectedCustomer } from "@/lib/offline";

interface CartPanelProps {
  items: CartLineItem[];
  customer: SelectedCustomer | null;
  exchangeRate: number | null;
  onUpdateQuantity: (cartId: string, delta: number) => void;
  onSetQuantity: (cartId: string, quantity: number) => void;
  onChangeUnit: (cartId: string, newUnitId: string) => void;
  onRemoveItem: (cartId: string) => void;
  onClearCart: () => void;
  onOpenCustomerModal: () => void;
  onOpenPaymentModal: () => void;
}

export function CartPanel({
  items,
  customer,
  exchangeRate,
  onUpdateQuantity,
  onSetQuantity,
  onChangeUnit,
  onRemoveItem,
  onClearCart,
  onOpenCustomerModal,
  onOpenPaymentModal,
}: CartPanelProps) {
  // Compute totals
  const totalUSD = items.reduce((acc, it) => acc + it.quantity * it.unitPriceUSD, 0);
  const totalSYP = exchangeRate ? totalUSD * exchangeRate : null;
  const itemCount = items.reduce((acc, it) => acc + it.quantity, 0);

  const isRateMissing = exchangeRate === null || exchangeRate <= 0;
  const isCartEmpty = items.length === 0;

  return (
    <div className="flex flex-col h-full rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 shadow-sm overflow-hidden">
      {/* 1. Header with Active Customer Information */}
      <div className="p-3.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-850/40">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              <User className="h-4 w-4" />
            </div>
            <div className="flex flex-col truncate">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate">
                  {customer ? customer.name : "زبون نقدي عام"}
                </span>
                {customer?.type === "WALK_IN" && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 text-amber-600 border-amber-300">
                    زبون محلي
                  </Badge>
                )}
              </div>
              <span className="text-[10px] text-zinc-500 truncate">
                {customer?.shopName || customer?.phone || "مبيعات نقدية مباشرة بدون تسجيل حساب"}
              </span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenCustomerModal}
            className="text-xs h-8 gap-1 border-zinc-300 dark:border-zinc-700 shrink-0"
            title="تحديد أو تسجيل زبون (F4)"
          >
            <UserPlus className="h-3.5 w-3.5 text-emerald-600" />
            <span>تغيير (F4)</span>
          </Button>
        </div>
      </div>

      {/* 2. Cart Items List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {isCartEmpty ? (
          <div className="flex flex-col items-center justify-center h-full py-12 text-center text-zinc-400 space-y-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
              <ShoppingCart className="h-6 w-6 text-zinc-400" />
            </div>
            <p className="text-xs font-bold text-zinc-600 dark:text-zinc-400">السلة فارغة حالياً</p>
            <p className="text-[11px] text-zinc-400 max-w-xs">
              انقر على أي صنف من القائمة اليمنى أو امسح الباركود لإضافته إلى السلة.
            </p>
          </div>
        ) : (
          items.map((item) => {
            const lineTotalUSD = item.quantity * item.unitPriceUSD;
            const lineTotalSYP = exchangeRate ? lineTotalUSD * exchangeRate : null;

            return (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-200 bg-white p-3 space-y-2 dark:border-zinc-800 dark:bg-zinc-900/90 shadow-2xs hover:border-zinc-300 transition-colors"
              >
                {/* Top Row: Name and Remove Button */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 truncate">
                    <p className="text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate">
                      {item.product.name}
                    </p>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      ${item.unitPriceUSD.toFixed(2)} للوحدة
                    </span>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemoveItem(item.id)}
                    className="h-7 w-7 text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                    title="حذف من السلة"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {/* Bottom Row: Unit Selector, Quantity Controls, and Totals */}
                <div className="flex items-center justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
                  {/* Unit Selector */}
                  <div className="w-28 shrink-0">
                    <Select
                      value={item.unitId}
                      onValueChange={(newUnitId) => onChangeUnit(item.id, newUnitId)}
                    >
                      <SelectTrigger className="h-7 text-[11px] px-2 bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700">
                        <SelectValue placeholder="الوحدة" />
                      </SelectTrigger>
                      <SelectContent dir="rtl">
                        {item.product.units?.map((u) => (
                          <SelectItem key={u.id} value={u.id} className="text-xs">
                            {u.unitName} (${u.priceUSD.toFixed(2)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Quantity Stepper */}
                  <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800">
                    <button
                      type="button"
                      onClick={() => onUpdateQuantity(item.id, -1)}
                      className="flex h-7 w-7 items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val) && val >= 1) onSetQuantity(item.id, val);
                      }}
                      className="h-7 w-10 text-center font-bold text-xs bg-transparent border-0 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => onUpdateQuantity(item.id, 1)}
                      className="flex h-7 w-7 items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>

                  {/* Line Total USD & SYP */}
                  <div className="text-left shrink-0">
                    <p className="text-xs font-extrabold text-emerald-600 dark:text-emerald-400">
                      ${lineTotalUSD.toFixed(2)}
                    </p>
                    {lineTotalSYP !== null && (
                      <p className="text-[10px] text-purple-600 dark:text-purple-400">
                        {Math.round(lineTotalSYP).toLocaleString("ar-SY")} ل.س
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 3. Exchange Rate Missing Alert (Rate Guard) */}
      {isRateMissing && (
        <div className="m-3 p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200 text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-bold">
            <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
            <span>تنبيه: سعر الصرف اليومي غير محدد!</span>
          </div>
          <p className="text-[11px] leading-relaxed text-red-700 dark:text-red-300">
            لا يمكن إتمام عملية البيع بدون سعر صرف مخزن في الذاكرة المحلية. يرجى تحديد سعر الصرف أولاً من الشريط العلوي.
          </p>
        </div>
      )}

      {/* 4. Dual-Currency Totals & Checkout Actions */}
      <div className="p-3.5 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-850/60 space-y-3">
        {/* Live Dual-Currency Summary */}
        <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-750 dark:bg-zinc-900 space-y-1.5 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>عدد الأصناف في السلة ({itemCount} قطعة):</span>
            <span className="font-mono text-zinc-700 dark:text-zinc-300 font-semibold">
              {items.length} أصناف
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
              المجموع الإجمالي (USD):
            </span>
            <span className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400">
              ${totalUSD.toFixed(2)}
            </span>
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800">
            <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
              المعادل بالليرة السورية:
            </span>
            <span className="text-base font-extrabold text-purple-600 dark:text-purple-400">
              {totalSYP !== null ? `${Math.round(totalSYP).toLocaleString("ar-SY")} ل.س` : "غير متاح"}
            </span>
          </div>
        </div>

        {/* Buttons: Checkout & Clear */}
        <div className="flex items-center gap-2">
          {!isCartEmpty && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClearCart}
              className="h-11 px-3 text-xs text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 border-zinc-300 dark:border-zinc-700 shrink-0"
              title="إفراغ السلة بالكامل"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}

          <Button
            type="button"
            disabled={isCartEmpty || isRateMissing}
            onClick={onOpenPaymentModal}
            className={`flex-1 h-11 text-xs font-bold shadow-md rounded-xl transition-all ${
              isRateMissing
                ? "bg-zinc-300 dark:bg-zinc-800 text-zinc-500 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20"
            }`}
          >
            <div className="flex items-center justify-between w-full px-1">
              <span className="flex items-center gap-1.5">
                <CreditCard className="h-4 w-4" />
                {isRateMissing ? "البيع موقوف لعدم وجود سعر صرف" : "إتمام البيع والدفع (F9)"}
              </span>
              {!isRateMissing && !isCartEmpty && (
                <span className="text-xs font-mono font-extrabold bg-emerald-700/50 px-2 py-0.5 rounded-lg">
                  ${totalUSD.toFixed(2)}
                </span>
              )}
            </div>
          </Button>
        </div>
      </div>
    </div>
  );
}
