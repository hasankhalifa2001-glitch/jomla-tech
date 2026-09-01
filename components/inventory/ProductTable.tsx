"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Layers, ChevronDown, ChevronUp, Package, RefreshCw, Clock } from "lucide-react";
import { ExpiryBadge } from "@/components/inventory/ExpiryBadge";
import { NegativeStockBadge } from "@/components/inventory/NegativeStockBadge";
import { formatMoney } from "@/lib/utils/money";

export interface BatchItem {
  id: string;
  batchNumber: string;
  quantity: number;
  unitId: string;
  unitName: string;
  expiryDate: string | null;
  daysToExpiry: number | null;
  expiryStatus: "RED" | "YELLOW" | "NORMAL";
  isNegative?: boolean;
}

export interface UnitItem {
  id: string;
  unitName: string;
  conversionFactor: number;
  pricingCurrency?: "SYP" | "USD";
  priceWholesale: number;
  priceRetail?: number | null;
  barcode: string | null;
  barcodeSource?: "GS1" | "INTERNAL" | null;
  imageUrl?: string | null;
}

export interface ProductItem {
  id: string;
  name: string;
  category: string | null;
  isPublic: boolean;
  isActive: boolean;
  createdAt: string;
  units: UnitItem[];
  batches: BatchItem[];
  totalStockInBase: number;
  baseUnitName: string;
  hasExpiringSoonBatch: boolean;
  hasNegativeStockBatch?: boolean;
  isOutOfStock: boolean;
}

interface ProductTableProps {
  products: ProductItem[];
  loading: boolean;
  expandedProductIds: Set<string>;
  toggleExpand: (productId: string) => void;
  handleTogglePublic: (productId: string) => void;
  togglingPublicId: string | null;
  onAddBatch: (productId: string) => void;
  onFifoPreview: (productId: string) => void;
  isAdmin: boolean;
}

