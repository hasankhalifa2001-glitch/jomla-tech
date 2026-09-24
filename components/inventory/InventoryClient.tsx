/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import {
  Package,
  Plus,
  FileUp,
  Route,
  Search,
  Globe,
  Layers,
  AlertCircle,
  Camera,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AddProductModal } from "@/components/inventory/AddProductModal";
import { EditProductModal } from "@/components/inventory/EditProductModal";
import { AddBatchModal } from "@/components/inventory/AddBatchModal";
import { CsvImportModal } from "@/components/inventory/CsvImportModal";
import { FifoPreviewModal } from "@/components/inventory/FifoPreviewModal";
import { ReconcileBatchModal } from "@/components/inventory/ReconcileBatchModal";
import { DeleteBatchModal } from "@/components/inventory/DeleteBatchModal";
import { EditBatchModal } from "@/components/inventory/EditBatchModal";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ProductTable, ProductItem, BatchItem } from "@/components/inventory/ProductTable";
import s from "./inventory.module.css";

// Added "needs_reconciliation" — the backend (/api/inventory/products GET)
// already supports this filter value (see route.ts's
// `hasNegativeStockBatch` branch), but no UI tab ever sent it. T3's
// acceptance criterion ("Any batch with quantity < 0 shows the
// negative-stock badge and appears under the 'يحتاج تسوية' filter tab")
// was therefore only half-met. Standardized on "needs_reconciliation"
// only — the backend's "reconcile" alias is redundant and dropped there
// too, so there is exactly one accepted value for this filter going
// forward.
type FilterTab =
  | "all"
  | "public"
  | "expiring"
  | "out_of_stock"
  | "needs_reconciliation"
  | "discontinued_unit_stock"
  | "inactive_products";

// Filter-tab config, deduped into one table instead of seven near-identical
// JSX blocks. Each tab only differs by value/label/icon/color — adding or
// re-theming a tab is now a one-line change instead of a copy-paste risk.
type FilterTabConfig = {
  value: Exclude<FilterTab, "all">;
  label: string;
  icon: LucideIcon;
  activeClass: string;
  inactiveClass: string;
};

const FILTER_TABS: FilterTabConfig[] = [
  { value: "public", label: "منشور بالمتجر", icon: Globe, activeClass: s.chipBlueActive, inactiveClass: s.chipBlue },
  {
    value: "expiring",
    label: "قريب من الانتهاء",
    icon: AlertCircle,
    activeClass: s.chipAmberActive,
    inactiveClass: s.chipAmber,
  },
  {
    // New tab — was entirely missing. Color aligned with
    // NegativeStockBadge (purple), which is the badge this filter's
    // results are meant to correspond to at the row/batch level.
    value: "needs_reconciliation",
    label: "يحتاج تسوية",
    icon: AlertCircle,
    activeClass: s.chipPurpleActive,
    inactiveClass: s.chipPurple,
  },
  {
    value: "out_of_stock",
    label: "نافذ من المخزون",
    icon: Package,
    activeClass: s.chipRedActive,
    inactiveClass: s.chipRed,
  },
  {
    value: "discontinued_unit_stock",
    label: "مخزون على وحدة متوقفة",
    icon: AlertCircle,
    activeClass: s.chipAmberActive,
    inactiveClass: s.chipAmber,
  },
  {
    value: "inactive_products",
    label: "منتجات معطلة",
    icon: Package,
    activeClass: s.chipSlateActive,
    inactiveClass: s.chipSlate,
  },
];

