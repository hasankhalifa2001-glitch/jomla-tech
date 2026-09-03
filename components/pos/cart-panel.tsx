"use client";

import { useMemo } from "react";
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
  AlertTriangle,
  UserPlus,
  CreditCard,
  Tag,
} from "lucide-react";
import {
  calculateCartTotals,
  resolveUnitPriceUSD,
  isSystemCashCustomer,
  type CartLineItem,
  type SelectedCustomer,
} from "@/lib/offline";
import { formatMoney, compareMoney } from "@/lib/utils/money";

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
  isMobileDrawer?: boolean;
}

// [FIX — same bug class as ProductCatalog.tsx] Resolves a unit's price the
// same way everywhere in the POS: through resolveUnitPriceUSD, which
// branches on pricingCurrency instead of assuming every stored
// priceWholesale is already USD. Returns null (instead of throwing) when
// a SYP-priced unit has no valid cached exchange rate to convert with.
function resolvePriceOrNull(
  unit: CartLineItem["product"]["units"][number],
  product: CartLineItem["product"],
  exchangeRate: number | null
): string | null {
  try {
    return resolveUnitPriceUSD(unit, product, exchangeRate);
  } catch {
    return null;
  }
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
  isMobileDrawer = false,
}: CartPanelProps) {
  // [v3.4] Compute all totals through decimal.js wrappers
  const totals = useMemo(() => {
    return calculateCartTotals(items, exchangeRate);
  }, [items, exchangeRate]);

  const isRateMissing =
    exchangeRate === null || compareMoney(exchangeRate, 0) <= 0;
  const isCartEmpty = items.length === 0;

  // Map item IDs to their calculated line totals for fast lookup
  const lineTotalsMap = useMemo(() => {
    const map = new Map<string, { usd: string; syp: string | null }>();
    for (const lt of totals.lineItems) {
      map.set(lt.id, { usd: lt.lineTotalUSD, syp: lt.lineTotalSYP });
    }
    return map;
  }, [totals.lineItems]);

  const isSystemCustomer = isSystemCashCustomer(customer);
  const customerLabel = isSystemCustomer
    ? customer?.name || "زبون نقدي عام"
    : customer
      ? customer.name
      : "لم يتم اختيار زبون";
  const customerSubLabel = customer?.shopName ||
    customer?.phone ||
    (isSystemCustomer
      ? "مبيعات نقدية مباشرة (مسموح بالدفع الكامل فقط)"
      : "يجب اختيار زبون حقيقي للبيع على الحساب أو الدفع الجزئي");

  return (
    <div
      className={`flex flex-col h-full bg-white dark:bg-zinc-900 overflow-hidden ${isMobileDrawer
          ? "rounded-t-2xl"
          : "rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-xs"
        }`}
    >
      {/* 1. Header with Active Customer Information */}
      <div className="p-3.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-850/50 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${isSystemCustomer
                  ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                }`}
            >
              <User className="h-4 w-4" />
            </div>
            <div className="flex flex-col truncate">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate">
                  {customerLabel}
                </span>
                {customer?.type === "WALK_IN" && (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/50"
                  >
                    زبون محلي
                  </Badge>
                )}
                {isSystemCustomer && (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 text-zinc-500 border-zinc-300 bg-zinc-50 dark:bg-zinc-800"
                  >
                    نقدي فوري
                  </Badge>
                )}
              </div>
              <span className="text-[10px] text-zinc-500 truncate">
                {customerSubLabel}
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
            <p className="text-xs font-bold text-zinc-600 dark:text-zinc-400">
              السلة فارغة حالياً
            </p>
            <p className="text-[11px] text-zinc-400 max-w-xs">
              انقر على أي صنف أو وحدة لإضافتها، أو امسح الباركود مباشرة.
            </p>
          </div>
        ) : (
          items.map((item) => {
            const lineTotal = lineTotalsMap.get(item.id) || {
              usd: "0.0000",
              syp: null,
            };

            return (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-200 bg-white p-3 space-y-2 dark:border-zinc-800 dark:bg-zinc-900/90 shadow-2xs hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
              >
                {/* Top Row: Name, Wholesale/Retail Prices, and Delete Button */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 truncate flex-1">
                    <p className="text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate">
                      {item.product.name}
                    </p>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                      <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                        سعر الجملة: ${formatMoney(item.unitPriceUSD, "USD")}
                      </span>
                      {item.priceRetailUSD && (
                        <span className="flex items-center gap-0.5 text-zinc-400 line-through decoration-zinc-300">
                          <Tag className="h-2.5 w-2.5" />
                          مفرد: ${formatMoney(item.priceRetailUSD, "USD")}
                        </span>
                      )}
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemoveItem(item.id)}
                    className="h-7 w-7 text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 shrink-0"
                    title="حذف من السلة"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {/* Bottom Row: Unit Selector, Quantity Stepper, and Calculated Line Totals */}
                <div className="flex items-center justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
                  {/* Unit Selector */}
                  <div className="w-28 shrink-0">
                    <Select
                      value={item.unitId}
                      onValueChange={(newUnitId) =>
                        onChangeUnit(item.id, newUnitId)
                      }
                    >
                      <SelectTrigger className="h-7 text-[11px] px-2 bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700">
                        <SelectValue placeholder="الوحدة" />
                      </SelectTrigger>
                      <SelectContent dir="rtl">
                        {item.product.units?.map((u) => {
                          // [FIX] Was `serializeMoney(u.priceWholesale ?? "0")`
                          // — the exact same currency-blind bug as
                          // ProductCatalog.tsx's price cards. A SYP-priced
                          // unit's price here would have been shown as if
                          // it were USD, off by orders of magnitude.
                          const unitPriceUSD = resolvePriceOrNull(u, item.product, exchangeRate);
                          return (
                            <SelectItem
                              key={u.id}
                              value={u.id}
                              className="text-xs"
                            >
                              {u.unitName}{" "}
                              {unitPriceUSD !== null
                                ? `($${formatMoney(unitPriceUSD, "USD")})`
                                : "(يتطلب سعر الصرف)"}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Quantity Stepper */}
                  <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800">
                    <button
                      type="button"
                      onClick={() => onUpdateQuantity(item.id, -1)}
                      className="flex h-7 w-7 items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                      title="إنقاص الكمية"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val) && val >= 1) {
                          onSetQuantity(item.id, val);
                        }
                      }}
                      className="h-7 w-10 text-center font-bold text-xs bg-transparent border-0 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => onUpdateQuantity(item.id, 1)}
                      className="flex h-7 w-7 items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                      title="زيادة الكمية"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>

                  {/* Line Total USD & SYP */}
                  <div className="text-left shrink-0">
                    <p className="text-xs font-extrabold text-emerald-600 dark:text-emerald-400">
                      ${formatMoney(lineTotal.usd, "USD")}
                    </p>
                    {lineTotal.syp !== null && (
                      <p className="text-[10px] text-purple-600 dark:text-purple-400 font-semibold">
                        {formatMoney(lineTotal.syp, "SYP")} ل.س
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
        <div className="m-3 p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200 text-xs space-y-1 shrink-0">
          <div className="flex items-center gap-1.5 font-bold">
            <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
            <span>تنبيه: سعر الصرف اليومي غير محدد! (البيع موقوف)</span>
          </div>
          <p className="text-[11px] leading-relaxed text-red-700 dark:text-red-300">
            لا يمكن إتمام عملية البيع بدون سعر صرف مخزن في الذاكرة المحلية. يرجى
            تحديد سعر الصرف أولاً من الشريط العلوي.
          </p>
        </div>
      )}

      {/* 4. Dual-Currency Totals & Checkout Actions */}
      <div className="p-3.5 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-850/60 space-y-3 shrink-0">
        {/* Live Dual-Currency Summary */}
        <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-750 dark:bg-zinc-900 space-y-1.5 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>
              عدد الأصناف في السلة ({totals.itemCount} قطعة):
            </span>
            <span className="font-mono text-zinc-700 dark:text-zinc-300 font-semibold">
              {items.length} أصناف
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
              المجموع الإجمالي (USD):
            </span>
            <span className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400">
              ${formatMoney(totals.totalUSD, "USD")}
            </span>
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800">
            <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
              المعادل بالليرة السورية:
            </span>
            <span className="text-base font-extrabold text-purple-600 dark:text-purple-400">
              {totals.totalSYP !== null
                ? `${formatMoney(totals.totalSYP, "SYP")} ل.س`
                : "غير متاح (لا يوجد سعر صرف)"}
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
            className={`flex-1 h-11 text-xs font-bold shadow-md rounded-xl transition-all ${isRateMissing
                ? "bg-zinc-300 dark:bg-zinc-800 text-zinc-500 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20"
              }`}
          >
            <div className="flex items-center justify-between w-full px-1">
              <span className="flex items-center gap-1.5">
                <CreditCard className="h-4 w-4" />
                {isRateMissing
                  ? "البيع موقوف لعدم وجود سعر صرف"
                  : "إتمام البيع والدفع (F9)"}
              </span>
              {!isRateMissing && !isCartEmpty && (
                <span className="text-xs font-mono font-extrabold bg-emerald-700/50 px-2 py-0.5 rounded-lg">
                  ${formatMoney(totals.totalUSD, "USD")}
                </span>
              )}
            </div>
          </Button>
        </div>
      </div>
    </div>
  );
}