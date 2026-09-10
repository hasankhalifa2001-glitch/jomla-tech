"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Layers,
  ChevronDown,
  ChevronUp,
  Package,
  RefreshCw,
  Clock,
  Scale,
  Edit2,
  Trash2,
  History,
} from "lucide-react";
import { useState } from "react";
import { ExpiryBadge } from "@/components/inventory/ExpiryBadge";
import { NegativeStockBadge } from "@/components/inventory/NegativeStockBadge";
import { formatMoney } from "@/lib/utils/money";

export interface BatchAdjustmentItem {
  id: string;
  quantityDelta: number;
  reason: string;
  adjustedByUserName: string;
  createdAt: string;
}

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
  adjustments?: BatchAdjustmentItem[];
  _count?: {
    invoiceItems: number;
    adjustments: number;
  };
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
  isActive?: boolean;
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
  hasDiscontinuedUnitStock?: boolean;
  isOutOfStock: boolean;
}

interface ProductTableProps {
  products: ProductItem[];
  loading: boolean;
  expandedProductIds: Set<string>;
  toggleExpand: (productId: string) => void;
  handleTogglePublic: (productId: string) => void;
  togglingPublicId: string | null;
  onToggleProductActive?: (productId: string) => void;
  onToggleUnitActive?: (productId: string, unitId: string) => void;
  togglingActiveId?: string | null;
  onAddBatch: (productId: string) => void;
  onFifoPreview: (productId: string) => void;
  onEditProduct?: (product: ProductItem) => void;
  onReconcileBatch?: (product: ProductItem, batch: BatchItem) => void;
  onEditBatch?: (product: ProductItem, batch: BatchItem) => void;
  onDeleteBatch?: (product: ProductItem, batch: BatchItem) => void;
  isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Shared sub-pieces. The desktop <table> row and the mobile card render the
// exact same product data, just in a different container — pulling each
// piece out once means the two layouts can never quietly drift apart.
// ---------------------------------------------------------------------------

function ProductNameBlock({ product }: { product: ProductItem }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{product.name}</div>
        {!product.isActive && (
          <Badge
            variant="destructive"
            className="border-red-200 bg-red-100 px-1.5 py-0 text-[10px] text-red-700"
          >
            موقوف
          </Badge>
        )}
        {product.hasDiscontinuedUnitStock && (
          <Badge
            variant="outline"
            className="border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800"
          >
            مخزون على وحدة متوقفة
          </Badge>
        )}
        {product.hasNegativeStockBatch && (
          <span title="يوجد دفعة بمخزون سالب تحتاج تسوية">
            <Package className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
          </span>
        )}
        {product.hasExpiringSoonBatch && (
          <span title="يوجد دفعة قريبة من تاريخ الانتهاء">
            <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </span>
        )}
      </div>
      {product.category && (
        <Badge variant="outline" className="mt-1 border-zinc-200 text-[10px] text-zinc-500">
          {product.category}
        </Badge>
      )}
    </div>
  );
}

