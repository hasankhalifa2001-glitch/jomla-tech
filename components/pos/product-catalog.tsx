"use client";

import { useState, useRef, useEffect } from "react";
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
  Layers,
} from "lucide-react";
import type { PosProductItem, CachedProductUnit } from "@/lib/offline";

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

      // Check if there is an exact barcode match
      for (const prod of products) {
        const matchingUnit = prod.units?.find(
          (u) => u.barcode && u.barcode.toLowerCase() === clean
        );
        if (matchingUnit) {
          onAddToCart(prod, matchingUnit);
          onSearchChange("");
          return;
        }
      }

      // If only 1 product matches in the current filtered list, add its default unit
      if (products.length === 1 && products[0].units && products[0].units.length > 0) {
        onAddToCart(products[0], products[0].units[0]);
        onSearchChange("");
      }
    }
  }

  return (
    <div className="flex flex-col h-full space-y-3">
      {/* Search and Filter Top Bar */}
      <div className="flex items-center gap-2">
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
            className="text-xs h-10 px-3 text-zinc-500 hover:text-zinc-800"
          >
            مسح
          </Button>
        )}
      </div>

      {/* Products Grid / View Area */}
      <div className="flex-1 overflow-y-auto pr-1">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-64 space-y-2 text-zinc-400">
            <RefreshCw className="h-6 w-6 animate-spin text-emerald-600" />
            <span className="text-xs font-medium">جاري قراءة الأصناف من الذاكرة المحلية (Dexie)...</span>
          </div>
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-72 rounded-2xl border-2 border-dashed border-zinc-200 dark:border-zinc-800 p-6 text-center space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-400">
              <Package className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-bold text-zinc-700 dark:text-zinc-300">
                {searchQuery ? "لم يتم العثور على أصناف تطابق بحثك" : "قاعدة الأصناف المحلية فارغة"}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {products.map((product) => {
              const defaultUnit = product.units?.[0];
              const priceUSD = Number(defaultUnit?.priceUSD ?? defaultUnit?.priceWholesale ?? product.priceUSD ?? product.priceWholesale ?? 0);
              const convertedSYP = exchangeRate ? priceUSD * exchangeRate : null;

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
                          المخزون: {product.totalCachedStock}
                        </Badge>
                      </div>

                      {/* Primary Price Indicator */}
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400">
                          ${priceUSD.toFixed(2)}
                        </span>
                        {convertedSYP !== null && (
                          <span className="text-[11px] font-semibold text-purple-600 dark:text-purple-400">
                            ≈ {Math.round(convertedSYP).toLocaleString("ar-SY")} ل.س
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
                        {product.units?.map((unit) => (
                          <button
                            key={unit.id}
                            type="button"
                            onClick={() => onAddToCart(product, unit)}
                            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-right text-[11px] font-medium text-zinc-700 hover:border-emerald-600 hover:bg-emerald-50 hover:text-emerald-800 transition-all dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-emerald-950/60 dark:hover:text-emerald-300"
                          >
                            <Plus className="h-3 w-3 text-emerald-600" />
                            <span className="font-semibold">{unit.unitName}</span>
                            <span className="text-[10px] text-zinc-500 font-mono">
                              (${Number(unit.priceUSD ?? unit.priceWholesale ?? 0).toFixed(2)})
                            </span>
                          </button>
                        ))}
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
