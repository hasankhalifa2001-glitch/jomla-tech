"use client";

/**
 * components/pos/cart-panel.tsx
 *
 * Presentation only. Every cart mutation is delegated to the callbacks that
 * PosLayout routes through the pos-service funnel (D8): this file never writes
 * `quantity`, `lineTotalOverrideSYP` or any price field itself.
 *
 * [v6.2 — PRICE EDITOR] An ADMIN can change a line's unit price (or give a
 * discount) for THIS sale only. The editor converts whatever was typed — a new
 * price, an amount off, or a percentage off — into ONE final unit price and
 * hands it to `onEditLinePrice`; nothing about how it was typed is kept. All
 * arithmetic goes through lib/utils/money.ts. The catalog price shown/struck
 * here is read from the line's own `listUnitPriceSYP` snapshot (or, on a line
 * that is not overridden, its current unit price) — never supplied by the UI.
 * The editor is absent (not disabled) for a CASHIER; the server enforces it too.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  CreditCard,
  Info,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  ShoppingCart,
  Tag,
  Trash2,
  User,
  UserPlus,
  X,
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
  cartHasPriceOverride,
  isBaseUnitLine,
  type CartLineItem,
  type SelectedCustomer,
} from "@/lib/offline";
import {
  compareMoney,
  MoneyError,
  multiplyMoney,
  subtractMoney,
  toDecimal,
} from "@/lib/utils/money";
import {
  parseAmountInput,
  parseQuantityInput,
  AMBIGUOUS_COMMA_RE,
  formatQuantityText,
} from "@/lib/pos/by-amount-ui";
import { cn } from "@/lib/utils";
import { fmtInt, fmtMoney } from "@/lib/utils/digits";
import { Money } from "./money";

type LineInputMode = "qty" | "amount";
type CartTotals = ReturnType<typeof calculateCartTotals>;
type PriceEditResult = { ok: true } | { ok: false; message: string };

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
  // [D8/D10] By-amount presentation state, keyed by cart line id
  lineModes: Record<string, LineInputMode>;
  lineAmounts: Record<string, string>;
  /** A line whose amount field holds something the funnel refused (Arabic message). */
  amountErrors?: Record<string, string>;
  /** [D6] cart line id -> true when the product's cart quantity exceeds known stock. */
  stockWarnings?: Record<string, boolean>;
  /** [D9] Optional visible notice per line (e.g. after reconcileLineOverride re-derived/cleared). */
  lineNotices?: Record<string, string>;
  onToggleLineMode: (cartId: string) => void;
  onLineAmountChange: (cartId: string, amount: string) => void;
  onLineQuickQuantity: (cartId: string, qty: number | string) => void;
  isMobileDrawer?: boolean;
  /** Blocks checkout: unreadable cart total, or an amount field the cart refused. */
  cartInconsistent?: boolean;
  // [v6.2] ADMIN-only price/discount editing.
  isAdmin?: boolean;
  /** Sets the line's FINAL unit price (SYP decimal string). Returns the funnel's outcome. */
  onEditLinePrice?: (cartId: string, finalPriceSYP: string) => PriceEditResult;
  /** Puts the line back to its catalog price. */
  onClearLinePrice?: (cartId: string) => void;
}

/** [D7] Quick weight buttons — applied by the parent through setLineQuantity. */
const QUICK_BUTTONS: ReadonlyArray<{ label: string; value: string; title: string }> = [
  { label: "¼", value: "0.25", title: "ربع كيلو" },
  { label: "½", value: "0.5", title: "نصف كيلو" },
  { label: "1", value: "1", title: "كيلو" },
];

const EMPTY_TOTALS: CartTotals = {
  totalSYP: "0.0000",
  totalUSD: null,
  itemCount: 0,
  lineItems: [],
};

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

