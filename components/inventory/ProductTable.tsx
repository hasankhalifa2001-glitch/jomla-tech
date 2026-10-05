/* eslint-disable @next/next/no-img-element */
"use client";

import { Fragment, useState, type ReactNode } from "react";
import Decimal from "decimal.js";
import {
  Layers,
  ChevronDown,
  ChevronUp,
  Package,
  Clock,
  Scale,
  Pencil,
  Trash2,
  History,
  MoreHorizontal,
  PackagePlus,
  Route,
  Power,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExpiryBadge } from "@/components/inventory/ExpiryBadge";
import { NegativeStockBadge } from "@/components/inventory/NegativeStockBadge";
import { StatusBadge } from "@/components/inventory/status-badge";
import { formatMoney } from "@/lib/utils/money";
import { batchCostDisplayLines } from "@/lib/inventory/units";

export interface BatchAdjustmentItem {
  id: string;
  // `quantityDelta` is a Decimal(18,4)-backed field — the API sends it as
  // `adj.quantityDelta.toString()`, never a native number.
  quantityDelta: string;
  reason: string;
  adjustedByUserName: string;
  createdAt: string;
}

export interface BatchItem {
  id: string;
  batchNumber: string;
  // The API sends `batch.quantity.toString()`, always a decimal string.
  quantity: string;
  unitId: string;
  unitName: string;
  /**
   * [v4.4, T4g] The batch's cost per BASE unit, in SYP, as a decimal string.
   * Only ever rendered to an ADMIN (the API strips it from a CASHIER's
   * payload — see products/route.ts's GET handler).
   */
  costPricePerBaseUnit?: string;
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
  // Sent as a decimal string by the API; formatMoney() accepts either.
  priceWholesale: number | string;
  // [v4.5] The unit's FULL barcode list — authoritative from the inventory GET
  // endpoint onwards. A unit may carry several barcodes.
  barcodes?: Array<{ id: string; barcode: string; barcodeSource?: "GS1" | "INTERNAL" | null }>;
  // [DEPRECATED — mirrored from the API's compat fields, e.g. barcodes[0].
  // Only consulted when `barcodes` is absent (an older cached response).]
  barcode?: string | null;
  barcodeSource?: "GS1" | "INTERNAL" | null;
  isActive?: boolean;
  // [v4.0] Precomputed by the backend — the ONLY reliable way to know which
  // unit is the base unit. Never infer it from conversionFactor === 1.
  isBaseUnit?: boolean;
}

export interface ProductItem {
  id: string;
  name: string;
  category: string | null;
  imageUrl?: string | null;
  isPublic: boolean;
  isActive: boolean;
  createdAt: string;
  units: UnitItem[];
  batches: BatchItem[];
  // Sent as `totalBaseStock.toString()` — a decimal string, not a number.
  totalStockInBase: string;
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
// Display helpers
// ---------------------------------------------------------------------------

/** "22.0000" -> "22", "22.5000" -> "22.5". Display only; never fed back. */
function qty(value: string): string {
  try {
    return new Decimal(value).toFixed();
  } catch {
    return value;
  }
}

function currencyLabel(currency?: "SYP" | "USD"): string {
  return currency === "USD" ? "$" : "ل.س";
}

// ---------------------------------------------------------------------------
// Shared sub-pieces. The desktop table row and the mobile card render the
// exact same product data in different containers — each piece is defined once
// so the two layouts can never quietly drift apart.
// ---------------------------------------------------------------------------

function ProductNameBlock({ product }: { product: ProductItem }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          alt={product.name}
          className="size-10 shrink-0 rounded-md border border-slate-200 object-cover"
        />
      ) : (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400">
          <Package className="size-5" aria-hidden />
        </div>
      )}

      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-bold text-slate-900">{product.name}</span>
          {!product.isActive && <StatusBadge tone="red">موقوف</StatusBadge>}
          {product.hasNegativeStockBatch && (
            <StatusBadge tone="red">
              <Scale className="size-3" aria-hidden />
              يحتاج تسوية
            </StatusBadge>
          )}
          {product.hasExpiringSoonBatch && (
            <StatusBadge tone="amber">
              <Clock className="size-3" aria-hidden />
              قريب من الانتهاء
            </StatusBadge>
          )}
          {product.hasDiscontinuedUnitStock && (
            <StatusBadge tone="amber">مخزون على وحدة متوقفة</StatusBadge>
          )}
        </div>
        {product.category && (
          <StatusBadge tone="slate" className="font-normal">
            {product.category}
          </StatusBadge>
        )}
      </div>
    </div>
  );
}

