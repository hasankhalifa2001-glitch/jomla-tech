"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Search,
  Barcode,
  Package,
  Plus,
  Info,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import type { PosProductItem, CachedProductUnit } from "@/lib/offline";
import {
  resolveUnitPriceSYP,
  resolveUnitPriceUSD,
  breakdownStockByUnits,
  formatStockBreakdown,
} from "@/lib/offline";
import { formatMoney } from "@/lib/utils/money";
import Image from "next/image";

interface ProductCatalogProps {
  products: PosProductItem[];
  isLoading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  exchangeRate: number | null;
  onAddToCart: (product: PosProductItem, unit: CachedProductUnit) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /**
   * [ADDED — hardware keyboard-wedge scanner support]
   * Delegates exact-barcode resolution to the SAME full-local-cache lookup
   * the camera scanner uses (findProductUnitByBarcode via PosLayout's
   * handleBarcodeScan) — instead of this component searching its own
   * `products` prop, which is a debounced, potentially-stale, text-filtered
   * SUBSET of the catalog, not the full local cache. A physical USB/
   * Bluetooth scanner types a barcode into this input and fires Enter
   * within milliseconds — often faster than the 300ms search debounce in
   * PosLayout can resolve — so matching against `products` alone could
   * silently miss a real, in-stock item.
   *
   * Returns true if the string was recognized and handled as a barcode
   * (found-and-added, OR found-but-rejected e.g. inactive unit) — false
   * only when nothing matched at all, so the caller knows to fall through
   * to the plain "single filtered text result" convenience below rather
   * than treating an unrelated free-text search as a failed barcode scan.
   */
  onBarcodeEnter: (raw: string) => Promise<boolean>;
}

// [v3.6] FIX — this used to resolve and display USD as the primary price
// for every unit via resolveUnitPriceUSD, treating USD as authoritative.
// SYP is now authoritative (schema.prisma / pos-service.ts): every price
// shown here goes through resolveUnitPriceSYP first. A SYP-priced unit
// resolves with NO exchange rate needed at all (the reverse of the
// pre-v3.6 direction, where a SYP-priced unit was the one that needed a
// rate to show its USD-primary price). A USD-priced unit still needs a
// cached rate to convert INTO SYP — `resolveUnitPriceSYP` throws in that
// case (fail-loud, per lib/utils/money.ts), and this wrapper catches that
// specific, expected case and returns `null` so the UI can show "يتطلب
// سعر الصرف" instead of crashing the whole product grid over one item.
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

