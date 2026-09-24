"use client";

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
import Decimal from "decimal.js";
import { ExpiryBadge } from "@/components/inventory/ExpiryBadge";
import { NegativeStockBadge } from "@/components/inventory/NegativeStockBadge";
import { formatMoney } from "@/lib/utils/money";
import s from "./inventory.module.css";

export interface BatchAdjustmentItem {
  id: string;
  // `quantityDelta` is a Decimal(18,4)-backed field — the API
  // (products/route.ts's GET) sends it as `adj.quantityDelta.toString()`,
  // never a native number.
  quantityDelta: string;
  reason: string;
  adjustedByUserName: string;
  createdAt: string;
}

export interface BatchItem {
  id: string;
  batchNumber: string;
  // Same as quantityDelta above — the API sends `batch.quantity.toString()`,
  // always a decimal string.
  quantity: string;
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
  // priceWholesale/priceRetail are sent as decimal strings by the API
  // (`u.priceWholesale.toString()`) — kept as number|string since
  // formatMoney() (lib/utils/money.ts) accepts either via its MoneyInput
  // type.
  priceWholesale: number | string;
  priceRetail?: number | string | null;
  barcode: string | null;
  barcodeSource?: "GS1" | "INTERNAL" | null;
  imageUrl?: string | null;
  isActive?: boolean;
  // [v4.0] Precomputed by the backend (base-unit.ts's
  // toSafeProductWithUnits(), threaded through products/route.ts's GET).
  // This is the ONLY reliable way to know which unit is the product's
  // base unit — never infer it from conversionFactor === 1 in this
  // component; that inference logic is exactly what the v4.0 backend
  // architecture centralizes into one sanctioned gateway instead.
  isBaseUnit?: boolean;
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
  // Sent as `totalBaseStock.toString()` by the API — a decimal string, not
  // a native number (the schema allows up to 14 integer digits, beyond
  // safe native-number precision for very large stock counts).
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
// Shared sub-pieces. The desktop <table> row and the mobile card render the
// exact same product data, just in a different container — pulling each
// piece out once means the two layouts can never quietly drift apart.
// ---------------------------------------------------------------------------

function ProductNameBlock({ product }: { product: ProductItem }) {
  return (
    <div>
      <div className={s.productName}>
        <span className={s.productNameText}>{product.name}</span>
        {!product.isActive && <span className={`${s.badge} ${s.badgeSm} ${s.badgeRed}`}>موقوف</span>}
        {product.hasDiscontinuedUnitStock && (
          <span className={`${s.badge} ${s.badgeSm} ${s.badgeAmber}`}>مخزون على وحدة متوقفة</span>
        )}
        {product.hasNegativeStockBatch && (
          <span
            className={`${s.iconFlag} ${s.iconFlagPurple}`}
            title="يوجد دفعة بمخزون سالب تحتاج تسوية"
          >
            <Package size={14} aria-hidden />
          </span>
        )}
        {product.hasExpiringSoonBatch && (
          <span className={`${s.iconFlag} ${s.iconFlagAmber}`} title="يوجد دفعة قريبة من تاريخ الانتهاء">
            <Clock size={14} aria-hidden />
          </span>
        )}
      </div>
      {product.category && <span className={s.categoryBadge}>{product.category}</span>}
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
    <div className={s.unitsList}>
      {product.units.map((unit) => {
        // Previously `sum + b.quantity` with a native `+` on `b.quantity`,
        // which the API sends as a decimal STRING (see BatchItem.quantity's
        // note above). `0 + "24"` performs STRING CONCATENATION in JS
        // ("024"), not numeric addition, once any operand is a string —
        // this silently produced a wrong "discontinued stock" figure for
        // any unit with more than one matching batch. Fixed via decimal.js,
        // consistent with this project's quantity-arithmetic convention
        // (see lib/inventory/units.ts) — never native +/- on a
        // Decimal(18,4)-backed field.
        //
        // [NOTE — matches backend's own v4.0 caveat] Under v4.0,
        // ProductBatch.unitId is ALWAYS the product's base unit, so
        // `b.unitId === unit.id` can only ever match for the base unit
        // itself — a non-base deactivated unit will always compute 0 here.
        // This mirrors products/route.ts's own flagged, unresolved open
        // question (T3a §4 under v4.0) rather than a bug introduced in
        // this component; not changed here pending that product decision.
        const discontinuedStock = !unit.isActive
          ? product.batches
            .filter((b) => b.unitId === unit.id && new Decimal(b.quantity).greaterThan(0))
            .reduce((sum, b) => sum.plus(new Decimal(b.quantity)), new Decimal(0))
          : new Decimal(0);

        return (
          <div key={unit.id} className={s.unitRow}>
            <span className={unit.isActive === false ? s.unitNameInactive : s.unitName}>
              {unit.unitName}
            </span>
            {/* [v4.0] Marks the product's designated base unit — the only
                unit ProductBatch.quantity is ever counted in, whose
                conversionFactor is permanently locked to 1 once any batch
                exists. Read purely from `unit.isBaseUnit` (precomputed
                server-side) — never inferred here from conversionFactor
                === 1. */}
            {unit.isBaseUnit && <span className={`${s.badge} ${s.badgeSm} ${s.badgeGreen}`}>أساسية</span>}
            {unit.isActive === false && <span className={`${s.badge} ${s.badgeSm} ${s.badgeRed}`}>معطلة</span>}
            {discontinuedStock.greaterThan(0) && (
              <span className={`${s.badge} ${s.badgeSm} ${s.badgeAmber}`}>
                مخزون على وحدة متوقفة ({discontinuedStock.toString()})
              </span>
            )}
            <span className={s.unitFactor}>(معامل {unit.conversionFactor})</span>
            <span className={s.unitPrice}>{formatMoney(unit.priceWholesale, unit.pricingCurrency ?? "SYP")}</span>
            {unit.priceRetail != null && (
              <span className={s.unitRetail}>
                (تجزئة: {formatMoney(unit.priceRetail, unit.pricingCurrency ?? "SYP")})
              </span>
            )}
            {unit.barcode && (
              <span className={s.unitBarcode}>
                {unit.barcode}
                {unit.barcodeSource && <span className={s.unitBarcodeSource}>({unit.barcodeSource})</span>}
              </span>
            )}
            {isAdmin && onToggleUnitActive && (
              <button
                type="button"
                onClick={() => onToggleUnitActive(product.id, unit.id)}
                disabled={togglingActiveId === unit.id}
                className={s.unitToggle}
                // Deactivating the BASE unit is not blocked at the API
                // layer today (an open, unresolved question flagged in
                // products/route.ts's GET handler) — this tooltip is a
                // UX-only warning, not an enforcement mechanism. It does
                // not disable the button, since the backend itself hasn't
                // decided this should be forbidden yet.
                title={
                  unit.isBaseUnit && unit.isActive !== false
                    ? "تنبيه: هذه هي الوحدة الأساسية — تعطيلها يخفيها من كل الشاشات رغم أنها الوحدة التي تُحسب بها كل الدفعات."
                    : unit.isActive === false
                      ? "تفعيل هذه الوحدة"
                      : "تعطيل هذه الوحدة"
                }
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
    <span className={`${s.badge} ${s.badgeRed}`}>نافذ من المخزون</span>
  ) : (
    <div className={s.stockValue}>
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
  const disabled = togglingPublicId === product.id || !isAdmin;
  return (
    <div className={s.publicToggleRow}>
      <button
        type="button"
        role="switch"
        aria-checked={product.isPublic}
        disabled={disabled}
        onClick={() => handleTogglePublic(product.id)}
        title={!isAdmin ? "تعديل حالة النشر متاح لمدير المتجر فقط" : undefined}
        className={`${s.switch} ${product.isPublic ? s.switchOn : ""}`}
      >
        <span className={s.switchKnob} />
      </button>
      <span className={s.publicLabel}>{product.isPublic ? "معروض للجمهور" : "مخفي"}</span>
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
    <button type="button" onClick={() => toggleExpand(product.id)} className={s.batchesBtn}>
      <Layers size={14} aria-hidden />
      <span>{product.batches.length} دفعة</span>
      {isExpanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
    </button>
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
        <button
          type="button"
          onClick={() => onEditProduct(product)}
          title="تعديل المنتج والوحدات"
          className={`${s.btn} ${s.btnSm} ${s.btnOutlineSlate}`}
        >
          تعديل
        </button>
      )}
      {isAdmin && onToggleProductActive && (
        <button
          type="button"
          onClick={() => onToggleProductActive(product.id)}
          disabled={togglingActiveId === product.id}
          title={product.isActive ? "تعطيل المنتج" : "تفعيل المنتج"}
          className={`${s.btn} ${s.btnSm} ${product.isActive ? s.btnGhostRed : s.btnGhostEmerald}`}
        >
          {product.isActive ? "تعطيل" : "تفعيل"}
        </button>
      )}
      <button
        type="button"
        onClick={() => onAddBatch(product.id)}
        title="إضافة دفعة لهذا المنتج"
        className={`${s.btn} ${s.btnSm} ${s.btnOutlineEmerald}`}
      >
        + دفعة
      </button>
      <button
        type="button"
        onClick={() => onFifoPreview(product.id)}
        title="اختبار FIFO"
        className={`${s.btn} ${s.btnSm} ${s.btnOutlineIndigo}`}
      >
        FIFO
      </button>
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

  // batch.quantity is the decimal string the API actually sends —
  // comparisons and display both go through Decimal, never a native
  // `<`/`>` coercion, consistent with this project's quantity-arithmetic
  // convention.
  const batchQuantity = new Decimal(batch.quantity);
  const isNegativeQty = batchQuantity.isNegative();

  return (
    <div className={s.batchCard}>
      <div className={s.batchCardHead}>
        <div>
          <div className={s.batchNumber}>
            <span>دفعة #{batch.batchNumber}</span>
            {adjustmentsCount > 0 && (
              <span className={`${s.badge} ${s.badgeSm} ${s.badgePurple}`}>خضعت لتسوية ({adjustmentsCount})</span>
            )}
          </div>
          <div className={s.batchQtyLine}>
            الكمية الحالية:{" "}
            <span className={isNegativeQty ? s.batchQtyNegative : s.batchQty}>{batch.quantity}</span>{" "}
            {batch.unitName}
          </div>
        </div>

        <div className={s.batchCardMeta}>
          <ExpiryBadge daysToExpiry={batch.daysToExpiry} expiryDate={batch.expiryDate} status={batch.expiryStatus} />
          {isNegativeQty && (
            // NegativeStockBadge's `quantity` prop is passed as a Number
            // here purely for DISPLAY purposes (this badge only ever
            // renders the sign/value visually, never feeds back into any
            // calculation). The authoritative value stays the Decimal
            // string everywhere else in this component.
            <NegativeStockBadge quantity={batchQuantity.toNumber()} unitName={batch.unitName} />
          )}
        </div>
      </div>

      <div className={s.batchCardFoot}>
        <div>
          {adjustmentsCount > 0 ? (
            <button type="button" onClick={onToggleLog} className={s.adjLogBtn}>
              <History size={12} aria-hidden />
              <span>سجل التسويات ({adjustmentsCount})</span>
              {isLogExpanded ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            </button>
          ) : (
            <span className={s.noAdjustments}>لا توجد تسويات سابقة</span>
          )}
        </div>

        <div className={s.batchFootBtns}>
          {isAdmin && onReconcileBatch && (
            <button
              type="button"
              onClick={() => onReconcileBatch(product, batch)}
              title="إجراء تسوية مخزنية (Stock Reconciliation)"
              className={`${s.btn} ${s.btnXs} ${s.chipPurple}`}
            >
              <Scale size={12} aria-hidden />
              تسوية
            </button>
          )}

          {isAdmin && onEditBatch && (
            <button
              type="button"
              onClick={() => onEditBatch(product, batch)}
              title="تعديل رقم الدفعة وتاريخ الصلاحية"
              className={`${s.btn} ${s.btnXs} ${s.btnGhost}`}
            >
              <Edit2 size={12} aria-hidden />
              تعديل
            </button>
          )}

          {isAdmin && onDeleteBatch && (
            <button
              type="button"
              onClick={() => canDelete && onDeleteBatch(product, batch)}
              disabled={!canDelete}
              title={deleteDisabledReason || "حذف الدفعة المدخلة بالخطأ"}
              className={`${s.btn} ${s.btnXs} ${canDelete ? s.btnGhostRed : s.btnDisabledLook}`}
            >
              <Trash2 size={12} aria-hidden />
              حذف
            </button>
          )}
        </div>
      </div>

      {isLogExpanded && batch.adjustments && batch.adjustments.length > 0 && (
        <div className={s.adjLog}>
          <div className={s.adjLogHead}>
            <History size={12} aria-hidden />
            <span>تفاصيل سجل تسويات الدفعة:</span>
          </div>
          <div className={s.adjLogList}>
            {batch.adjustments.map((adj) => {
              // quantityDelta is a decimal string — sign/display computed
              // via Decimal, never a native `>` coercion.
              const delta = new Decimal(adj.quantityDelta);
              const isPositive = delta.greaterThan(0);
              return (
                <div key={adj.id} className={s.adjLogItem}>
                  <div>
                    <span className={s.adjReason}>{adj.reason}</span>
                    <div className={s.adjMeta}>
                      بواسطة: {adj.adjustedByUserName} •{" "}
                      {new Date(adj.createdAt).toLocaleString("ar-SY", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </div>
                  </div>
                  <div className={`${s.adjDelta} ${isPositive ? s.adjPositive : s.adjNegative}`}>
                    {isPositive ? `+${adj.quantityDelta}` : adj.quantityDelta} {batch.unitName}
                  </div>
                </div>
              );
            })}
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
      <div className={s.stateBox}>
        <RefreshCw size={24} className={`${s.stateIcon} ${s.spin}`} aria-hidden />
        <p className={s.stateHint}>جاري تحميل قائمة المنتجات والمخزون...</p>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className={s.stateBox}>
        <Package size={40} className={s.stateIcon} aria-hidden />
        <p className={s.stateTitle}>لم يتم العثور على أي منتجات</p>
        <p className={s.stateHint}>جرب تغيير كلمات البحث أو الفلاتر المحددة.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Desktop / tablet: real table, from md up. */}
      <div className={s.tableWrap}>
        <div className={s.tableScroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>المنتج والتصنيف</th>
                <th>وحدات القياس والأسعار</th>
                <th>المخزون المتوفر</th>
                <th>النشر في المتجر</th>
                <th className="center">الدفعات (Batches)</th>
                <th className="center">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>
                    <ProductNameBlock product={product} />
                  </td>

                  <td>
                    <UnitsList
                      product={product}
                      isAdmin={isAdmin}
                      onToggleUnitActive={onToggleUnitActive}
                      togglingActiveId={togglingActiveId}
                    />
                  </td>

                  <td>
                    <StockValue product={product} />
                  </td>

                  <td>
                    <PublicToggle
                      product={product}
                      isAdmin={isAdmin}
                      togglingPublicId={togglingPublicId}
                      handleTogglePublic={handleTogglePublic}
                    />
                  </td>

                  <td className={s.center}>
                    <BatchesToggle
                      product={product}
                      isExpanded={expandedProductIds.has(product.id)}
                      toggleExpand={toggleExpand}
                    />
                  </td>

                  <td className={s.center}>
                    <div className={s.rowActions}>
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

      {/* Mobile: one card per product, below md. */}
      <div className={s.cards}>
        {products.map((product) => (
          <div key={product.id} className={s.card}>
            <ProductNameBlock product={product} />

            <div className={s.cardRow}>
              <span className={s.cardLabel}>المخزون المتوفر</span>
              <StockValue product={product} />
            </div>

            <div className={s.cardBlock}>
              <span className={s.cardLabel} style={{ display: "block", marginBottom: 6 }}>
                الوحدات والأسعار
              </span>
              <UnitsList
                product={product}
                isAdmin={isAdmin}
                onToggleUnitActive={onToggleUnitActive}
                togglingActiveId={togglingActiveId}
              />
            </div>

            <div className={s.cardRow}>
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

            <div className={s.cardActions}>
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
        <div className={s.batchPanels}>
          <h2 className={s.batchPanelsTitle}>
            <Layers size={20} aria-hidden />
            <span>تفاصيل الدفعات والصلاحيات المفتوحة</span>
          </h2>

          <div className={s.batchPanelsGrid}>
            {products
              .filter((p) => expandedProductIds.has(p.id))
              .map((product) => (
                <div key={`batch-panel-${product.id}`} className={s.batchPanel}>
                  <div className={s.batchPanelHead}>
                    <span>{product.name}</span>
                    <button
                      type="button"
                      onClick={() => toggleExpand(product.id)}
                      className={`${s.btn} ${s.btnXs} ${s.btnGhost}`}
                    >
                      إغلاق
                    </button>
                  </div>

                  {product.batches.length === 0 ? (
                    <p className={s.emptyBatches}>لا توجد أي دفعات مستلمة حتى الآن.</p>
                  ) : (
                    <div className={s.batchList}>
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