"use client";

/**
 * components/pos/cart-panel.tsx
 *
 * Same props and same behaviour as before — only the presentation changed:
 * light-only slate + emerald (matching the dashboard), Latin digits through
 * <Money>, the "clear cart" action moved up to the header (away from the
 * checkout button), and the total + checkout merged into one hero card that
 * turns emerald when the sale is ready to go.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  CreditCard,
  Info,
  Minus,
  Plus,
  ShoppingCart,
  Trash2,
  User,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  calculateCartTotals,
  resolveUnitPriceSYP,
  isSystemCashCustomer,
  cartNeedsExchangeRate,
  type CartLineItem,
  type SelectedCustomer,
} from "@/lib/offline";
import { compareMoney } from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import { fmtInt, fmtMoney } from "@/lib/utils/digits";
import { Money } from "./money";

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

// [v3.6] Same currency-primacy as the catalog: the unit switcher shows the SYP
// price the cart/invoice actually bills. Returns null (instead of throwing)
// when a USD-priced unit has no valid cached exchange rate to convert with.
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
  // [v3.4] All totals go through decimal.js wrappers.
  const totals = useMemo(() => calculateCartTotals(items, exchangeRate), [items, exchangeRate]);

  const isRateMissing = exchangeRate === null || compareMoney(exchangeRate, 0) <= 0;
  const isCartEmpty = items.length === 0;

  // [T4b] A missing exchange rate only BLOCKS when the cart contains a
  // USD-priced unit; a SYP-only cart never needs a rate.
  const rateRequired = useMemo(() => cartNeedsExchangeRate(items), [items]);
  const isRateBlocking = rateRequired && isRateMissing;
  const isCheckoutDisabled = isCartEmpty || isRateBlocking;
  const ready = !isCheckoutDisabled;

  // [v3.6] `syp` is authoritative (never null); `usd` is derived and may be null.
  const lineTotalsMap = useMemo(() => {
    const map = new Map<string, { syp: string; usd: string | null }>();
    for (const lt of totals.lineItems) {
      map.set(lt.id, { syp: lt.lineTotalSYP, usd: lt.lineTotalUSD });
    }
    return map;
  }, [totals.lineItems]);

  // When a line is ADDED, bring the new line into view (it is appended at the
  // bottom of a scrolling list).
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevCount = useRef(items.length);
  useEffect(() => {
    const grew = items.length > prevCount.current;
    prevCount.current = items.length;
    if (!grew) return;
    const el = listRef.current;
    if (!el) return;
    const reduce =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [items.length]);

  const isSystemCustomer = isSystemCashCustomer(customer);
  const customerLabel = isSystemCustomer
    ? customer?.name || "زبون نقدي عام"
    : customer
      ? customer.name
      : "لم يتم اختيار زبون";
  const customerSubLabel =
    customer?.shopName ||
    customer?.phone ||
    (isSystemCustomer
      ? "مبيعات نقدية مباشرة — الدفع الكامل فقط"
      : "اختر زبوناً للبيع على الحساب أو الدفع الجزئي");

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-white",
        isMobileDrawer ? "rounded-t-2xl" : "rounded-xl border border-slate-200 shadow-sm"
      )}
    >
      {/* ----------------------------------------------------- header */}
      <div className="shrink-0 border-b border-slate-100 px-3.5 pb-3 pt-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-extrabold text-slate-900">سلة المبيعات</h2>
            {!isCartEmpty && (
              <span
                key={items.length}
                className="animate-in rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-extrabold tabular-nums text-white duration-200 zoom-in-75 motion-reduce:animate-none"
              >
                {fmtInt(items.length)}
              </span>
            )}
          </div>

          {!isCartEmpty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearCart}
              className="h-8 gap-1 px-2 text-xs font-semibold text-slate-500 hover:bg-red-50 hover:text-red-600"
              title="إفراغ السلة بالكامل"
              aria-label="إفراغ السلة بالكامل"
            >
              <Trash2 className="size-3.5" aria-hidden />
              إفراغ
            </Button>
          )}
        </div>

        {/* The whole row is the tap target for "change customer". */}
        <button
          type="button"
          onClick={onOpenCustomerModal}
          title="تحديد أو تسجيل زبون (F4)"
          className="mt-2.5 flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-start transition-colors hover:border-emerald-300 hover:bg-emerald-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
        >
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              isSystemCustomer ? "bg-slate-200 text-slate-600" : "bg-emerald-100 text-emerald-700"
            )}
            aria-hidden
          >
            <User className="size-4" />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-extrabold text-slate-900">{customerLabel}</span>
              {customer?.type === "WALK_IN" && (
                <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-bold text-amber-700 ring-1 ring-amber-200">
                  زبون محلي
                </span>
              )}
              {isSystemCustomer && (
                <span className="shrink-0 rounded-full bg-slate-200 px-1.5 py-px text-[10px] font-bold text-slate-600">
                  نقدي فوري
                </span>
              )}
            </span>
            <span className="block truncate text-[11px] text-slate-500">{customerSubLabel}</span>
          </span>

          <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-emerald-700">
            <UserPlus className="size-3.5" aria-hidden />
            تغيير
            <kbd className="hidden rounded border border-slate-200 bg-white px-1 font-mono text-[10px] font-normal text-slate-500 lg:inline-flex">
              F4
            </kbd>
          </span>
        </button>
      </div>

      {/* -------------------------------------------------- line items */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto bg-slate-50/60 p-3">
        {isCartEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <ShoppingCart className="size-6" aria-hidden />
            </span>
            <p className="text-sm font-extrabold text-slate-700">السلة فارغة</p>
            <p className="max-w-xs text-xs leading-relaxed text-slate-500">
              اضغط على وحدة أي صنف لإضافتها، أو امسح الباركود مباشرة.
            </p>
          </div>
        ) : (
          items.map((item) => {
            const lineTotal = lineTotalsMap.get(item.id) || { syp: "0.0000", usd: null };

            return (
              <div
                key={item.id}
                className="animate-in rounded-xl border border-slate-200 bg-white p-3 shadow-sm duration-300 fade-in-0 slide-in-from-top-2 motion-reduce:animate-none"
              >
                {/* name + unit price + delete */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-extrabold text-slate-900">
                      {item.product.name}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                      <span>سعر الجملة</span>
                      <Money value={item.unitPriceSYP} compact className="font-bold text-emerald-700" />
                    </p>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemoveItem(item.id)}
                    // 40px on mobile, 32px from `sm:` up.
                    className="-me-1 -mt-1 size-10 shrink-0 text-slate-400 hover:bg-red-50 hover:text-red-600 sm:size-8"
                    title="حذف من السلة"
                    aria-label="حذف من السلة"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                {/* unit selector + quantity stepper */}
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <Select
                      value={item.unitId}
                      onValueChange={(newUnitId) => onChangeUnit(item.id, newUnitId)}
                    >
                      <SelectTrigger className="h-10 w-full border-slate-200 bg-slate-50 px-2.5 text-xs font-semibold sm:h-9">
                        <SelectValue placeholder="الوحدة" />
                      </SelectTrigger>
                      <SelectContent dir="rtl">
                        {item.product.units
                          ?.filter((u) => u.isActive !== false)
                          .map((u) => {
                            const unitPriceSYP = resolvePriceOrNull(u, item.product, exchangeRate);
                            return (
                              <SelectItem key={u.id} value={u.id} className="text-xs">
                                {u.unitName}{" "}
                                {unitPriceSYP !== null
                                  ? `(${fmtMoney(unitPriceSYP, "SYP")} ل.س)`
                                  : "(يتطلب سعر الصرف)"}
                              </SelectItem>
                            );
                          })}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex shrink-0 items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                    <button
                      type="button"
                      onClick={() => onUpdateQuantity(item.id, -1)}
                      className="flex size-10 items-center justify-center text-slate-500 transition-colors hover:bg-white hover:text-slate-900 active:bg-slate-100 sm:size-9"
                      title="إنقاص الكمية"
                      aria-label="إنقاص الكمية"
                    >
                      <Minus className="size-4" />
                    </button>
                    <input
                      type="number"
                      min="1"
                      inputMode="numeric"
                      lang="en"
                      dir="ltr"
                      aria-label="الكمية"
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
                      className="h-10 w-11 border-0 bg-transparent text-center text-sm font-extrabold tabular-nums text-slate-900 [appearance:textfield] focus:outline-none sm:h-9 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      type="button"
                      onClick={() => onUpdateQuantity(item.id, 1)}
                      className="flex size-10 items-center justify-center text-slate-500 transition-colors hover:bg-emerald-50 hover:text-emerald-700 active:bg-emerald-100 sm:size-9"
                      title="زيادة الكمية"
                      aria-label="زيادة الكمية"
                    >
                      <Plus className="size-4" />
                    </button>
                  </div>
                </div>

                {/* line total — SYP primary, USD secondary (may be null) */}
                <div className="mt-2.5 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5">
                  <span className="text-[11px] font-semibold text-slate-500">الإجمالي</span>
                  <span className="flex items-baseline gap-2">
                    {lineTotal.usd !== null && (
                      <span className="text-[11px] font-semibold text-purple-600">
                        ≈ <Money value={lineTotal.usd} currency="USD" />
                      </span>
                    )}
                    <Money value={lineTotal.syp} className="text-sm font-extrabold text-emerald-700" />
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ------------------------------------------------ rate notices
                [T4b] Two distinct states:
                - isRateBlocking (a USD-priced line AND no rate): RED, the sale
                  really is stopped.
                - rate missing but the cart is SYP-only (or empty): AMBER,
                  informational — SYP sales work normally. */}
      {isRateBlocking && (
        <div className="mx-3 mt-3 shrink-0 space-y-1 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <div className="flex items-center gap-1.5 font-extrabold">
            <AlertTriangle className="size-4 shrink-0 text-red-600" aria-hidden />
            <span>لا يمكن إتمام البيع: سعر الصرف اليومي غير محدد</span>
          </div>
          <p className="text-[11px] leading-relaxed text-red-700">
            يوجد في السلة صنف مسعّر بالدولار ولا يمكن تحويله إلى الليرة بدون سعر صرف. حدّد سعر الصرف من
            الشريط العلوي، أو احذف هذا الصنف من السلة.
          </p>
        </div>
      )}
      {isRateMissing && !rateRequired && (
        <div className="mx-3 mt-3 shrink-0 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-amber-800">
          <div className="flex items-start gap-1.5">
            <Info className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
            <p className="text-[11px] leading-relaxed">
              سعر الصرف غير محدد. البيع بالليرة السورية متاح بشكل طبيعي، لكن المعادل بالدولار غير متاح.
              حدّد سعر الصرف من الشريط العلوي لعرضه.
            </p>
          </div>
        </div>
      )}

      {/* ------------------------------------- total + checkout (hero) */}
      <div className="shrink-0 bg-white p-3">
        <div
          className={cn(
            "rounded-xl border p-3.5 transition-colors duration-300",
            ready
              ? "border-emerald-700 bg-linear-to-br from-emerald-600 to-emerald-800 text-white shadow-md shadow-emerald-900/20"
              : "border-slate-200 bg-slate-100 text-slate-600"
          )}
        >
          <p className={cn("text-[11px]", ready ? "text-emerald-100" : "text-slate-500")}>
            {fmtInt(items.length)} أصناف · {fmtInt(totals.itemCount)} قطعة
          </p>

          <div className="mt-1 flex items-end justify-between gap-3">
            <span className={cn("text-xs font-bold", ready ? "text-emerald-50" : "text-slate-600")}>
              المجموع الإجمالي
            </span>
            {/* Re-mounts when the total changes: a quick "pop" that says
                            the figure updated, without ever tweening the digits. */}
            <span
              key={totals.totalSYP}
              className="animate-in duration-200 fade-in-0 zoom-in-95 motion-reduce:animate-none"
            >
              <Money
                value={totals.totalSYP}
                className="text-2xl font-extrabold leading-none"
                unitClassName={ready ? "text-emerald-100" : "text-slate-500"}
              />
            </span>
          </div>

          <div
            className={cn(
              "mt-2.5 flex items-center justify-between border-t pt-2 text-xs",
              ready ? "border-white/20 text-emerald-100" : "border-slate-200 text-slate-500"
            )}
          >
            <span>المعادل بالدولار</span>
            {totals.totalUSD !== null ? (
              <Money value={totals.totalUSD} currency="USD" className="text-sm font-bold" />
            ) : (
              <span className="text-[11px] font-medium">غير متاح (لا يوجد سعر صرف)</span>
            )}
          </div>

          {/* The button always says WHY it is disabled instead of just fading out. */}
          <Button
            type="button"
            disabled={isCheckoutDisabled}
            onClick={onOpenPaymentModal}
            className={cn(
              "mt-3 h-12 w-full rounded-xl text-sm font-extrabold transition-all",
              ready
                ? "bg-white text-emerald-800 shadow-sm hover:bg-emerald-50"
                : "cursor-not-allowed bg-slate-200 text-slate-500 shadow-none"
            )}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <CreditCard className="size-4" aria-hidden />
                {isRateBlocking
                  ? "يلزم سعر صرف لصنف مسعّر بالدولار"
                  : isCartEmpty
                    ? "أضف أصنافاً للسلة أولاً"
                    : "إتمام البيع والدفع"}
              </span>
              {ready && (
                <span className="flex items-center gap-1.5">
                  <kbd className="hidden rounded border border-emerald-200 bg-emerald-50 px-1.5 font-mono text-[10px] font-semibold text-emerald-700 lg:inline-flex">
                    F9
                  </kbd>
                  <ChevronLeft className="size-4" aria-hidden />
                </span>
              )}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}