export function ProductCatalog({
  products,
  isLoading,
  searchQuery,
  onSearchChange,
  exchangeRate,
  onAddToCart,
  searchInputRef,
  onBarcodeEnter,
}: ProductCatalogProps) {
  // Handle Barcode Scan (hardware keyboard-wedge scanner) / Enter key press
  // on the search input.
  //
  // [CHANGED] Was: a `for (const prod of products)` loop matching against
  // this component's OWN `products` prop — the currently-displayed,
  // debounced, text-filtered subset. That had two real bugs:
  //   1. A hardware scanner's Enter often arrives before the 300ms search
  //      debounce in PosLayout resolves, so `products` could still reflect
  //      a PREVIOUS, unrelated search — a genuine in-stock barcode could
  //      silently fail to match anything in the stale list.
  //   2. A barcode that matched but only on a deactivated unit produced NO
  //      feedback at all (the `u.isActive !== false` filter excluded it
  //      from the `.find()`, and there was no toast/message for this case)
  //      — the cashier had zero indication of why nothing happened.
  // Now delegates entirely to `onBarcodeEnter`, which searches the FULL
  // local cache (via findProductUnitByBarcode in PosLayout) and returns a
  // definite recognized/not-recognized signal, including a proper Arabic
  // toast for the inactive-unit case. See product-catalog's prop doc above.
  async function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter" || !searchQuery.trim()) return;
    e.preventDefault();

    const clean = searchQuery.trim();

    const matchedAsBarcode = await onBarcodeEnter(clean);
    if (matchedAsBarcode) {
      onSearchChange("");
      return;
    }

    // Unrelated to barcode matching: a plain text-search convenience —
    // if free-text typing has narrowed the currently-displayed list to
    // exactly one product, Enter adds its default active unit. Unchanged
    // from the original behavior.
    if (products.length === 1 && products[0].units && products[0].units.length > 0) {
      const defaultActiveUnit = products[0].units.find((u) => u.isActive !== false);
      if (defaultActiveUnit) {
        onAddToCart(products[0], defaultActiveUnit);
        onSearchChange("");
      }
    }
  }

  return (
    <div className="flex flex-col h-full space-y-3">
      {/* Search and Barcode Input Bar */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-3 h-4 w-4 text-zinc-400" />
          <Input
            ref={searchInputRef}
            type="text"
            placeholder="ابحث بالاسم أو الباركود أو الوحدة…"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => void handleKeyDown(e)}
            className="pr-9 pl-16 text-sm h-11 rounded-xl bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-xs"
          />
          <div className="absolute left-2.5 top-3 flex items-center gap-1">
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 bg-zinc-100 dark:bg-zinc-800 rounded border border-zinc-200 dark:border-zinc-700">
              F2
            </kbd>
            <Barcode className="h-4 w-4 text-zinc-400" />
          </div>
        </div>

        {searchQuery && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onSearchChange("")}
            className="text-xs h-11 px-3 text-zinc-500 hover:text-zinc-800 shrink-0"
          >
            مسح
          </Button>
        )}
      </div>

      {/* Products Grid / View Area */}
      <div className="flex-1 overflow-y-auto pr-0.5">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-64 space-y-2 text-zinc-400">
            <RefreshCw className="h-6 w-6 animate-spin text-emerald-600" />
            <span className="text-xs font-medium">
              جاري قراءة الأصناف من الذاكرة المحلية (Dexie)...
            </span>
          </div>
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-72 rounded-2xl border-2 border-dashed border-zinc-200 dark:border-zinc-800 p-6 text-center space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-400">
              <Package className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-bold text-zinc-700 dark:text-zinc-300">
                {searchQuery
                  ? "لم يتم العثور على أصناف تطابق بحثك"
                  : "قاعدة الأصناف المحلية فارغة"}
              </p>
              <p className="text-xs text-zinc-400 max-w-sm mt-1">
                {searchQuery
                  ? "جرب البحث بكلمات أخرى أو تحقق من قراءة الباركود بشكل صحيح."
                  : "استخدم زر «مزامنة الأصناف» لتحميل أصناف متجرك، أو أضفها أولاً من صفحة المخزون."}
              </p>
            </div>
          </div>
        ) : (
          // [FIX — responsive grid] The catalog only ever occupies
          // col-span-7/12 (lg) or col-span-8/12 (xl) of the page grid —
          // its real width is much narrower than the viewport breakpoint
          // that triggers each column count. The old
          // `sm:grid-cols-2 xl:grid-cols-3` jumped straight from 2 to 3
          // columns at the `xl` viewport breakpoint even though the
          // catalog's own container is still fairly narrow there. Added
          // an explicit `lg:grid-cols-2` (container is at its narrowest
          // relative width right when `lg` first applies) and a
          // `2xl:grid-cols-4` step for when the container is genuinely
          // wide enough to hold a 4th column comfortably.
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 pb-2">
            {products.map((product) => {
              const activeUnits = product.units?.filter((u) => u.isActive !== false) ?? [];
              const defaultUnit = activeUnits[0];
              // The base unit (factor 1) — used only to word each other unit's
              // size ("= 80 قطعة") so the cashier sees what a carton contains.
              const baseUnit = product.units?.find((u) => Number(u.conversionFactor) === 1);

              // [v3.6] Primary — SYP, authoritative, never requires a rate
              // for a SYP-priced unit.
              const wholesalePriceSYP = defaultUnit
                ? resolveSYPOrNull(defaultUnit, product, exchangeRate)
                : null;
              // [v3.6] Secondary — USD, derived/display-only. Never
              // throws (resolveUnitPriceUSD returns null on a missing
              // rate instead), so no try/catch wrapper is needed here.
              const wholesalePriceUSD = defaultUnit
                ? resolveUnitPriceUSD(defaultUnit, product, exchangeRate)
                : null;

              // [FIX] `totalCachedStock` is now correctly computed in the
              // product's base unit (pos-service.ts). Rendered here as a
              // multi-unit breakdown ("5 كرتونة و5 قطعة") instead of a
              // raw base-unit number ("65"), which is unreadable for the
              // merchant and doesn't match how they think about their own
              // shelves.
              const stockLabel = formatStockBreakdown(
                breakdownStockByUnits(product.totalCachedStock, product.units || [])
              );

              // [UX] Stock stays INFORMATIONAL (it deliberately never blocks a
              // sale — see the badge tooltip), but an empty shelf is now
              // visible at a glance instead of reading like any other number.
              const stockNumber = Number(product.totalCachedStock);
              const isOutOfStock = Number.isFinite(stockNumber) && stockNumber <= 0;

              return (
                <Card
                  key={product.id}
                  className="overflow-hidden border-zinc-200 bg-white hover:border-emerald-500 hover:shadow-md transition-all dark:border-zinc-800 dark:bg-zinc-900 group"
                >
                  <CardContent className="p-3.5 space-y-2.5">
                    {/* Header: Name and Informational Stock Badge */}
                    <div className="space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {product.imageUrl && (
                            <Image
                              src={product.imageUrl}
                              alt={product.name}
                              width={36}
                              height={36}
                              className="w-9 h-9 rounded-lg object-cover shrink-0 border border-zinc-200 dark:border-zinc-800"
                            />
                          )}
                          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 line-clamp-2 group-hover:text-emerald-600 transition-colors">
                            {product.name}
                          </h3>
                        </div>
                      </div>

                      <Badge
                        variant="secondary"
                        className={`text-[10px] font-mono px-1.5 py-0.5 ${isOutOfStock
                          ? "bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                          }`}
                        title="مستوى المخزون المخزن محلياً (معلوماتي فقط ولا يقيد البيع)"
                      >
                        {isOutOfStock ? (
                          <AlertTriangle className="h-2.5 w-2.5 ml-1 text-red-500" />
                        ) : (
                          <Info className="h-2.5 w-2.5 ml-1 text-zinc-400" />
                        )}
                        {isOutOfStock ? "نفد المخزون" : `المخزون: ${stockLabel}`}
                      </Badge>

                      {wholesalePriceSYP === null && (
                        <Badge
                          variant="outline"
                          className="text-[10px] gap-1 text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950/50 dark:text-amber-300"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          يتطلب تحديد سعر الصرف اليومي
                        </Badge>
                      )}
                      {wholesalePriceSYP !== null && wholesalePriceUSD !== null && (
                        <p className="text-[11px] font-semibold text-purple-600 dark:text-purple-400">
                          <span dir="ltr" className="inline-block">
                            ≈ ${formatMoney(wholesalePriceUSD, "USD")}
                          </span>{" "}
                          <span className="text-zinc-400 font-normal">للوحدة الأولى</span>
                        </p>
                      )}
                    </div>

                    {/* [UX] Units as full-width rows (≥44px tall): name on the
                        right, price on the left in bold. A whole row is the tap
                        target — much easier with a thumb than small chips. */}
                    <div className="space-y-1.5 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                      <span className="text-[11px] font-semibold text-zinc-400 block">
                        اختر الوحدة لإضافتها للسلة:
                      </span>

                      {activeUnits.length === 0 && (
                        <p className="text-xs text-zinc-400">لا توجد وحدة فعّالة لهذا الصنف.</p>
                      )}

                      <div className="space-y-1.5">
                        {activeUnits.map((unit) => {
                          const unitPriceSYP = resolveSYPOrNull(unit, product, exchangeRate);
                          const isDisabled = unitPriceSYP === null;
                          const factor = Number(unit.conversionFactor);
                          const showFactor =
                            !!baseUnit && unit.id !== baseUnit.id && Number.isFinite(factor);
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
                              className={`flex w-full min-h-11 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-right transition-all ${isDisabled
                                ? "border-zinc-200 bg-zinc-100 text-zinc-400 cursor-not-allowed dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-600"
                                : "border-zinc-200 bg-zinc-50 text-zinc-800 hover:border-emerald-600 hover:bg-emerald-50 hover:text-emerald-900 active:scale-[0.99] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-emerald-950/60 dark:hover:text-emerald-300"
                                }`}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <Plus
                                  className={`h-4 w-4 shrink-0 ${isDisabled ? "text-zinc-400" : "text-emerald-600"}`}
                                />
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-bold">{unit.unitName}</span>
                                  {showFactor && (
                                    <span className="block text-[10px] opacity-70">
                                      = {factor} {baseUnit.unitName}
                                    </span>
                                  )}
                                </span>
                              </span>
                              <span className="shrink-0 text-sm font-extrabold tabular-nums">
                                {unitPriceSYP !== null ? (
                                  <>
                                    <span dir="ltr">{formatMoney(unitPriceSYP, "SYP")}</span> ل.س
                                  </>
                                ) : (
                                  <span className="text-[11px] font-medium">يتطلب سعر الصرف</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}