/**
 * Quantity field that accepts fractions (0.25, 0.3333). It keeps its own draft
 * text while focused so typing "0." or "1.5" is never fought by the cart value,
 * and commits only valid positive numbers (the parent routes them through
 * setLineQuantity, which normalizes to 4 dp and clears any amount override).
 *
 * Commas are AMBIGUOUS in a quantity ("0,5" vs "1,000"), so they are refused,
 * never guessed: nothing is committed and `onHint` tells the cashier to use
 * the dot. While the text is refused the field shows what was typed, flagged
 * red, and the cart keeps its previous quantity; on blur the field snaps back
 * to the real cart value.
 */
function QuantityField({
  value,
  onCommit,
  onHint,
}: {
  value: number;
  onCommit: (quantity: number) => void;
  /** Reports an Arabic hint while the typed text is refused; null clears it. */
  onHint?: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const report = (message: string | null) => {
    setInvalid(message !== null);
    onHint?.(message);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      lang="en"
      dir="ltr"
      aria-label="الكمية"
      aria-invalid={invalid ? true : undefined}
      value={draft ?? formatQuantityText(value)}
      onFocus={(e) => {
        setDraft(formatQuantityText(value));
        e.target.select();
      }}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);

        if (text.trim() === "") {
          report(null);
          return;
        }

        const parsed = parseQuantityInput(text);
        if (parsed === null) {
          report(
            AMBIGUOUS_COMMA_RE.test(text)
              ? "استخدم النقطة (.) للكسور"
              : "كمية غير صالحة"
          );
          return;
        }

        const qty = Number(parsed);
        if (!Number.isFinite(qty) || qty <= 0) {
          report("الكمية يجب أن تكون أكبر من صفر");
          return;
        }

        report(null);
        onCommit(qty);
      }}
      onBlur={() => {
        setDraft(null); // snaps back to the real cart value
        report(null);
      }}
      className={cn(
        "h-10 w-16 border-0 text-center text-sm font-extrabold tabular-nums focus:outline-none sm:h-9",
        invalid ? "bg-red-50 text-red-700" : "bg-transparent text-slate-900"
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// [v6.2] PRICE / DISCOUNT EDITOR (ADMIN only)
// ---------------------------------------------------------------------------

type PriceEditMode = "price" | "amount" | "percent";

const PRICE_EDIT_MODES: ReadonlyArray<{ value: PriceEditMode; label: string; unit: string }> = [
  { value: "price", label: "سعر جديد", unit: "ل.س" },
  { value: "amount", label: "خصم بمبلغ", unit: "ل.س" },
  { value: "percent", label: "خصم بنسبة", unit: "%" },
];

type FinalPriceResult =
  | { ok: true; price: string }
  | { ok: false; message: string | null };

/**
 * Converts what the ADMIN typed into ONE final unit price (SYP), relative to the
 * line's CATALOG price. A discount's input form is only a convenience: the
 * result is a plain final price and nothing about how it was typed survives.
 * All arithmetic is money.ts (decimal), never native. Empty text -> not ready
 * (message null, nothing shown); anything unusable -> an Arabic message.
 */
function computeFinalPrice(catalogPrice: string, mode: PriceEditMode, text: string): FinalPriceResult {
  if (text.trim() === "") return { ok: false, message: null };

  try {
    if (mode === "percent") {
      const pct = parseQuantityInput(text);
      if (pct === null) {
        return {
          ok: false,
          message: AMBIGUOUS_COMMA_RE.test(text) ? "استخدم النقطة (.) للكسور" : "نسبة غير صالحة",
        };
      }
      if (compareMoney(pct, 0) < 0 || compareMoney(pct, 100) > 0) {
        return { ok: false, message: "النسبة يجب أن تكون بين 0 و100" };
      }
      // pct / 100 carried at 8 dp, then applied to the catalog price once.
      const fraction = toDecimal(pct).dividedBy(100).toFixed(8);
      const discount = multiplyMoney(catalogPrice, fraction);
      return { ok: true, price: subtractMoney(catalogPrice, discount) };
    }

    const amount = parseAmountInput(text);
    if (amount === null) return { ok: false, message: "قيمة غير صالحة — أدخل أرقاماً فقط" };

    if (mode === "amount") {
      if (compareMoney(amount, 0) < 0) return { ok: false, message: "الخصم لا يمكن أن يكون سالباً" };
      if (compareMoney(amount, catalogPrice) > 0) {
        return { ok: false, message: "الخصم أكبر من سعر الكتالوج" };
      }
      return { ok: true, price: subtractMoney(catalogPrice, amount) };
    }

    // mode === "price"
    if (compareMoney(amount, 0) < 0) return { ok: false, message: "السعر لا يمكن أن يكون سالباً" };
    return { ok: true, price: amount };
  } catch (error) {
    if (error instanceof MoneyError) return { ok: false, message: "قيمة غير صالحة" };
    throw error;
  }
}

/**
 * The editor body for ONE line. Owns its own draft state (mode + text + error),
 * so the panel itself holds only "which line is open". Applying calls the
 * parent's price funnel; the funnel's refusal (if any) is shown inline.
 */
function LinePriceEditor({
  item,
  onApply,
  onClose,
}: {
  item: CartLineItem;
  onApply: (finalPriceSYP: string) => PriceEditResult;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<PriceEditMode>("price");
  const [text, setText] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);

  // The catalog price this line was added at: the snapshot when already
  // overridden, otherwise the current (= catalog) unit price.
  const catalogPrice = item.listUnitPriceSYP ?? item.unitPriceSYP;
  const preview = computeFinalPrice(catalogPrice, mode, text);
  const activeMode = PRICE_EDIT_MODES.find((m) => m.value === mode) ?? PRICE_EDIT_MODES[0];
  const isZero = preview.ok && compareMoney(preview.price, 0) === 0;

  const apply = () => {
    if (!preview.ok) return;
    const result = onApply(preview.price);
    if (result.ok) {
      onClose();
    } else {
      setApplyError(result.message);
    }
  };

  return (
    <div className="mt-1.5 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-bold text-emerald-800">سعر الكتالوج</span>
        <Money value={catalogPrice} compact className="font-extrabold text-emerald-900" />
      </div>

      {/* How the ADMIN prefers to type it — only an input convenience. */}
      <div
        role="group"
        aria-label="طريقة التعديل"
        className="flex items-center overflow-hidden rounded-md border border-emerald-200 bg-white text-[11px] font-semibold"
      >
        {PRICE_EDIT_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={mode === m.value}
            onClick={() => {
              setMode(m.value);
              setText("");
              setApplyError(null);
            }}
            className={cn(
              "h-8 flex-1 px-2 transition-colors",
              mode === m.value ? "bg-emerald-600 text-white" : "text-slate-600 hover:bg-emerald-50"
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border bg-white px-2.5 py-1.5",
          !preview.ok && preview.message ? "border-red-300" : "border-emerald-200"
        )}
      >
        <input
          type="text"
          inputMode="decimal"
          lang="en"
          dir="ltr"
          autoFocus
          aria-label={activeMode.label}
          aria-invalid={!preview.ok && preview.message ? true : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setApplyError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="0"
          className="h-9 min-w-0 flex-1 border-0 bg-transparent text-center text-sm font-extrabold tabular-nums text-slate-900 focus:outline-none"
        />
        <span className="text-[11px] font-semibold text-slate-500">{activeMode.unit}</span>
      </div>

      {!preview.ok && preview.message && (
        <p role="alert" className="text-[11px] font-semibold text-red-700">
          {preview.message}
        </p>
      )}

      {preview.ok && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-[11px]">
          <span className="font-bold text-slate-600">السعر النهائي للوحدة</span>
          <Money value={preview.price} compact className="font-extrabold text-emerald-700" />
        </div>
      )}

      {isZero && (
        <div className="flex items-start gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-600" aria-hidden />
          <span className="text-[11px] font-semibold text-amber-800">
            السعر صفر — الصنف سيُسجَّل كبضاعة مجانية في هذه الفاتورة.
          </span>
        </div>
      )}

      {applyError && (
        <p role="alert" className="text-[11px] font-semibold text-red-700">
          {applyError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!preview.ok}
          onClick={apply}
          className="h-9 flex-1 bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700"
        >
          تطبيق
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onClose}
          className="h-9 border-slate-200 text-xs font-semibold"
        >
          إلغاء
        </Button>
      </div>
    </div>
  );
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
  lineModes,
  lineAmounts,
  amountErrors = {},
  stockWarnings = {},
  lineNotices = {},
  onToggleLineMode,
  onLineAmountChange,
  onLineQuickQuantity,
  isMobileDrawer = false,
  cartInconsistent = false,
  isAdmin = false,
  onEditLinePrice,
  onClearLinePrice,
}: CartPanelProps) {
  // [Never throw during render] calculateCartTotals() rejects a line whose
  // override no longer holds. If that ever happens the panel must not crash:
  // totals fall back to zeros and checkout is blocked.
  const { totals, totalsFailed } = useMemo(() => {
    try {
      return { totals: calculateCartTotals(items, exchangeRate), totalsFailed: false };
    } catch {
      return { totals: EMPTY_TOTALS, totalsFailed: true };
    }
  }, [items, exchangeRate]);

  // Quantity-field hints (refused text), keyed by cart line id. They live here,
  // not inside the stepper, because the stepper has `overflow-hidden`.
  const [qtyHints, setQtyHints] = useState<Record<string, string>>({});
  const setQtyHint = (id: string, message: string | null) =>
    setQtyHints((prev) => {
      if ((prev[id] ?? null) === message) return prev;
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });

  // [v6.2] Which cart line currently has the price/discount editor open. The
  // editor's own draft lives inside LinePriceEditor (re-mounted per open).
  const [editingLineId, setEditingLineId] = useState<string | null>(null);

  const hasAmountErrors = Object.keys(amountErrors).length > 0;
  const blocked = cartInconsistent || totalsFailed || hasAmountErrors;

  const isRateMissing = exchangeRate === null || compareMoney(exchangeRate, 0) <= 0;
  const isCartEmpty = items.length === 0;

  // [T4b] A missing exchange rate only BLOCKS when the cart contains a
  // USD-priced unit; a SYP-only cart never needs a rate.
  const rateRequired = useMemo(() => cartNeedsExchangeRate(items), [items]);
  const isRateBlocking = rateRequired && isRateMissing;
  const isCheckoutDisabled = isCartEmpty || isRateBlocking || blocked;
  const ready = !isCheckoutDisabled;

  // `syp` is authoritative (never null); `usd` is derived and may be null.
  const lineTotalsMap = useMemo(() => {
    const map = new Map<string, { syp: string; usd: string | null }>();
    for (const lt of totals.lineItems) {
      map.set(lt.id, { syp: lt.lineTotalSYP, usd: lt.lineTotalUSD });
    }
    return map;
  }, [totals.lineItems]);

  // When a line is ADDED, bring the new line into view.
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
            const baseUnit = isBaseUnitLine(item);
            const isAmountMode = baseUnit && lineModes[item.id] === "amount";
            const amountError = amountErrors[item.id];
            const notice = lineNotices[item.id];
            const qtyHint = qtyHints[item.id];
            const hasOverride = item.lineTotalOverrideSYP !== undefined;

            // [v6.2] An EFFECTIVE price override: the snapshot is present AND
            // differs from the final price (the same predicate the server uses).
            const priceEdited = cartHasPriceOverride([item]);
            const catalogPrice = priceEdited ? (item.listUnitPriceSYP as string) : null;
            const perUnitDiff =
              catalogPrice !== null ? subtractMoney(catalogPrice, item.unitPriceSYP) : null;
            const isIncrease = perUnitDiff !== null && compareMoney(perUnitDiff, 0) < 0;
            const perUnitDiffAbs =
              perUnitDiff === null
                ? null
                : isIncrease
                  ? subtractMoney("0", perUnitDiff)
                  : perUnitDiff;

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
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-slate-500">
                      <span>سعر الجملة</span>
                      {priceEdited && catalogPrice !== null && (
                        <Money
                          value={catalogPrice}
                          compact
                          className="font-bold text-slate-400 line-through"
                        />
                      )}
                      <Money value={item.unitPriceSYP} compact className="font-bold text-emerald-700" />
                      {priceEdited && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-bold text-amber-700 ring-1 ring-amber-200">
                          <Tag className="size-2.5" aria-hidden />
                          سعر معدّل
                        </span>
                      )}
                    </p>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemoveItem(item.id)}
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

                  {/* quantity stepper — every edit goes through setLineQuantity in the parent */}
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
                    <QuantityField
                      value={item.quantity}
                      onCommit={(qty) => onSetQuantity(item.id, qty)}
                      onHint={(message) => setQtyHint(item.id, message)}
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

                {/* Refused quantity text (e.g. a comma): nothing was committed */}
                {qtyHint && (
                  <p role="alert" className="mt-1 text-[11px] font-semibold text-red-700">
                    {qtyHint}
                  </p>
                )}

                {/* base-unit lines only: quick weights (D7) + low-key mode switch (D10) */}
                {baseUnit && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      {QUICK_BUTTONS.map((b) => (
                        <button
                          key={b.value}
                          type="button"
                          onClick={() => onLineQuickQuantity(item.id, b.value)}
                          className="h-8 min-w-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-emerald-50"
                          title={b.title}
                          aria-label={b.title}
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>

                    <div
                      role="group"
                      aria-label="وضع الإدخال"
                      className="flex items-center overflow-hidden rounded-md border border-slate-200 bg-slate-50 text-[11px] font-semibold"
                    >
                      <button
                        type="button"
                        aria-pressed={!isAmountMode}
                        onClick={() => {
                          if (isAmountMode) onToggleLineMode(item.id);
                        }}
                        className={cn(
                          "h-8 px-2.5 transition-colors",
                          !isAmountMode ? "bg-white text-slate-800" : "text-slate-500 hover:bg-white"
                        )}
                      >
                        بالكمية
                      </button>
                      <button
                        type="button"
                        aria-pressed={isAmountMode}
                        onClick={() => {
                          if (!isAmountMode) onToggleLineMode(item.id);
                        }}
                        className={cn(
                          "h-8 px-2.5 transition-colors",
                          isAmountMode ? "bg-emerald-50 text-emerald-700" : "text-slate-500 hover:bg-white"
                        )}
                      >
                        بالمبلغ
                      </button>
                    </div>
                  </div>
                )}

                {/* [D8/D10] Amount input when in "بالمبلغ" mode */}
                {isAmountMode && (
                  <div className="mt-2">
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5",
                        amountError ? "border-red-300 bg-red-50" : "border-emerald-200 bg-emerald-50"
                      )}
                    >
                      <span className="text-[11px] font-semibold text-emerald-700">المبلغ</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        lang="en"
                        dir="ltr"
                        aria-label="المبلغ بالليرة"
                        aria-invalid={amountError ? true : undefined}
                        value={lineAmounts[item.id] ?? ""}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => onLineAmountChange(item.id, e.target.value)}
                        className="h-10 min-w-0 flex-1 border-0 bg-transparent text-center text-sm font-extrabold tabular-nums text-emerald-900 focus:outline-none"
                        placeholder="0"
                      />
                      <span className="text-[11px] font-semibold text-emerald-700">ل.س</span>
                    </div>

                    {amountError && (
                      <p role="alert" className="mt-1 text-[11px] font-semibold text-red-700">
                        {amountError}
                      </p>
                    )}
                  </div>
                )}

                {/* [D2] Derived quantity, large: "5,000 ل.س ← 0.3333 كغ" */}
                {isAmountMode && hasOverride && !amountError && (
                  <p className="mt-1.5 text-center text-base font-extrabold tabular-nums text-emerald-700">
                    {fmtMoney(item.lineTotalOverrideSYP as string, "SYP")} ل.س ←{" "}
                    <span dir="ltr">{formatQuantityText(item.quantity)}</span> {item.unitName}
                  </p>
                )}

                {/* [D9] Visible notice after a price change re-derived / cleared the amount */}
                {notice && (
                  <div
                    role="status"
                    className="mt-1.5 flex items-start gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1"
                  >
                    <Info className="mt-px size-3.5 shrink-0 text-amber-600" aria-hidden />
                    <span className="text-[11px] font-semibold text-amber-800">{notice}</span>
                  </div>
                )}

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

                {/* [D6] Non-blocking stock warning (computed by the parent) */}
                {stockWarnings[item.id] && (
                  <div className="mt-1.5 flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1">
                    <AlertTriangle className="size-3.5 shrink-0 text-amber-600" aria-hidden />
                    <span className="text-[11px] font-semibold text-amber-800">
                      الكمية أكبر من المخزون المسجّل
                    </span>
                  </div>
                )}

                {/* [v6.2] ADMIN-only: price / discount for THIS sale only.
                    Absent (not disabled) for a CASHIER; the server enforces it too. */}
                {isAdmin && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px]">
                    {priceEdited && perUnitDiffAbs !== null ? (
                      <>
                        <span className="font-bold text-amber-800">
                          {isIncrease ? "زيادة" : "خصم"} الوحدة:
                        </span>
                        <Money value={perUnitDiffAbs} compact className="font-extrabold text-amber-900" />
                      </>
                    ) : (
                      <span className="font-semibold text-slate-500">تعديل سعر هذا البيع فقط</span>
                    )}

                    <span className="ms-auto flex items-center gap-1">
                      {priceEdited && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingLineId(null);
                            onClearLinePrice?.(item.id);
                          }}
                          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-bold text-slate-600 transition-colors hover:bg-white hover:text-emerald-700"
                          title="إرجاع السعر إلى سعر الكتالوج"
                          aria-label="إرجاع السعر إلى سعر الكتالوج"
                        >
                          <RotateCcw className="size-3.5" aria-hidden />
                          سعر الكتالوج
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingLineId(editingLineId === item.id ? null : item.id)}
                        className={cn(
                          "inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-bold transition-colors",
                          editingLineId === item.id
                            ? "bg-emerald-600 text-white"
                            : "text-emerald-700 hover:bg-white"
                        )}
                        aria-expanded={editingLineId === item.id}
                        aria-label={editingLineId === item.id ? "إغلاق تعديل السعر" : "تعديل السعر أو إضافة خصم"}
                      >
                        {editingLineId === item.id ? (
                          <X className="size-3.5" aria-hidden />
                        ) : (
                          <Pencil className="size-3.5" aria-hidden />
                        )}
                        {editingLineId === item.id ? "إغلاق" : "سعر / خصم"}
                      </button>
                    </span>
                  </div>
                )}

                {isAdmin && editingLineId === item.id && onEditLinePrice && (
                  <LinePriceEditor
                    item={item}
                    onApply={(finalPriceSYP) => onEditLinePrice(item.id, finalPriceSYP)}
                    onClose={() => setEditingLineId(null)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ------------------------------------------------ rate notices */}
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

      {blocked && (
        <div
          role="alert"
          className="mx-3 mt-3 shrink-0 space-y-1 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800"
        >
          <div className="flex items-center gap-1.5 font-extrabold">
            <AlertTriangle className="size-4 shrink-0 text-red-600" aria-hidden />
            <span>
              {hasAmountErrors && !totalsFailed && !cartInconsistent
                ? "يوجد مبلغ غير صالح في السلة"
                : "السلة غير متسقة — أعد إدخال المبالغ"}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-red-700">
            {hasAmountErrors && !totalsFailed && !cartInconsistent
              ? "صحّح المبلغ المحدّد بالأحمر أو أفرغ الحقل قبل المتابعة."
              : "تعذّر إعادة حساب إجمالي السلة — يرجى تصحيح المبالغ قبل المتابعة."}
          </p>
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
                    : blocked
                      ? "صحّح المبالغ أولاً"
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