export function InventoryClient() {
  // "New product" and "CSV import" are ADMIN-only server-side (see
  // products/route.ts POST and import/commit/route.ts) — hiding them from
  // a CASHIER session here is a UX courtesy on top of that, not the real
  // security boundary. "Add batch" and "FIFO preview" stay visible to both
  // roles, matching batches/route.ts and fifo-preview/route.ts, which
  // impose no role restriction.
  const { data: session } = useSessionWithOfflineFallback();
  const isAdmin = session?.role === "ADMIN";

  const [products, setProducts] = useState<ProductItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [expandedProductIds, setExpandedProductIds] = useState<Set<string>>(new Set());
  const [togglingPublicId, setTogglingPublicId] = useState<string | null>(null);
  const [togglingActiveId, setTogglingActiveId] = useState<string | null>(null);

  const [addProductOpen, setAddProductOpen] = useState(false);
  const [editProductOpen, setEditProductOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null);
  const [addBatchOpen, setAddBatchOpen] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [fifoPreviewOpen, setFifoPreviewOpen] = useState(false);
  const [preselectedProductId, setPreselectedProductId] = useState<string | undefined>(undefined);

  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileBatch, setReconcileBatch] = useState<BatchItem | null>(null);
  const [reconcileProductName, setReconcileProductName] = useState<string>("");

  const [editBatchOpen, setEditBatchOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<BatchItem | null>(null);
  const [editingBatchProductName, setEditingBatchProductName] = useState<string>("");

  const [deleteBatchOpen, setDeleteBatchOpen] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState<BatchItem | null>(null);
  const [deletingBatchProductName, setDeletingBatchProductName] = useState<string>("");

  const [barcodeScannerOpen, setBarcodeScannerOpen] = useState(false);

  const handleToggleProductActive = async (productId: string) => {
    setTogglingActiveId(productId);
    try {
      const res = await fetch(`/api/inventory/products/${productId}/toggle-active`, {
        method: "PATCH",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "فشل تعديل حالة تفعيل المنتج.");
      }
      toast.success(data.message);
      await fetchProducts(); // بدل الـ optimistic patch
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء تعديل حالة المنتج.");
    } finally {
      setTogglingActiveId(null);
    }
  };

  const handleToggleUnitActive = async (productId: string, unitId: string) => {
    setTogglingActiveId(unitId);
    try {
      const res = await fetch(`/api/inventory/products/${productId}/units/${unitId}/toggle-active`, {
        method: "PATCH",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "فشل تعديل حالة الوحدة.");
      }
      toast.success(data.message);
      await fetchProducts(); // بدل الـ optimistic patch
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء تعديل حالة الوحدة.");
    } finally {
      setTogglingActiveId(null);
    }
  };

  // Cancels any in-flight request before starting a new one. Without this,
  // a slow debounced search response landing after a fast filter-tab
  // response (or vice versa) could overwrite the screen with stale,
  // filter-mismatched results — a real (if rare) race, not just a style
  // nitpick, since the two triggers now fire on different timers (see the
  // debounce fix below).
  const abortRef = useRef<AbortController | null>(null);

  const fetchProducts = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      if (activeFilter !== "all") params.set("filter", activeFilter);

      const res = await fetch(`/api/inventory/products?${params.toString()}`, {
        signal: controller.signal,
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "حدث خطأ أثناء جلب المنتجات.");
      }

      setProducts(data.products || []);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      toast.error(err.message || "فشل تحميل قائمة المنتجات.");
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  }, [searchQuery, activeFilter]);

  // The previous version decided the delay by checking whether
  // `searchQuery` is CURRENTLY non-empty (`searchQuery ? 300 : 0`) — not
  // whether searchQuery is what actually changed on this render. That
  // meant clicking a filter tab while text was already typed in the search
  // box still took the 300ms path, because the box wasn't empty at the
  // time, even though nothing about the search text changed. A `useRef`
  // snapshot of the previous value lets us compare old vs. new and debounce
  // only an actual search-text change; a filter click alone always fetches
  // immediately, regardless of what's sitting in the search box.
  const prevSearchQueryRef = useRef(searchQuery);

  useEffect(() => {
    const searchQueryChanged = prevSearchQueryRef.current !== searchQuery;
    prevSearchQueryRef.current = searchQuery;

    const timer = setTimeout(
      () => {
        fetchProducts();
      },
      searchQueryChanged ? 300 : 0
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchProducts]);

  const toggleExpand = (productId: string) => {
    setExpandedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  };

  const handleTogglePublic = async (productId: string) => {
    setTogglingPublicId(productId);
    try {
      const res = await fetch(`/api/inventory/products/${productId}/toggle-public`, {
        method: "PATCH",
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "فشل تعديل حالة النشر.");
      }

      toast.success(data.message);
      setProducts((prev) => prev.map((p) => (p.id === productId ? { ...p, isPublic: data.isPublic } : p)));
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء تعديل حالة المتجر.");
    } finally {
      setTogglingPublicId(null);
    }
  };

  const handleOpenAddBatch = (productId?: string) => {
    setPreselectedProductId(productId);
    setAddBatchOpen(true);
  };

  const handleOpenFifoPreview = (productId?: string) => {
    setPreselectedProductId(productId);
    setFifoPreviewOpen(true);
  };

  const handleEditProduct = (product: ProductItem) => {
    setEditingProduct(product);
    setEditProductOpen(true);
  };

  const handleReconcileBatch = (product: ProductItem, batch: BatchItem) => {
    setReconcileBatch(batch);
    setReconcileProductName(product.name);
    setReconcileOpen(true);
  };

  const handleEditBatch = (product: ProductItem, batch: BatchItem) => {
    setEditingBatch(batch);
    setEditingBatchProductName(product.name);
    setEditBatchOpen(true);
  };

  const handleDeleteBatch = (product: ProductItem, batch: BatchItem) => {
    setDeletingBatch(batch);
    setDeletingBatchProductName(product.name);
    setDeleteBatchOpen(true);
  };

  const handleBarcodeScanned = (barcode: string) => {
    setSearchQuery(barcode);
    setBarcodeScannerOpen(false);
    toast.success(`تم مسح الباركود: ${barcode}`);
  };

  return (
    <div className={s.root} dir="rtl">
      {/* Action Bar Header */}
      <div className={s.header}>
        <div>
          <h1 className={s.title}>
            <Package size={24} className={s.titleIcon} aria-hidden />
            <span>إدارة المخزون والدفعات</span>
          </h1>
          <p className={s.subtitle}>
            إدارة أصلية للمنتجات متعددة الوحدات والتنبيه المباشر للصلاحية مع استيراد CSV والمعاينة الحية لـ FIFO.
          </p>
        </div>

        {/* 2-column grid on mobile for full-width, equal-size tap targets;
            reverts to an inline wrapping row from `sm` up where width isn't
            a constraint. */}
        <div className={s.actions}>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setAddProductOpen(true)}
              className={`${s.btn} ${s.btnFull} ${s.btnSolidEmerald}`}
            >
              <Plus size={16} aria-hidden />
              <span>منتج جديد</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => handleOpenAddBatch()}
            className={`${s.btn} ${s.btnFull} ${s.btnOutlineEmerald}`}
          >
            <Layers size={16} aria-hidden />
            <span>دفعة جديدة</span>
          </button>

          {isAdmin && (
            <button
              type="button"
              onClick={() => setCsvImportOpen(true)}
              className={`${s.btn} ${s.btnFull} ${s.btnOutlineBlue}`}
            >
              <FileUp size={16} aria-hidden />
              <span>استيراد CSV</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => handleOpenFifoPreview()}
            className={`${s.btn} ${s.btnFull} ${s.btnOutlineIndigo}`}
          >
            <Route size={16} aria-hidden />
            <span>معاينة FIFO</span>
          </button>
        </div>
      </div>

      {/* Search Bar & Filter Tabs */}
      <div className={s.toolsRow}>
        <div className={s.searchWrap}>
          <div className={s.searchField}>
            <Search size={16} className={s.searchIcon} aria-hidden />
            <input
              type="text"
              placeholder="ابحث بالاسم أو الباركود..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={s.searchInput}
            />
          </div>
          <button
            type="button"
            onClick={() => setBarcodeScannerOpen(true)}
            title="مسح الباركود بالكاميرا"
            className={`${s.btn} ${s.btnSm} ${s.btnOutlineSlate} ${s.scanBtn}`}
          >
            <Camera size={16} aria-hidden />
            <span className={s.onlyDesktop}>مسح باركود</span>
          </button>
        </div>

        {/* flex-wrap instead of a horizontal scroller: on a narrow phone
            the chips fall onto a second/third line instead of hiding
            behind an unlabeled scroll area, so every filter stays
            discoverable. */}
        <div className={s.filters}>
          <button
            type="button"
            onClick={() => setActiveFilter("all")}
            className={`${s.chip} ${activeFilter === "all" ? s.chipAllActive : ""}`}
          >
            الكل
          </button>

          {FILTER_TABS.map(({ value, label, icon: Icon, activeClass, inactiveClass }) => (
            <button
              key={value}
              type="button"
              onClick={() => setActiveFilter(value)}
              className={`${s.chip} ${activeFilter === value ? activeClass : inactiveClass}`}
            >
              <Icon size={14} aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Main Table Component */}
      <ProductTable
        products={products}
        loading={loading}
        expandedProductIds={expandedProductIds}
        toggleExpand={toggleExpand}
        handleTogglePublic={handleTogglePublic}
        togglingPublicId={togglingPublicId}
        onToggleProductActive={handleToggleProductActive}
        onToggleUnitActive={handleToggleUnitActive}
        togglingActiveId={togglingActiveId}
        onAddBatch={handleOpenAddBatch}
        onFifoPreview={handleOpenFifoPreview}
        onEditProduct={handleEditProduct}
        onReconcileBatch={handleReconcileBatch}
        onEditBatch={handleEditBatch}
        onDeleteBatch={handleDeleteBatch}
        isAdmin={isAdmin}
      />

      {/* Modals */}
      {isAdmin && (
        <>
          <AddProductModal open={addProductOpen} onOpenChange={setAddProductOpen} onSuccess={fetchProducts} />
          <EditProductModal
            open={editProductOpen}
            onOpenChange={setEditProductOpen}
            product={editingProduct}
            onSuccess={fetchProducts}
          />
        </>
      )}

      <AddBatchModal
        open={addBatchOpen}
        onOpenChange={setAddBatchOpen}
        products={products}
        preselectedProductId={preselectedProductId}
        onSuccess={fetchProducts}
      />

      {isAdmin && (
        <>
          <CsvImportModal open={csvImportOpen} onOpenChange={setCsvImportOpen} onSuccess={fetchProducts} />
          <EditBatchModal
            open={editBatchOpen}
            onOpenChange={setEditBatchOpen}
            batch={editingBatch}
            productName={editingBatchProductName}
            onSuccess={fetchProducts}
          />
          <DeleteBatchModal
            open={deleteBatchOpen}
            onOpenChange={setDeleteBatchOpen}
            batch={deletingBatch}
            productName={deletingBatchProductName}
            onSuccess={fetchProducts}
          />
        </>
      )}

      {/* Wrapped in `isAdmin`, matching every other ADMIN-only action modal
          in this file (AddProductModal, EditProductModal, CsvImportModal,
          EditBatchModal, DeleteBatchModal). Stock reconciliation is
          ADMIN-only per T2b's Role Capability Matrix — this modal was
          previously rendered unconditionally, the only ADMIN-only action
          in this file not hidden from a CASHIER session as a UX courtesy
          (the server-side route still enforces the real boundary either
          way). */}
      {isAdmin && (
        <ReconcileBatchModal
          open={reconcileOpen}
          onOpenChange={setReconcileOpen}
          batch={reconcileBatch}
          productName={reconcileProductName}
          onSuccess={fetchProducts}
        />
      )}

      <BarcodeScannerModal open={barcodeScannerOpen} onOpenChange={setBarcodeScannerOpen} onScan={handleBarcodeScanned} />

      <FifoPreviewModal
        open={fifoPreviewOpen}
        onOpenChange={setFifoPreviewOpen}
        products={products}
        preselectedProductId={preselectedProductId}
      />
    </div>
  );
}