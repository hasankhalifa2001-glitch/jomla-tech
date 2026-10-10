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
  Info,
  UserPlus,
  CreditCard,
} from "lucide-react";
import {
  calculateCartTotals,
  resolveUnitPriceSYP,
  isSystemCashCustomer,
  cartNeedsExchangeRate,
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

// [v3.6] FIX — same currency-primacy flip as ProductCatalog.tsx. Was
// resolveUnitPriceUSD (USD-primary); now resolveUnitPriceSYP so the unit
// switcher below shows the same authoritative price the cart/invoice
// actually bills. Returns null (instead of throwing) when a USD-priced
// unit has no valid cached exchange rate to convert into SYP with.
function resolvePriceOrNull(
  unit: CartLineItem["product"]["units"][number],
  product: CartLineItem["product"],
  exchangeRate: number | null
): string | null {
  try {
    return resolveUnitPriceSYP(unit, product, exchangeRate);
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

  // [T4b FIX] A missing exchange rate is only a BLOCKER when the cart
  // actually contains a USD-priced unit (the one case where a SYP figure
  // cannot be computed without a rate). A SYP-only cart never needs a
  // rate. Previously `isRateMissing` alone drove the red banner AND the
  // disabled checkout button, blocking every sale on a tenant that had
  // not yet entered a rate, even for SYP-only carts — contradicting T4b.
  const rateRequired = useMemo(() => cartNeedsExchangeRate(items), [items]);
  const isRateBlocking = rateRequired && isRateMissing;
  const isCheckoutDisabled = isCartEmpty || isRateBlocking;

  // [v3.6] Map item IDs to their calculated line totals for fast lookup.
  // `syp` is authoritative (never null); `usd` is derived/display-only
  // and may be null with no cached rate — flipped from the pre-v3.6 shape
  // where `usd` was assumed always present and `syp` was the nullable one.
  const lineTotalsMap = useMemo(() => {
    const map = new Map<string, { syp: string; usd: string | null }>();
    for (const lt of totals.lineItems) {
      map.set(lt.id, { syp: lt.lineTotalSYP, usd: lt.lineTotalUSD });
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
            className="text-xs h-9 gap-1 border-zinc-300 dark:border-zinc-700 shrink-0"
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
            // [v3.6] `syp` is authoritative (never null); `usd` may be
            // null. The old default `{ usd: "0.0000", syp: null }` is
            // flipped accordingly.
            const lineTotal = lineTotalsMap.get(item.id) || {
              syp: "0.0000",
              usd: null,
            };

            return (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-200 bg-white p-3 space-y-2 dark:border-zinc-800 dark:bg-zinc-900/90 shadow-2xs hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
              >
                {/* Top Row: Name, Price, and Delete Button */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 truncate flex-1">
                    <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">
                      {item.product.name}
                    </p>
                    {/*
                      [v3.6] The always-present, authoritative price is
                      unitPriceSYP (pos-service.ts); unitPriceUSD is a
                      nullable derived field, shown only when an exchange
                      rate was cached. Reading a nullable field as if it
                      were always present would call formatMoney(null, …).
                    */}
                    <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                      <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                        سعر الجملة: <span dir="ltr">{formatMoney(item.unitPriceSYP, "SYP")}</span> ل.س
                      </span>
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemoveItem(item.id)}
                    // [UX — touch target] 40px on mobile, 32px from `sm:` up:
                    // a deliberate, comfortable tap for a destructive action
                    // next to the product name. (A hasty delete can be undone
                    // from the toast the POS screen shows.)
                    className="h-10 w-10 sm:h-8 sm:w-8 text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 shrink-0"
                    title="حذف من السلة"
                    aria-label="حذف من السلة"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {/*
                  [FIX — mobile/narrow-column overflow] Two independent
                  rows so neither exceeds ~300px:
                  - Row 1: unit selector (flex-1, can shrink/truncate) +
                    quantity stepper (shrink-0).
                  - Row 2: line totals, right-aligned.
                */}
                <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    {/* Unit Selector */}
                    <div className="flex-1 min-w-0">
                      <Select
                        value={item.unitId}
                        onValueChange={(newUnitId) =>
                          onChangeUnit(item.id, newUnitId)
                        }
                      >
                        <SelectTrigger className="h-10 sm:h-8 text-xs px-2 bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700">
                          <SelectValue placeholder="الوحدة" />
                        </SelectTrigger>
                        <SelectContent dir="rtl">
                          {item.product.units?.filter((u) => u.isActive !== false).map((u) => {
                            const unitPriceSYP = resolvePriceOrNull(u, item.product, exchangeRate);
                            return (
                              <SelectItem
                                key={u.id}
                                value={u.id}
                                className="text-xs"
                              >
                                {u.unitName}{" "}
                                {unitPriceSYP !== null
                                  ? `(${formatMoney(unitPriceSYP, "SYP")} ل.س)`
                                  : "(يتطلب سعر الصرف)"}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Quantity Stepper — 40px targets on mobile, 32px from sm: up */}
                    <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 shrink-0">
                      <button
                        type="button"
                        onClick={() => onUpdateQuantity(item.id, -1)}
                        className="flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                        title="إنقاص الكمية"
                        aria-label="إنقاص الكمية"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <input
                        type="number"
                        min="1"
                        inputMode="numeric"
                        value={item.quantity}
                        // Select the whole number on focus so typing REPLACES it
                        // (the field ignores an empty value, so it can't be
                        // cleared by backspacing).
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val) && val >= 1) {
                            onSetQuantity(item.id, val);
                          }
                        }}
                        className="h-10 sm:h-8 w-10 text-center font-bold text-sm bg-transparent border-0 focus:outline-none tabular-nums"
                      />
                      <button
                        type="button"
                        onClick={() => onUpdateQuantity(item.id, 1)}
                        className="flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                        title="زيادة الكمية"
                        aria-label="زيادة الكمية"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {/*
                    [v3.6] SYP is the primary/large line total; USD is the
                    secondary "≈" derived figure and only rendered when
                    not null.
                  */}
                  <div className="flex items-baseline justify-end gap-2">
                    <p className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400">
                      <span dir="ltr">{formatMoney(lineTotal.syp, "SYP")}</span> ل.س
                    </p>
                    {lineTotal.usd !== null && (
                      <p className="text-[11px] text-purple-600 dark:text-purple-400 font-semibold">
                        <span dir="ltr" className="inline-block">
                          ≈ ${formatMoney(lineTotal.usd, "USD")}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/*
        3. Exchange Rate notices.
        [T4b FIX] Two distinct states instead of one blanket blocker:
        - isRateBlocking (a USD-priced line is in the cart AND no rate):
          RED, the sale really is stopped.
        - rate missing but the cart is SYP-only (or empty): AMBER and
          informational — SYP sales work normally, only the USD
          equivalent is unavailable.
      */}
      {isRateBlocking && (
        <div className="m-3 p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200 text-xs space-y-1 shrink-0">
          <div className="flex items-center gap-1.5 font-bold">
            <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
            <span>لا يمكن إتمام البيع: سعر الصرف اليومي غير محدد</span>
          </div>
          <p className="text-[11px] leading-relaxed text-red-700 dark:text-red-300">
            يوجد في السلة صنف مسعّر بالدولار، ولا يمكن تحويله إلى الليرة بدون
            سعر صرف. يرجى تحديد سعر الصرف من الشريط العلوي، أو حذف هذا الصنف
            من السلة.
          </p>
        </div>
      )}
      {isRateMissing && !rateRequired && (
        <div className="m-3 p-2.5 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200 text-xs shrink-0">
          <div className="flex items-start gap-1.5">
            <Info className="h-4 w-4 text-amber-600 shrink-0 mt-px" />
            <p className="text-[11px] leading-relaxed">
              سعر الصرف غير محدد. البيع بالليرة السورية متاح بشكل طبيعي، لكن
              المعادل بالدولار غير متاح. حدّد سعر الصرف من الشريط العلوي لعرضه.
            </p>
          </div>
        </div>
      )}

      {/* 4. Totals & Checkout Actions */}
      <div className="p-3.5 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-850/60 space-y-3 shrink-0">
        {/*
          [UX] The grand total is THE number on this panel: one big SYP figure,
          with the counts above it as a quiet single line (the old
          "عدد الأصناف في السلة (N قطعة)" row said the same thing twice) and the
          USD equivalent below as secondary information.
          [v3.6] SYP is authoritative; USD may be null (no cached rate).
        */}
        <div className="rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-750 dark:bg-zinc-900 space-y-1.5 shadow-2xs">
          <p className="text-[11px] text-zinc-500">
            {items.length} أصناف · {totals.itemCount} قطعة
          </p>

          <div className="flex items-end justify-between gap-3">
            <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">
              المجموع الإجمالي
            </span>
            <span className="text-2xl font-extrabold leading-none text-emerald-600 dark:text-emerald-400 tabular-nums">
              <span dir="ltr">{formatMoney(totals.totalSYP, "SYP")}</span>{" "}
              <span className="text-sm font-bold">ل.س</span>
            </span>
          </div>

          <div className="flex items-center justify-between pt-1.5 border-t border-zinc-100 dark:border-zinc-800">
            <span className="text-xs text-zinc-500">المعادل بالدولار</span>
            <span className="text-sm font-bold text-purple-600 dark:text-purple-400 tabular-nums">
              {totals.totalUSD !== null ? (
                <span dir="ltr" className="inline-block">
                  ${formatMoney(totals.totalUSD, "USD")}
                </span>
              ) : (
                <span className="text-xs font-medium text-zinc-400">غير متاح (لا يوجد سعر صرف)</span>
              )}
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
              className="h-12 px-3 text-xs text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 border-zinc-300 dark:border-zinc-700 shrink-0"
              title="إفراغ السلة بالكامل"
              aria-label="إفراغ السلة بالكامل"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}

          {/* [UX] The button always says WHY it is disabled, instead of just
              fading out. */}
          <Button
            type="button"
            disabled={isCheckoutDisabled}
            onClick={onOpenPaymentModal}
            className={`flex-1 h-12 text-sm font-bold shadow-md rounded-xl transition-all ${isCheckoutDisabled
              ? "bg-zinc-300 dark:bg-zinc-800 text-zinc-500 cursor-not-allowed shadow-none"
              : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20"
              }`}
          >
            <div className="flex items-center justify-between w-full px-1">
              <span className="flex items-center gap-1.5">
                <CreditCard className="h-4 w-4" />
                {isRateBlocking
                  ? "يلزم سعر صرف لصنف مسعّر بالدولار"
                  : isCartEmpty
                    ? "أضف أصنافاً للسلة أولاً"
                    : "إتمام البيع والدفع (F9)"}
              </span>
              {!isCheckoutDisabled && (
                <span className="text-xs font-mono font-extrabold bg-emerald-700/50 px-2 py-0.5 rounded-lg">
                  <span dir="ltr">{formatMoney(totals.totalSYP, "SYP")}</span> ل.س
                </span>
              )}
            </div>
          </Button>
        </div>
      </div>
    </div>
  );
}