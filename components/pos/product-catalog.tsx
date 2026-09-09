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
  Sparkles,
  RefreshCw,
  Tag,
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

interface ProductCatalogProps {
  products: PosProductItem[];
  isLoading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  exchangeRate: number | null;
  onAddToCart: (product: PosProductItem, unit: CachedProductUnit) => void;
  onSeedDemoData: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
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
  onSeedDemoData,
  searchInputRef,
}: ProductCatalogProps) {
  // Handle Barcode Scan / Enter key press on search input
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && searchQuery.trim()) {
      e.preventDefault();
      const clean = searchQuery.trim().toLowerCase();

      // Check if there is an exact barcode match among active units
      for (const prod of products) {
        const matchingUnit = prod.units?.find(
          (u) => u.isActive !== false && u.barcode && u.barcode.toLowerCase() === clean
        );
        if (matchingUnit) {
          onAddToCart(prod, matchingUnit);
          onSearchChange("");
          return;
        }
      }

      // If only 1 product matches in the current filtered list, add its default active unit
      if (products.length === 1 && products[0].units && products[0].units.length > 0) {
        const defaultActiveUnit = products[0].units.find((u) => u.isActive !== false);
        if (defaultActiveUnit) {
          onAddToCart(products[0], defaultActiveUnit);
          onSearchChange("");
        }
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
            placeholder="ابحث بالاسم، الباركود، أو الوحدة... (F2 للتركيز، Enter للإضافة السريعة)"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pr-9 pl-16 text-xs h-10 rounded-xl bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-xs"
          />
          <div className="absolute left-2.5 top-2.5 flex items-center gap-1">
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
            className="text-xs h-10 px-3 text-zinc-500 hover:text-zinc-800 shrink-0"
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
                  : "يمكنك تحميل بيانات تجريبية فوراً لاختبار نقطة البيع في وضع عدم الاتصال بالكامل."}
              </p>
            </div>

            {!searchQuery && (
              <Button
                type="button"
                onClick={onSeedDemoData}
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold gap-2 rounded-xl shadow-md shadow-emerald-600/20"
              >
                <Sparkles className="h-4 w-4" />
                تحميل بيانات تجريبية للمخزن المحلي
              </Button>
            )}
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
              const defaultUnit = product.units?.find((u) => u.isActive !== false);
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

              // priceRetail is stored in the SAME pricingCurrency as
              // priceWholesale on that unit — resolved the same way, by
              // temporarily substituting priceRetail as the "wholesale"
              // value being resolved (the currency-resolution logic is
              // identical for either field; only the DB write path
              // treats them differently, not the currency math).
              const retailPriceSYP =
                defaultUnit?.priceRetail !== undefined
                  ? resolveSYPOrNull(
                    { ...defaultUnit, priceWholesale: defaultUnit.priceRetail },
                    product,
                    exchangeRate
                  )
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

              return (
                <Card
                  key={product.id}
                  className="overflow-hidden border-zinc-200 bg-white hover:border-emerald-500 hover:shadow-md transition-all dark:border-zinc-800 dark:bg-zinc-900 group"
                >
                  <CardContent className="p-3.5 space-y-2.5">
                    {/* Header: Name and Informational Stock Badge */}
                    <div className="space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 line-clamp-1 group-hover:text-emerald-600 transition-colors">
                          {product.name}
                        </h3>
                        <Badge
                          variant="secondary"
                          className="shrink-0 text-[10px] font-mono px-1.5 py-0 bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                          title="مستوى المخزون المخزن محلياً (معلوماتي فقط ولا يقيد البيع)"
                        >
                          <Info className="h-2.5 w-2.5 ml-1 text-zinc-400" />
                          المخزون: {stockLabel}
                        </Badge>
                      </div>

                      {/*
                        [FIX — layout bug] The previous markup put the
                        retail strikethrough price INSIDE the same
                        `flex-wrap` row as the SYP/USD prices, positioned
                        with `mr-auto`. `margin-auto` on a wrapped flex
                        item doesn't reliably push to the row's end once
                        wrapping actually kicks in (long product names /
                        narrow cards), so the retail price could land
                        directly after the USD price instead of visually
                        separated. Split into two independent flex
                        containers with `justify-between`: the primary
                        price block on the "start" side, retail price
                        pinned to the "end" side — position is guaranteed
                        regardless of how the primary block wraps.
                      */}
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="flex items-baseline flex-wrap gap-x-2 gap-y-0.5 min-w-0">
                          {wholesalePriceSYP !== null ? (
                            <>
                              <span className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400 font-mono">
                                {formatMoney(wholesalePriceSYP, "SYP")} ل.س
                              </span>
                              {wholesalePriceUSD !== null && (
                                <span className="text-[11px] font-semibold text-purple-600 dark:text-purple-400">
                                  ≈ ${formatMoney(wholesalePriceUSD, "USD")}
                                </span>
                              )}
                            </>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] gap-1 text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950/50 dark:text-amber-300"
                            >
                              <AlertTriangle className="h-3 w-3" />
                              يتطلب تحديد سعر الصرف اليومي
                            </Badge>
                          )}
                        </div>

                        {wholesalePriceSYP !== null && retailPriceSYP !== null && (
                          <span className="shrink-0 text-[10px] text-zinc-400 line-through decoration-zinc-300 flex items-center gap-0.5">
                            <Tag className="h-2.5 w-2.5" />
                            مفرد: {formatMoney(retailPriceSYP, "SYP")} ل.س
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Available Units Grid / Buttons */}
                    <div className="space-y-1 pt-1 border-t border-zinc-100 dark:border-zinc-800">
                      <span className="text-[10px] font-semibold text-zinc-400 block">
                        الوحدات المتوفرة (اختر لإضافة السلة):
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {product.units?.filter((u) => u.isActive !== false).map((unit) => {
                          const unitPriceSYP = resolveSYPOrNull(unit, product, exchangeRate);
                          const isDisabled = unitPriceSYP === null;
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
                              // [FIX — touch target] py-1.5 on mobile
                              // (dropping to the original py-1 from `sm:`
                              // up) so these buttons stay comfortably
                              // tappable with a thumb on a phone without
                              // making them bulkier on desktop/mouse use.
                              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 sm:py-1 text-right text-[11px] font-medium transition-all ${isDisabled
                                ? "border-zinc-200 bg-zinc-100 text-zinc-400 cursor-not-allowed dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-600"
                                : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:border-emerald-600 hover:bg-emerald-50 hover:text-emerald-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-emerald-950/60 dark:hover:text-emerald-300"
                                }`}
                            >
                              <Plus className={`h-3 w-3 shrink-0 ${isDisabled ? "text-zinc-400" : "text-emerald-600"}`} />
                              <span className="font-semibold">{unit.unitName}</span>
                              <span className="text-[10px] font-mono opacity-80">
                                {unitPriceSYP !== null
                                  ? `(${formatMoney(unitPriceSYP, "SYP")} ل.س)`
                                  : "(يتطلب سعر الصرف)"}
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