function UnitsList({
  product,
  isAdmin,
  onToggleUnitActive,
  togglingActiveId,
}: {
  product: ProductItem;
  isAdmin: boolean;
  onToggleUnitActive?: (productId: string, unitId: string) => void;
  togglingActiveId?: string | null;
}) {
  return (
    <div className="space-y-1.5">
      {product.units.map((unit) => {
        const discontinuedStock = !unit.isActive
          ? product.batches
            .filter((b) => b.unitId === unit.id && b.quantity > 0)
            .reduce((sum, b) => sum + b.quantity, 0)
          : 0;
        return (
          <div key={unit.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`font-medium ${unit.isActive === false ? "text-zinc-400 line-through" : "text-zinc-800 dark:text-zinc-200"
                }`}
            >
              {unit.unitName}
            </span>
            {unit.isActive === false && (
              <Badge variant="outline" className="border-red-200 bg-red-50 px-1 py-0 text-[9px] text-red-500">
                معطلة
              </Badge>
            )}
            {discontinuedStock > 0 && (
              <Badge
                variant="outline"
                className="border-amber-300 bg-amber-50 px-1 py-0 text-[9px] text-amber-700"
              >
                مخزون على وحدة متوقفة ({discontinuedStock})
              </Badge>
            )}
            <span className="text-[11px] text-zinc-400">(معامل {unit.conversionFactor})</span>
            <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
              {formatMoney(unit.priceWholesale, unit.pricingCurrency ?? "SYP")}
            </span>
            {unit.priceRetail != null && (
              <span className="text-[10px] text-zinc-400">
                (تجزئة: {formatMoney(unit.priceRetail, unit.pricingCurrency ?? "SYP")})
              </span>
            )}
            {unit.barcode && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800">
                {unit.barcode}
                {unit.barcodeSource && (
                  <span className="mr-1 font-sans text-[9px] text-zinc-400">({unit.barcodeSource})</span>
                )}
              </span>
            )}
            {isAdmin && onToggleUnitActive && (
              <button
                type="button"
                onClick={() => onToggleUnitActive(product.id, unit.id)}
                disabled={togglingActiveId === unit.id}
                className="mr-1 text-[10px] text-zinc-400 underline hover:text-zinc-700"
                title={unit.isActive === false ? "تفعيل هذه الوحدة" : "تعطيل هذه الوحدة"}
              >
                {unit.isActive === false ? "تفعيل" : "تعطيل"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StockValue({ product }: { product: ProductItem }) {
  return product.isOutOfStock ? (
    <Badge className="border-red-200 bg-red-500/15 text-red-700 dark:text-red-400">نافذ من المخزون</Badge>
  ) : (
    <div className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
      {product.totalStockInBase} {product.baseUnitName}
    </div>
  );
}

function PublicToggle({
  product,
  isAdmin,
  togglingPublicId,
  handleTogglePublic,
}: {
  product: ProductItem;
  isAdmin: boolean;
  togglingPublicId: string | null;
  handleTogglePublic: (productId: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={product.isPublic}
        disabled={togglingPublicId === product.id || !isAdmin}
        onCheckedChange={() => handleTogglePublic(product.id)}
        title={!isAdmin ? "تعديل حالة النشر متاح لمدير المتجر فقط" : undefined}
      />
      <span className="text-[11px] text-zinc-500">{product.isPublic ? "معروض للجمهور" : "مخفي"}</span>
    </div>
  );
}

function BatchesToggle({
  product,
  isExpanded,
  toggleExpand,
}: {
  product: ProductItem;
  isExpanded: boolean;
  toggleExpand: (productId: string) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => toggleExpand(product.id)}
      className="gap-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      <Layers className="h-3.5 w-3.5 text-emerald-600" />
      <span>{product.batches.length} دفعة</span>
      {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
    </Button>
  );
}

function ActionButtons({
  product,
  isAdmin,
  onEditProduct,
  onToggleProductActive,
  togglingActiveId,
  onAddBatch,
  onFifoPreview,
}: {
  product: ProductItem;
  isAdmin: boolean;
  onEditProduct?: (product: ProductItem) => void;
  onToggleProductActive?: (productId: string) => void;
  togglingActiveId?: string | null;
  onAddBatch: (productId: string) => void;
  onFifoPreview: (productId: string) => void;
}) {
  return (
    <>
      {isAdmin && onEditProduct && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onEditProduct(product)}
          title="تعديل المنتج والوحدات"
          className="h-7 border-zinc-200 px-2 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          تعديل
        </Button>
      )}
      {isAdmin && onToggleProductActive && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onToggleProductActive(product.id)}
          disabled={togglingActiveId === product.id}
          title={product.isActive ? "تعطيل المنتج" : "تفعيل المنتج"}
          className={`h-7 px-2 text-[11px] ${product.isActive
            ? "text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20"
            : "text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20"
            }`}
        >
          {product.isActive ? "تعطيل" : "تفعيل"}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => onAddBatch(product.id)}
        title="إضافة دفعة لهذا المنتج"
        className="h-7 border-emerald-200 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50"
      >
        + دفعة
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onFifoPreview(product.id)}
        title="اختبار FIFO"
        className="h-7 border-indigo-200 px-2 text-[11px] text-indigo-700 hover:bg-indigo-50"
      >
        FIFO
      </Button>
    </>
  );
}

function BatchCard({
  product,
  batch,
  isAdmin,
  isLogExpanded,
  onToggleLog,
  onReconcileBatch,
  onEditBatch,
  onDeleteBatch,
}: {
  product: ProductItem;
  batch: BatchItem;
  isAdmin: boolean;
  isLogExpanded: boolean;
  onToggleLog: () => void;
  onReconcileBatch?: (product: ProductItem, batch: BatchItem) => void;
  onEditBatch?: (product: ProductItem, batch: BatchItem) => void;
  onDeleteBatch?: (product: ProductItem, batch: BatchItem) => void;
}) {
  const hasSales = (batch._count?.invoiceItems || 0) > 0;
  const hasAdjustments = (batch._count?.adjustments || 0) > 0;
  const canDelete = !hasSales && !hasAdjustments && isAdmin;
  const deleteDisabledReason = hasSales
    ? "لا يمكن حذف الدفعة لوجود مبيعات مسجلة عليها"
    : hasAdjustments
      ? "لا يمكن حذف دفعة تم إجراء تسويات سابقة عليها"
      : !isAdmin
        ? "حذف الدفعات متاح لمدير المتجر فقط"
        : undefined;

  const adjustmentsCount = batch.adjustments?.length || 0;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <span>دفعة #{batch.batchNumber}</span>
            {adjustmentsCount > 0 && (
              <Badge
                variant="outline"
                className="border-purple-200 bg-purple-50 text-[10px] text-purple-700 dark:border-purple-900 dark:bg-purple-950/30 dark:text-purple-300"
              >
                خضعت لتسوية ({adjustmentsCount})
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-zinc-500">
            الكمية الحالية:{" "}
            <span
              className={`font-bold ${batch.quantity < 0
                ? "text-purple-700 dark:text-purple-400 font-mono"
                : "text-zinc-800 dark:text-zinc-200"
                }`}
            >
              {batch.quantity}
            </span>{" "}
            {batch.unitName}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 text-left">
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

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
        <div className="flex items-center gap-1.5">
          {adjustmentsCount > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggleLog}
              className="h-6 gap-1 px-1.5 text-[11px] text-purple-700 hover:bg-purple-50 dark:text-purple-400 dark:hover:bg-purple-950/30"
            >
              <History className="h-3 w-3" />
              <span>سجل التسويات ({adjustmentsCount})</span>
              {isLogExpanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </Button>
          ) : (
            <span className="text-[10px] text-zinc-400">لا توجد تسويات سابقة</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {onReconcileBatch && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReconcileBatch(product, batch)}
              title="إجراء تسوية مخزنية (Stock Reconciliation)"
              className="h-6 gap-1 border-purple-200 px-2 text-[10px] text-purple-700 hover:bg-purple-50 dark:border-purple-800 dark:text-purple-300 dark:hover:bg-purple-950/30"
            >
              <Scale className="h-3 w-3" />
              تسوية
            </Button>
          )}

          {isAdmin && onEditBatch && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onEditBatch(product, batch)}
              title="تعديل رقم الدفعة وتاريخ الصلاحية"
              className="h-6 gap-1 px-1.5 text-[10px] text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <Edit2 className="h-3 w-3" />
              تعديل
            </Button>
          )}

          {isAdmin && onDeleteBatch && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => canDelete && onDeleteBatch(product, batch)}
              disabled={!canDelete}
              title={deleteDisabledReason || "حذف الدفعة المدخلة بالخطأ"}
              className={`h-6 gap-1 px-1.5 text-[10px] ${canDelete
                ? "text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                : "cursor-not-allowed text-zinc-300 dark:text-zinc-600"
                }`}
            >
              <Trash2 className="h-3 w-3" />
              حذف
            </Button>
          )}
        </div>
      </div>

      {isLogExpanded && batch.adjustments && batch.adjustments.length > 0 && (
        <div className="rounded-md border border-purple-100 bg-purple-50/40 p-2 text-[11px] dark:border-purple-900/60 dark:bg-purple-950/20 space-y-1.5 animate-in fade-in-50">
          <div className="font-semibold text-purple-900 dark:text-purple-200 flex items-center gap-1">
            <History className="h-3 w-3 text-purple-600" />
            <span>تفاصيل سجل تسويات الدفعة:</span>
          </div>
          <div className="space-y-1 divide-y divide-purple-100/60 dark:divide-purple-900/40">
            {batch.adjustments.map((adj) => (
              <div
                key={adj.id}
                className="flex flex-wrap items-center justify-between gap-2 pt-1.5 first:pt-0"
              >
                <div>
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">
                    {adj.reason}
                  </span>
                  <div className="text-[10px] text-zinc-400">
                    بواسطة: {adj.adjustedByUserName} •{" "}
                    {new Date(adj.createdAt).toLocaleString("ar-SY", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </div>
                </div>
                <div
                  className={`font-mono font-bold ${adj.quantityDelta > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                    }`}
                >
                  {adj.quantityDelta > 0 ? `+${adj.quantityDelta}` : adj.quantityDelta}{" "}
                  {batch.unitName}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ProductTable({
  products,
  loading,
  expandedProductIds,
  toggleExpand,
  handleTogglePublic,
  togglingPublicId,
  onToggleProductActive,
  onToggleUnitActive,
  togglingActiveId,
  onAddBatch,
  onFifoPreview,
  onEditProduct,
  onReconcileBatch,
  onEditBatch,
  onDeleteBatch,
  isAdmin,
}: ProductTableProps) {
  const [expandedBatchLogIds, setExpandedBatchLogIds] = useState<Set<string>>(new Set());

  const toggleBatchLogExpand = (batchId: string) => {
    setExpandedBatchLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="space-y-2 rounded-xl border border-zinc-200 bg-white p-12 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
        <RefreshCw className="mx-auto h-6 w-6 animate-spin text-emerald-600" />
        <p className="text-xs">جاري تحميل قائمة المنتجات والمخزون...</p>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-12 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
        <Package className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-700" />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">لم يتم العثور على أي منتجات</p>
        <p className="text-xs text-zinc-400">جرب تغيير كلمات البحث أو الفلاتر المحددة.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Desktop / tablet: real table, from md up. A wide multi-column
          table squeezed onto a phone either truncates unreadably or forces
          sideways scrolling on top of the page's own scroll — neither is
          usable, so phones get the card list below instead. */}
      <div className="hidden overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="border-b border-zinc-200 bg-zinc-50 font-medium text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/60">
              <tr>
                <th className="px-4 py-3">المنتج والتصنيف</th>
                <th className="px-4 py-3">وحدات القياس والأسعار</th>
                <th className="px-4 py-3">المخزون المتوفر</th>
                <th className="px-4 py-3">النشر في المتجر</th>
                <th className="px-4 py-3 text-center">الدفعات (Batches)</th>
                <th className="px-4 py-3 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr
                  key={product.id}
                  className="transition-colors hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30"
                >
                  <td className="px-4 py-3.5 align-top">
                    <ProductNameBlock product={product} />
                  </td>

                  <td className="px-4 py-3.5 align-top">
                    <UnitsList
                      product={product}
                      isAdmin={isAdmin}
                      onToggleUnitActive={onToggleUnitActive}
                      togglingActiveId={togglingActiveId}
                    />
                  </td>

                  <td className="px-4 py-3.5 align-top">
                    <StockValue product={product} />
                  </td>

                  <td className="px-4 py-3.5 align-top">
                    <PublicToggle
                      product={product}
                      isAdmin={isAdmin}
                      togglingPublicId={togglingPublicId}
                      handleTogglePublic={handleTogglePublic}
                    />
                  </td>

                  <td className="px-4 py-3.5 text-center align-top">
                    <BatchesToggle
                      product={product}
                      isExpanded={expandedProductIds.has(product.id)}
                      toggleExpand={toggleExpand}
                    />
                  </td>

                  <td className="px-4 py-3.5 text-center align-top">
                    <div className="flex items-center justify-center gap-1">
                      <ActionButtons
                        product={product}
                        isAdmin={isAdmin}
                        onEditProduct={onEditProduct}
                        onToggleProductActive={onToggleProductActive}
                        togglingActiveId={togglingActiveId}
                        onAddBatch={onAddBatch}
                        onFifoPreview={onFifoPreview}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile: one card per product, below md. Same data and the same
          shared sub-components as the table above — just stacked instead
          of laid out in columns. */}
      <div className="space-y-3 md:hidden">
        {products.map((product) => (
          <div
            key={product.id}
            className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <ProductNameBlock product={product} />

            <div className="flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800/60">
              <span className="text-[11px] text-zinc-400">المخزون المتوفر</span>
              <StockValue product={product} />
            </div>

            <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800/60">
              <span className="mb-1.5 block text-[11px] text-zinc-400">الوحدات والأسعار</span>
              <UnitsList
                product={product}
                isAdmin={isAdmin}
                onToggleUnitActive={onToggleUnitActive}
                togglingActiveId={togglingActiveId}
              />
            </div>

            <div className="flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800/60">
              <PublicToggle
                product={product}
                isAdmin={isAdmin}
                togglingPublicId={togglingPublicId}
                handleTogglePublic={handleTogglePublic}
              />
              <BatchesToggle
                product={product}
                isExpanded={expandedProductIds.has(product.id)}
                toggleExpand={toggleExpand}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800/60">
              <ActionButtons
                product={product}
                isAdmin={isAdmin}
                onEditProduct={onEditProduct}
                onToggleProductActive={onToggleProductActive}
                togglingActiveId={togglingActiveId}
                onAddBatch={onAddBatch}
                onFifoPreview={onFifoPreview}
              />
            </div>
          </div>
        ))}
      </div>

      {products.some((p) => expandedProductIds.has(p.id)) && (
        <div className="space-y-4 pt-2">
          <h2 className="flex items-center gap-2 text-base font-bold text-zinc-900 dark:text-zinc-100">
            <Layers className="h-5 w-5 text-emerald-600" />
            <span>تفاصيل الدفعات والصلاحيات المفتوحة</span>
          </h2>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {products
              .filter((p) => expandedProductIds.has(p.id))
              .map((product) => (
                <div
                  key={`batch-panel-${product.id}`}
                  className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/60"
                >
                  <div className="flex items-center justify-between border-b border-zinc-200 pb-2 dark:border-zinc-800">
                    <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{product.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleExpand(product.id)}
                      className="h-6 px-2 text-xs text-zinc-400"
                    >
                      إغلاق
                    </Button>
                  </div>

                  {product.batches.length === 0 ? (
                    <p className="text-xs italic text-zinc-400">لا توجد أي دفعات مستلمة حتى الآن.</p>
                  ) : (
                    <div className="space-y-2">
                      {product.batches.map((batch) => (
                        <BatchCard
                          key={batch.id}
                          product={product}
                          batch={batch}
                          isAdmin={isAdmin}
                          isLogExpanded={expandedBatchLogIds.has(batch.id)}
                          onToggleLog={() => toggleBatchLogExpand(batch.id)}
                          onReconcileBatch={onReconcileBatch}
                          onEditBatch={onEditBatch}
                          onDeleteBatch={onDeleteBatch}
                        />
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