export function ProductTable({
  products,
  loading,
  expandedProductIds,
  toggleExpand,
  handleTogglePublic,
  togglingPublicId,
  onAddBatch,
  onFifoPreview,
  isAdmin,
}: ProductTableProps) {
  if (loading) {
    return (
      <div className="p-12 text-center text-zinc-500 space-y-2 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-600" />
        <p className="text-xs">جاري تحميل قائمة المنتجات والمخزون...</p>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="p-12 text-center text-zinc-500 space-y-3 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900">
        <Package className="w-10 h-10 mx-auto text-zinc-300 dark:text-zinc-700" />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">لم يتم العثور على أي منتجات</p>
        <p className="text-xs text-zinc-400">جرب تغيير كلمات البحث أو الفلاتر المحددة.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden bg-white dark:bg-zinc-900 shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 font-medium">
              <tr>
                <th className="py-3 px-4">المنتج والتصنيف</th>
                <th className="py-3 px-4">وحدات القياس والأسعار</th>
                <th className="py-3 px-4">المخزون المتوفر</th>
                <th className="py-3 px-4">النشر في المتجر</th>
                <th className="py-3 px-4 text-center">الدفعات (Batches)</th>
                <th className="py-3 px-4 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const isExpanded = expandedProductIds.has(product.id);
                return (
                  <tr key={product.id} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors">
                    <td className="py-3.5 px-4 align-top">
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-zinc-900 dark:text-zinc-100 text-sm">
                          {product.name}
                        </div>
                        {product.hasNegativeStockBatch && (
                          <span title="يوجد دفعة بمخزون سالب تحتاج تسوية">
                            <Package className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                          </span>
                        )}
                        {/* [FIX] `hasExpiringSoonBatch` was declared on the
                            interface (and clearly returned by the API) but
                            never rendered anywhere in this component — a
                            merchant had no row-level way to know a product
                            has a batch nearing expiry without expanding
                            every single row, unlike `hasNegativeStockBatch`
                            right above, which already gets exactly this
                            kind of heads-up. Amber to match the "قريب من
                            الانتهاء" filter tab and ExpiryBadge's own
                            YELLOW/RED palette. */}
                        {product.hasExpiringSoonBatch && (
                          <span title="يوجد دفعة قريبة من تاريخ الانتهاء">
                            <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                          </span>
                        )}
                      </div>
                      {product.category && (
                        <Badge variant="outline" className="mt-1 text-[10px] text-zinc-500 border-zinc-200">
                          {product.category}
                        </Badge>
                      )}
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      <div className="space-y-1">
                        {product.units.map((unit) => (
                          <div key={unit.id} className="flex items-center gap-2 text-xs">
                            <span className="font-medium text-zinc-800 dark:text-zinc-200">{unit.unitName}</span>
                            <span className="text-zinc-400 text-[11px]">(معامل {unit.conversionFactor})</span>
                            <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">
                              {formatMoney(unit.priceWholesale, unit.pricingCurrency ?? "SYP")}
                            </span>
                            {unit.priceRetail != null && (
                              <span className="text-[10px] text-zinc-400">
                                (تجزئة: {formatMoney(unit.priceRetail, unit.pricingCurrency ?? "SYP")})
                              </span>
                            )}
                            {unit.barcode && (
                              <span className="font-mono text-[10px] bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-500">
                                {unit.barcode}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      {product.isOutOfStock ? (
                        <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 border-red-200">
                          نافذ من المخزون
                        </Badge>
                      ) : (
                        <div className="font-bold text-zinc-900 dark:text-zinc-100 text-sm">
                          {product.totalStockInBase} {product.baseUnitName}
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 px-4 align-top">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={product.isPublic}
                          disabled={togglingPublicId === product.id || !isAdmin}
                          onCheckedChange={() => handleTogglePublic(product.id)}
                          title={!isAdmin ? "تعديل حالة النشر متاح لمدير المتجر فقط" : undefined}
                        />
                        <span className="text-[11px] text-zinc-500">
                          {product.isPublic ? "معروض للجمهور" : "مخفي"}
                        </span>
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleExpand(product.id)}
                        className="text-xs gap-1 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <Layers className="w-3.5 h-3.5 text-emerald-600" />
                        <span>{product.batches.length} دفعة</span>
                        {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </Button>
                    </td>

                    <td className="py-3.5 px-4 align-top text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onAddBatch(product.id)}
                          title="إضافة دفعة لهذا المنتج"
                          className="h-7 text-[11px] px-2 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                        >
                          + دفعة
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onFifoPreview(product.id)}
                          title="اختبار FIFO"
                          className="h-7 text-[11px] px-2 text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                        >
                          FIFO
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {products.some((p) => expandedProductIds.has(p.id)) && (
        <div className="space-y-4 pt-2">
          <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Layers className="w-5 h-5 text-emerald-600" />
            <span>تفاصيل الدفعات والصلاحيات المفتوحة</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {products
              .filter((p) => expandedProductIds.has(p.id))
              .map((product) => (
                <div
                  key={`batch-panel-${product.id}`}
                  className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/60 space-y-3"
                >
                  <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                    <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">{product.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleExpand(product.id)}
                      className="text-xs text-zinc-400 h-6 px-2"
                    >
                      إغلاق
                    </Button>
                  </div>

                  {product.batches.length === 0 ? (
                    <p className="text-xs text-zinc-400 italic">لا توجد أي دفعات مستلمة حتى الآن.</p>
                  ) : (
                    <div className="space-y-2">
                      {product.batches.map((batch) => (
                        <div
                          key={batch.id}
                          className="p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3 text-xs"
                        >
                          <div>
                            <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                              دفعة #{batch.batchNumber}
                            </div>
                            <div className="text-zinc-500 mt-0.5">
                              الكمية: <span className="font-bold text-zinc-800 dark:text-zinc-200">{batch.quantity}</span> {batch.unitName}
                            </div>
                          </div>

                          <div className="text-left flex flex-col items-end gap-1">
                            <ExpiryBadge
                              daysToExpiry={batch.daysToExpiry}
                              expiryDate={batch.expiryDate}
                              status={batch.expiryStatus}
                            />
                            {batch.quantity < 0 && (
                              <NegativeStockBadge quantity={batch.quantity} unitName={batch.unitName} />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}