interface UnitsListProps {
  product: ProductItem;
  isAdmin: boolean;
  onToggleUnitActive?: (productId: string, unitId: string) => void;
  togglingActiveId?: string | null;
}

const MAX_VISIBLE_BARCODES = 2;

function UnitRow({
  product,
  unit,
  isAdmin,
  onToggleUnitActive,
  togglingActiveId,
}: UnitsListProps & { unit: UnitItem }) {
  // A unit can carry many barcodes (one per scent/variant). Showing them all
  // would blow up the row, so only the first two are shown with a "+N" toggle.
  const [showAllBarcodes, setShowAllBarcodes] = useState(false);

  const inactive = unit.isActive === false;

  // Sum via decimal.js — the API sends quantities as decimal STRINGS, and a
  // native `+` on strings concatenates ("0" + "24" = "024").
  //
  // [NOTE — matches backend's own v4.0 caveat] Under v4.0 ProductBatch.unitId
  // is ALWAYS the base unit, so `b.unitId === unit.id` can only match the base
  // unit itself; a non-base deactivated unit always computes 0 here. This
  // mirrors products/route.ts's own open question (T3a §4), not a bug
  // introduced in this component.
  const discontinuedStock = !inactive
    ? new Decimal(0)
    : product.batches
      .filter((b) => b.unitId === unit.id && new Decimal(b.quantity).greaterThan(0))
      .reduce((sum, b) => sum.plus(new Decimal(b.quantity)), new Decimal(0));

  const barcodeRows =
    unit.barcodes ??
    (unit.barcode
      ? [{ id: unit.barcode, barcode: unit.barcode, barcodeSource: unit.barcodeSource }]
      : []);
  const visibleBarcodes = showAllBarcodes ? barcodeRows : barcodeRows.slice(0, MAX_VISIBLE_BARCODES);
  const hiddenCount = barcodeRows.length - visibleBarcodes.length;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={cn("font-bold text-slate-800", inactive && "text-slate-400 line-through")}>
          {unit.unitName}
        </span>

        {/* [v4.0] Read purely from `unit.isBaseUnit` (precomputed server-side). */}
        {unit.isBaseUnit ? (
          <StatusBadge tone="green">أساسية</StatusBadge>
        ) : (
          // "طرد = 6 قطعة" says what the old "(معامل 6)" only implied.
          <span className="text-slate-400">
            = {String(unit.conversionFactor)} {product.baseUnitName}
          </span>
        )}

        {inactive && <StatusBadge tone="red">معطلة</StatusBadge>}
        {discontinuedStock.greaterThan(0) && (
          <StatusBadge tone="amber">مخزون على وحدة متوقفة ({discontinuedStock.toFixed()})</StatusBadge>
        )}

        <span className="font-bold tabular-nums text-emerald-600">
          {formatMoney(unit.priceWholesale, unit.pricingCurrency ?? "SYP")}{" "}
          <span className="text-[11px] font-semibold">{currencyLabel(unit.pricingCurrency)}</span>
        </span>

        {isAdmin && onToggleUnitActive && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={togglingActiveId === unit.id}
            onClick={() => onToggleUnitActive(product.id, unit.id)}
            className="ms-auto h-6 px-2 text-[11px] text-slate-500 hover:text-slate-800"
            // Deactivating the BASE unit is not blocked at the API layer today
            // (an open question flagged in products/route.ts) — this tooltip is
            // a UX-only warning, not an enforcement mechanism.
            title={
              unit.isBaseUnit && !inactive
                ? "تنبيه: هذه هي الوحدة الأساسية — تعطيلها يخفيها من كل الشاشات رغم أنها الوحدة التي تُحسب بها كل الدفعات."
                : inactive
                  ? "تفعيل هذه الوحدة"
                  : "تعطيل هذه الوحدة"
            }
          >
            {inactive ? "تفعيل" : "تعطيل"}
          </Button>
        )}
      </div>

      {barcodeRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {visibleBarcodes.map((b) => (
            <span
              key={b.id || b.barcode}
              dir="ltr"
              className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
            >
              {b.barcode}
              {b.barcodeSource && <span className="ms-1 text-slate-400">{b.barcodeSource}</span>}
            </span>
          ))}
          {barcodeRows.length > MAX_VISIBLE_BARCODES && (
            <button
              type="button"
              onClick={() => setShowAllBarcodes((v) => !v)}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50"
            >
              {showAllBarcodes ? "إخفاء" : `+${hiddenCount} باركود`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function UnitsList(props: UnitsListProps) {
  return (
    <div className="space-y-3">
      {props.product.units.map((unit) => (
        <UnitRow key={unit.id} unit={unit} {...props} />
      ))}
    </div>
  );
}

function StockValue({ product }: { product: ProductItem }) {
  if (product.isOutOfStock) {
    return <StatusBadge tone="red">نافد من المخزون</StatusBadge>;
  }
  return (
    <span className="text-sm font-extrabold text-slate-900">
      {qty(product.totalStockInBase)}{" "}
      <span className="font-semibold text-slate-500">{product.baseUnitName}</span>
    </span>
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
  const disabled = togglingPublicId === product.id || !isAdmin;
  return (
    <div className="flex items-center gap-2">
      {/* dir="ltr": the stock shadcn Switch slides its thumb to the physical
          right when checked, which is wrong inside an RTL track. Pinning the
          switch itself to LTR keeps the thumb and its track consistent. */}
      <Switch
        dir="ltr"
        checked={product.isPublic}
        disabled={disabled}
        onCheckedChange={() => handleTogglePublic(product.id)}
        aria-label={`نشر ${product.name} في المتجر`}
        title={!isAdmin ? "تعديل حالة النشر متاح لمدير المتجر فقط" : undefined}
        className="data-[state=checked]:bg-emerald-600"
      />
      <span className="text-xs text-slate-500">{product.isPublic ? "معروض للجمهور" : "مخفي"}</span>
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
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={isExpanded}
      onClick={() => toggleExpand(product.id)}
      className="h-9 gap-1.5 px-2 text-xs font-bold text-slate-700"
    >
      <Layers className="size-4 text-emerald-600" aria-hidden />
      <span>{product.batches.length} دفعة</span>
      {isExpanded ? (
        <ChevronUp className="size-3.5" aria-hidden />
      ) : (
        <ChevronDown className="size-3.5" aria-hidden />
      )}
    </Button>
  );
}

interface MenuProps {
  isAdmin: boolean;
  onEditProduct?: (product: ProductItem) => void;
  onToggleProductActive?: (productId: string) => void;
  togglingActiveId?: string | null;
  onAddBatch: (productId: string) => void;
  onFifoPreview: (productId: string) => void;
}

/**
 * Replaces four always-visible buttons per row (تعديل / تعطيل / + دفعة / FIFO)
 * with one menu — the row stays calm and the destructive action is no longer a
 * single mis-tap away. A CASHIER only gets the FIFO preview, exactly as before.
 */
function ProductActionsMenu({
  product,
  isAdmin,
  onEditProduct,
  onToggleProductActive,
  togglingActiveId,
  onAddBatch,
  onFifoPreview,
}: MenuProps & { product: ProductItem }) {
  return (
    // modal={false}: opening a Dialog from a menu item while the menu is modal
    // leaves `pointer-events: none` stuck on <body>.
    <DropdownMenu dir="rtl" modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`إجراءات ${product.name}`}
          className="size-9 text-slate-500"
        >
          <MoreHorizontal className="size-5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {isAdmin && onEditProduct && (
          <DropdownMenuItem className="gap-2" onSelect={() => onEditProduct(product)}>
            <Pencil className="size-4 text-slate-500" aria-hidden />
            تعديل المنتج والوحدات
          </DropdownMenuItem>
        )}
        {/* "إضافة دفعة" is ADMIN-only — the batch screen collects the purchase
            cost, which a CASHIER must never even see rendered. */}
        {isAdmin && (
          <DropdownMenuItem className="gap-2" onSelect={() => onAddBatch(product.id)}>
            <PackagePlus className="size-4 text-emerald-600" aria-hidden />
            إضافة دفعة
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="gap-2" onSelect={() => onFifoPreview(product.id)}>
          <Route className="size-4 text-slate-500" aria-hidden />
          معاينة FIFO
        </DropdownMenuItem>
        {isAdmin && onToggleProductActive && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={togglingActiveId === product.id}
              onSelect={() => onToggleProductActive(product.id)}
              className={cn(
                "gap-2",
                product.isActive
                  ? "text-red-600 focus:bg-red-50 focus:text-red-700"
                  : "text-emerald-700 focus:bg-emerald-50 focus:text-emerald-800"
              )}
            >
              <Power className="size-4" aria-hidden />
              {product.isActive ? "تعطيل المنتج" : "تفعيل المنتج"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

interface BatchActionProps {
  isAdmin: boolean;
  onReconcileBatch?: (product: ProductItem, batch: BatchItem) => void;
  onEditBatch?: (product: ProductItem, batch: BatchItem) => void;
  onDeleteBatch?: (product: ProductItem, batch: BatchItem) => void;
}

/** A labelled fact: small muted label above a normal-size value. */
function Stat({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <div className="text-sm text-slate-900">{children}</div>
    </div>
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
}: BatchActionProps & {
  product: ProductItem;
  batch: BatchItem;
  isLogExpanded: boolean;
  onToggleLog: () => void;
}) {
  const hasSales = (batch._count?.invoiceItems || 0) > 0;
  // [v4.3 T1/T3c corrigendum] A prior reconciliation no longer blocks deletion.
  // The API's only eligibility rule is "zero InvoiceItem references"; the
  // adjustment count below is informational and deliberately NOT part of
  // canDelete.
  const canDelete = !hasSales && isAdmin;
  const deleteDisabledReason = hasSales
    ? "لا يمكن حذف الدفعة لوجود مبيعات مسجلة عليها"
    : !isAdmin
      ? "حذف الدفعات متاح لمدير المتجر فقط"
      : undefined;

  const adjustmentsCount = batch.adjustments?.length || 0;

  // Comparisons and display go through Decimal, never a native `<`/`>`.
  const batchQuantity = new Decimal(batch.quantity);
  const isNegativeQty = batchQuantity.isNegative();

  // [v4.4, T4g] ADMIN-only. Double-guarded: the API strips this field from a
  // CASHIER's payload entirely, and this render is gated on isAdmin as well.
  const costLines =
    isAdmin && batch.costPricePerBaseUnit !== undefined
      ? batchCostDisplayLines(batch.costPricePerBaseUnit, product.units)
      : [];

  const footerButton = "h-9 gap-1.5 px-3 text-[13px]";

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header: which batch this is */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">دفعة</span>
          {/* dir="ltr": the number is date-first (2026-10-05-1). Inside an RTL
              line the bidi algorithm reorders its hyphen-separated groups and
              it reads "1-05-10-2026" — a different date. */}
          <span dir="ltr" className="font-mono text-sm font-bold text-slate-900">
            {batch.batchNumber}
          </span>
        </div>
        {adjustmentsCount > 0 && <StatusBadge tone="slate">خضعت لتسوية ({adjustmentsCount})</StatusBadge>}
      </div>

      {/* Facts: quantity and expiry side by side, cost underneath */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 py-4">
        <Stat label="الكمية الحالية">
          <p>
            <span
              className={cn(
                "text-xl font-extrabold tabular-nums",
                isNegativeQty ? "text-red-600" : "text-slate-900"
              )}
            >
              {qty(batch.quantity)}
            </span>{" "}
            <span className="text-sm text-slate-500">{batch.unitName}</span>
          </p>
          {/* The badge's `quantity` is a Number purely for DISPLAY; the
              authoritative value stays the Decimal string everywhere else. */}
          {isNegativeQty && (
            <div className="mt-2">
              <NegativeStockBadge quantity={batchQuantity.toNumber()} unitName={batch.unitName} />
            </div>
          )}
        </Stat>

        <Stat label="الصلاحية">
          <ExpiryBadge
            daysToExpiry={batch.daysToExpiry}
            expiryDate={batch.expiryDate}
            status={batch.expiryStatus}
          />
        </Stat>

        {costLines.length > 0 && (
          <Stat label="سعر الشراء لكل وحدة" className="col-span-2 rounded-lg bg-slate-50 p-3">
            <div className="space-y-1.5">
              {costLines.map((l) => (
                // One line per unit, name on one side and price on the other —
                // instead of a single "x ل.س / طرد • y ل.س / قطعة" sentence
                // whose pieces the RTL bidi algorithm scrambled.
                <div key={l.unitName} className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-600">{l.unitName}</span>
                  <span className="font-bold tabular-nums text-slate-900">
                    <bdi>{formatMoney(l.price, "SYP")}</bdi>{" "}
                    <span className="text-xs font-semibold text-slate-500">ل.س</span>
                  </span>
                </div>
              ))}
            </div>
          </Stat>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-2.5">
        {adjustmentsCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            aria-expanded={isLogExpanded}
            onClick={onToggleLog}
            className={cn(footerButton, "font-semibold text-slate-600")}
          >
            <History className="size-4" aria-hidden />
            سجل التسويات ({adjustmentsCount})
            {isLogExpanded ? (
              <ChevronUp className="size-4" aria-hidden />
            ) : (
              <ChevronDown className="size-4" aria-hidden />
            )}
          </Button>
        ) : (
          <span className="px-1 text-xs text-slate-400">لا توجد تسويات سابقة</span>
        )}

        <div className="flex items-center gap-1">
          {isAdmin && onReconcileBatch && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onReconcileBatch(product, batch)}
              title="إجراء تسوية مخزنية (Stock Reconciliation)"
              className={footerButton}
            >
              <Scale className="size-4" aria-hidden />
              تسوية
            </Button>
          )}

          {isAdmin && onEditBatch && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onEditBatch(product, batch)}
              title="تعديل رقم الدفعة وتاريخ الصلاحية"
              className={cn(footerButton, "text-slate-600")}
            >
              <Pencil className="size-4" aria-hidden />
              تعديل
            </Button>
          )}

          {isAdmin && onDeleteBatch && (
            <Button
              type="button"
              variant="ghost"
              disabled={!canDelete}
              onClick={() => canDelete && onDeleteBatch(product, batch)}
              title={deleteDisabledReason || "حذف الدفعة المدخلة بالخطأ"}
              className={cn(footerButton, "text-red-600 hover:bg-red-50 hover:text-red-700")}
            >
              <Trash2 className="size-4" aria-hidden />
              حذف
            </Button>
          )}
        </div>
      </div>

      {/* Adjustment history */}
      {isLogExpanded && batch.adjustments && batch.adjustments.length > 0 && (
        <div className="space-y-2 rounded-b-xl border-t border-slate-100 bg-slate-50 px-4 py-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
            <History className="size-4" aria-hidden />
            سجل تسويات الدفعة
          </div>
          <div className="divide-y divide-slate-200">
            {batch.adjustments.map((adj) => {
              const delta = new Decimal(adj.quantityDelta);
              const isPositive = delta.greaterThan(0);
              return (
                <div
                  key={adj.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800">{adj.reason}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      بواسطة {adj.adjustedByUserName} •{" "}
                      {new Date(adj.createdAt).toLocaleString("ar-SY", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </p>
                  </div>
                  <span
                    dir="ltr"
                    className={cn(
                      "font-mono text-sm font-extrabold",
                      isPositive ? "text-emerald-600" : "text-red-600"
                    )}
                  >
                    {isPositive ? "+" : ""}
                    {qty(adj.quantityDelta)} {batch.unitName}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function BatchesPanel({
  product,
  expandedBatchLogIds,
  onToggleBatchLog,
  ...actions
}: BatchActionProps & {
  product: ProductItem;
  expandedBatchLogIds: Set<string>;
  onToggleBatchLog: (batchId: string) => void;
}) {
  if (product.batches.length === 0) {
    return <p className="text-xs italic text-slate-400">لا توجد أي دفعات مستلمة حتى الآن.</p>;
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {product.batches.map((batch) => (
        <BatchCard
          key={batch.id}
          product={product}
          batch={batch}
          isLogExpanded={expandedBatchLogIds.has(batch.id)}
          onToggleLog={() => onToggleBatchLog(batch.id)}
          {...actions}
        />
      ))}
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

  // Loading and empty states are owned by InventoryClient (skeleton /
  // "no products" / "no matches" / error). This component only ever draws a
  // real list.
  if (products.length === 0) return null;

  const unitProps = { isAdmin, onToggleUnitActive, togglingActiveId };
  const menuProps = {
    isAdmin,
    onEditProduct,
    onToggleProductActive,
    togglingActiveId,
    onAddBatch,
    onFifoPreview,
  };
  const panelProps = {
    isAdmin,
    expandedBatchLogIds,
    onToggleBatchLog: toggleBatchLogExpand,
    onReconcileBatch,
    onEditBatch,
    onDeleteBatch,
  };

  return (
    // While a refetch is in flight the list stays on screen, dimmed — it used
    // to be replaced by a spinner box on every filter click, which made the
    // whole page jump.
    <div
      aria-busy={loading}
      className={cn("transition-opacity", loading && "pointer-events-none opacity-60")}
    >
      {/* Desktop / tablet */}
      <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="text-start">المنتج</TableHead>
              <TableHead className="text-start">الوحدات والأسعار</TableHead>
              <TableHead className="text-start">المخزون</TableHead>
              <TableHead className="text-start">النشر في المتجر</TableHead>
              <TableHead className="text-start">الدفعات</TableHead>
              <TableHead className="w-12 text-start">
                <span className="sr-only">إجراءات</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((product) => {
              const isExpanded = expandedProductIds.has(product.id);
              return (
                <Fragment key={product.id}>
                  <TableRow className={cn(isExpanded && "border-b-0")}>
                    <TableCell className="align-top">
                      <ProductNameBlock product={product} />
                    </TableCell>
                    <TableCell className="align-top">
                      <UnitsList product={product} {...unitProps} />
                    </TableCell>
                    <TableCell className="align-top">
                      <StockValue product={product} />
                    </TableCell>
                    <TableCell className="align-top">
                      <PublicToggle
                        product={product}
                        isAdmin={isAdmin}
                        togglingPublicId={togglingPublicId}
                        handleTogglePublic={handleTogglePublic}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <BatchesToggle product={product} isExpanded={isExpanded} toggleExpand={toggleExpand} />
                    </TableCell>
                    <TableCell className="align-top">
                      <ProductActionsMenu product={product} {...menuProps} />
                    </TableCell>
                  </TableRow>

                  {/* Batches open right under their product (they used to open
                      in a separate area at the bottom of the page, far from the
                      row that triggered them). */}
                  {isExpanded && (
                    <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
                      <TableCell colSpan={6} className="p-4">
                        <BatchesPanel product={product} {...panelProps} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Mobile */}
      <div className="space-y-3 md:hidden">
        {products.map((product) => {
          const isExpanded = expandedProductIds.has(product.id);
          return (
            <div
              key={product.id}
              className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <ProductNameBlock product={product} />
                <ProductActionsMenu product={product} {...menuProps} />
              </div>

              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <span className="text-xs text-slate-400">المخزون المتوفر</span>
                <StockValue product={product} />
              </div>

              <div className="space-y-2 border-t border-slate-100 pt-3">
                <span className="block text-xs text-slate-400">الوحدات والأسعار</span>
                <UnitsList product={product} {...unitProps} />
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <PublicToggle
                  product={product}
                  isAdmin={isAdmin}
                  togglingPublicId={togglingPublicId}
                  handleTogglePublic={handleTogglePublic}
                />
                <BatchesToggle product={product} isExpanded={isExpanded} toggleExpand={toggleExpand} />
              </div>

              {isExpanded && (
                <div className="rounded-lg bg-slate-50 p-3">
                  <BatchesPanel product={product} {...panelProps} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}