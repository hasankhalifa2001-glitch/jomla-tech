"use client";

/**
 * components/pos/product-catalog.tsx
 *
 * Two exports now:
 *  - <ProductSearchBar>  the search / hardware-scanner input. It lives in
 *    PosLayout's top command bar (next to scan / sync / printer) instead of
 *    inside the catalog, so ONE row serves every screen size.
 *  - <ProductCatalog>    the product grid only.
 *
 * Light-only styling (slate + emerald), matching the dashboard. All numbers go
 * through <Money> / fmtQty so digits are Latin (a "٠" no longer reads as "•").
 */

import Image from "next/image";
import { AlertTriangle, Barcode, Package, PackageSearch, Plus, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { PosProductItem, CachedProductUnit } from "@/lib/offline";
import {
  resolveUnitPriceSYP,
  resolveUnitPriceUSD,
  breakdownStockByUnits,
  formatStockBreakdown,
} from "@/lib/offline";
import { cn } from "@/lib/utils";
import { fmtInt, fmtMoney, fmtQty, localizeDigits } from "@/lib/utils/digits";
import { Money } from "./money";

// [v3.6] SYP is authoritative: every price shown here goes through
// resolveUnitPriceSYP first. A SYP-priced unit needs NO exchange rate; a
// USD-priced unit needs a cached rate to convert INTO SYP, and
// resolveUnitPriceSYP throws in that case (fail-loud, lib/utils/money.ts).
// This wrapper turns that one expected case into `null` so the UI can say
// "يتطلب سعر الصرف" instead of crashing the whole grid over one item.
function resolveSYPOrNull(
  unit: CachedProductUnit,
  product: PosProductItem,
  exchangeRate: number | null
): string | null {
  try {
    return resolveUnitPriceSYP(unit, product, exchangeRate);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search bar
// ---------------------------------------------------------------------------

interface ProductSearchBarProps {
  /** The currently displayed (filtered) list — only used for the
   *  "exactly one result → Enter adds its default unit" convenience. */
  products: PosProductItem[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onAddToCart: (product: PosProductItem, unit: CachedProductUnit) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /**
   * [hardware keyboard-wedge scanner support]
   * Delegates exact-barcode resolution to the SAME full-local-cache lookup
   * the camera scanner uses (findProductUnitByBarcode via PosLayout's
   * handleBarcodeScan) instead of matching against `products`, which is a
   * debounced, potentially stale, text-filtered SUBSET of the catalog. A
   * physical scanner types the barcode and fires Enter within milliseconds —
   * often before the 300ms search debounce resolves.
   *
   * Returns true if the string was recognised and handled as a barcode
   * (found-and-added, OR found-but-rejected e.g. inactive unit) — false only
   * when nothing matched, so the caller falls through to the plain
   * "single filtered text result" convenience.
   */
  onBarcodeEnter: (raw: string) => Promise<boolean>;
  className?: string;
}

export function ProductSearchBar({
  products,
  searchQuery,
  onSearchChange,
  onAddToCart,
  searchInputRef,
  onBarcodeEnter,
  className,
}: ProductSearchBarProps) {
  async function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter" || !searchQuery.trim()) return;
    e.preventDefault();

    const clean = searchQuery.trim();

    const matchedAsBarcode = await onBarcodeEnter(clean);
    if (matchedAsBarcode) {
      onSearchChange("");
      return;
    }

    // Plain text-search convenience: if free-text typing has narrowed the
    // displayed list to exactly one product, Enter adds its default active
    // unit. Unchanged from the original behaviour.
    if (products.length === 1 && products[0].units && products[0].units.length > 0) {
      const defaultActiveUnit = products[0].units.find((u) => u.isActive !== false);
      if (defaultActiveUnit) {
        onAddToCart(products[0], defaultActiveUnit);
        onSearchChange("");
      }
    }
  }

  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute inset-s-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400"
        aria-hidden
      />
      <Input
        ref={searchInputRef}
        type="text"
        autoComplete="off"
        enterKeyHint="search"
        aria-label="بحث عن صنف"
        placeholder="ابحث بالاسم أو الباركود…"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={(e) => void handleKeyDown(e)}
        className={cn(
          "h-11 rounded-xl border-slate-200 bg-white ps-10 text-sm shadow-sm placeholder:text-slate-400",
          "focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20",
          searchQuery ? "pe-11" : "pe-11 sm:pe-20"
        )}
      />
      <div className="absolute inset-e-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
        {searchQuery ? (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label="مسح البحث"
            className="flex size-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : (
          <>
            <kbd className="hidden items-center rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 sm:inline-flex">
              F2
            </kbd>
            <Barcode className="size-4 text-slate-400" aria-hidden />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface ProductCatalogProps {
  products: PosProductItem[];
  isLoading: boolean;
  searchQuery: string;
  exchangeRate: number | null;
  onAddToCart: (product: PosProductItem, unit: CachedProductUnit) => void;
  /** cart line id (`${product.id}-${unit.id}`) → quantity in the cart. Lets
   *  each unit button show how many are already in the cart. */
  cartQuantities?: Record<string, number>;
}

function countLabel(n: number): string {
  const word = n === 1 ? "صنف" : n === 2 ? "صنفان" : n <= 10 ? "أصناف" : "صنفاً";
  return n === 2 ? word : `${fmtInt(n)} ${word}`;
}

export function ProductCatalog({
  products,
  isLoading,
  searchQuery,
  exchangeRate,
  onAddToCart,
  cartQuantities,
}: ProductCatalogProps) {
  // [UX] A re-query (every keystroke) must not blank the grid: the skeleton is
  // only for "nothing to show yet"; otherwise the old list stays, dimmed.
  const showSkeleton = isLoading && products.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The bottom padding lives INSIDE the scroller (not on the page grid)
                so the list scrolls under the mobile floating bars and the last
                card can still be lifted clear of them. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-0.5 pb-44 pt-0.5 lg:pb-2" aria-busy={isLoading}>
        {showSkeleton ? (
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
            aria-label="جاري تحميل الأصناف"
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : products.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-white p-6 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <PackageSearch className="size-6" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-extrabold text-slate-800">
                {searchQuery ? "لا أصناف تطابق بحثك" : "قاعدة الأصناف المحلية فارغة"}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-600">
                {searchQuery
                  ? "جرّب كلمات أخرى، أو تأكد من قراءة الباركود بشكل صحيح."
                  : "اضغط «مزامنة الأصناف» لتحميل أصناف متجرك، أو أضفها أولاً من صفحة المخزون."}
              </p>
            </div>
          </div>
        ) : (
          <div className={cn("transition-opacity duration-200", isLoading && "opacity-60")}>
            <p className="mb-2 text-xs font-medium text-slate-500">{countLabel(products.length)}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  exchangeRate={exchangeRate}
                  onAddToCart={onAddToCart}
                  cartQuantities={cartQuantities}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProductCard({
  product,
  exchangeRate,
  onAddToCart,
  cartQuantities,
}: {
  product: PosProductItem;
  exchangeRate: number | null;
  onAddToCart: (product: PosProductItem, unit: CachedProductUnit) => void;
  cartQuantities?: Record<string, number>;
}) {
  const activeUnits = product.units?.filter((u) => u.isActive !== false) ?? [];
  const defaultUnit = activeUnits[0];
  // The base unit (factor 1) — used only to word each other unit's size
  // ("= 80 قطعة") so the cashier sees what a carton contains.
  const baseUnit = product.units?.find((u) => Number(u.conversionFactor) === 1);

  const needsRate = !!defaultUnit && resolveSYPOrNull(defaultUnit, product, exchangeRate) === null;

  // `totalCachedStock` is in the product's base unit; shown as a multi-unit
  // breakdown ("5 كرتونة و5 قطعة") the way the merchant counts shelves.
  const stockLabel = localizeDigits(
    formatStockBreakdown(breakdownStockByUnits(product.totalCachedStock, product.units || []))
  );

  // Stock stays INFORMATIONAL (it never blocks a sale), but an empty shelf is
  // visible at a glance.
  const stockNumber = Number(product.totalCachedStock);
  const isOutOfStock = Number.isFinite(stockNumber) && stockNumber <= 0;

  const initial = product.name.trim().charAt(0);

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow duration-200 hover:shadow-md">
      <header className="flex items-start gap-2.5">
        {product.imageUrl ? (
          <Image
            src={product.imageUrl}
            alt={product.name}
            width={40}
            height={40}
            className="size-10 shrink-0 rounded-lg border border-slate-200 object-cover"
          />
        ) : (
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-base font-extrabold text-emerald-700 ring-1 ring-emerald-100"
            aria-hidden
          >
            {initial || <Package className="size-5" />}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[13px] font-extrabold leading-snug text-slate-900">
            {product.name}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              title="مستوى المخزون المخزن محلياً (معلوماتي فقط ولا يقيد البيع)"
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold",
                isOutOfStock
                  ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                  : "bg-slate-100 text-slate-600"
              )}
            >
              {isOutOfStock ? (
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
              ) : (
                <Package className="size-3 shrink-0 text-slate-400" aria-hidden />
              )}
              <span className="truncate">
                {isOutOfStock ? "نفد المخزون" : `المخزون: ${stockLabel}`}
              </span>
            </span>

            {needsRate && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-800 ring-1 ring-amber-200">
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                يتطلب سعر الصرف
              </span>
            )}
          </div>
        </div>
      </header>

      {activeUnits.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          لا توجد وحدة فعّالة لهذا الصنف.
        </p>
      ) : (
        // Each unit is a whole tap target. They sit side by side when the
        // card is wide enough (phone) and stack full-width when it isn't.
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
          {activeUnits.map((unit) => {
            const unitPriceSYP = resolveSYPOrNull(unit, product, exchangeRate);
            const isDisabled = unitPriceSYP === null;
            // [v3.6] USD is derived / display-only and never throws.
            const unitPriceUSD = isDisabled
              ? null
              : resolveUnitPriceUSD(unit, product, exchangeRate);
            const factor = Number(unit.conversionFactor);
            const showFactor = !!baseUnit && unit.id !== baseUnit.id && Number.isFinite(factor);
            const inCart = cartQuantities?.[`${product.id}-${unit.id}`] ?? 0;

            return (
              <button
                key={unit.id}
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (!isDisabled) onAddToCart(product, unit);
                }}
                title={
                  isDisabled
                    ? "لا يمكن إضافة هذه الوحدة بدون تحديد سعر الصرف اليومي أولاً"
                    : undefined
                }
                className={cn(
                  "group/unit flex min-w-0 flex-1 basis-36 flex-col gap-1 rounded-xl border p-2.5 text-start transition-all duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
                  isDisabled
                    ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                    : inCart > 0
                      ? "border-emerald-500 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 active:scale-[0.98]"
                      : "border-slate-200 bg-slate-50 text-slate-800 hover:border-emerald-500 hover:bg-emerald-50 active:scale-[0.98]"
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-extrabold">{unit.unitName}</span>
                  {inCart > 0 ? (
                    // Re-mounts on every change, so adding another one bumps the badge.
                    <span
                      key={inCart}
                      className="flex h-6 min-w-6 animate-in items-center justify-center rounded-full bg-emerald-600 px-1.5 text-[11px] font-extrabold tabular-nums text-white duration-200 zoom-in-50 motion-reduce:animate-none"
                      title="الكمية الموجودة في السلة"
                    >
                      {fmtInt(inCart)}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full transition-colors",
                        isDisabled
                          ? "bg-slate-200 text-slate-400"
                          : "bg-emerald-100 text-emerald-700 group-hover/unit:bg-emerald-600 group-hover/unit:text-white"
                      )}
                      aria-hidden
                    >
                      <Plus className="size-3.5" />
                    </span>
                  )}
                </span>

                {unitPriceSYP !== null ? (
                  <Money
                    value={unitPriceSYP}
                    className={cn(
                      "text-[15px] font-extrabold",
                      inCart > 0 ? "text-emerald-800" : "text-slate-900"
                    )}
                  />
                ) : (
                  <span className="text-[11px] font-medium">يتطلب سعر الصرف</span>
                )}

                {(showFactor || unitPriceUSD !== null) && (
                  <span className="flex flex-wrap items-center gap-x-2 text-[11px] leading-tight text-slate-500">
                    {showFactor && (
                      <span>
                        = {fmtQty(factor)} {baseUnit.unitName}
                      </span>
                    )}
                    {unitPriceUSD !== null && (
                      <bdi dir="ltr" className="font-semibold text-purple-600">
                        ≈ ${fmtMoney(unitPriceUSD, "USD")}
                      </bdi>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}