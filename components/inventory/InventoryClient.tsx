/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Package,
  Plus,
  FileUp,
  Route,
  Search,
  Globe,
  Layers,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AddProductModal } from "@/components/inventory/AddProductModal";
import { EditProductModal } from "@/components/inventory/EditProductModal";
import { AddBatchModal } from "@/components/inventory/AddBatchModal";
import { CsvImportModal } from "@/components/inventory/CsvImportModal";
import { FifoPreviewModal } from "@/components/inventory/FifoPreviewModal";
import { ProductTable, ProductItem } from "@/components/inventory/ProductTable";

// [FIX] Added "needs_reconciliation" — the backend (/api/inventory/products
// GET) already supports this filter value (see route.ts's
// `hasNegativeStockBatch` branch), but no UI tab ever sent it. T3's
// acceptance criterion ("Any batch with quantity < 0 shows the negative-
// stock badge and appears under the 'يحتاج تسوية' filter tab") was
// therefore only half-met. Standardized on "needs_reconciliation" only —
// the backend's "reconcile" alias is redundant and dropped there too, so
// there is exactly one accepted value for this filter going forward.
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
  {
    value: "public",
    label: "منشور بالمتجر",
    icon: Globe,
    activeClass: "bg-blue-600 text-white hover:bg-blue-700",
    inactiveClass:
      "border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-400",
  },
  {
    value: "expiring",
    label: "قريب من الانتهاء",
    icon: AlertCircle,
    activeClass: "bg-amber-600 text-white hover:bg-amber-700",
    inactiveClass:
      "border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-400",
  },
  {
    // [FIX] New tab — was entirely missing. Color aligned with
    // NegativeStockBadge (purple), which is the badge this filter's
    // results are meant to correspond to at the row/batch level.
    value: "needs_reconciliation",
    label: "يحتاج تسوية",
    icon: AlertCircle,
    activeClass: "bg-purple-600 text-white hover:bg-purple-700",
    inactiveClass:
      "border-purple-200 text-purple-700 hover:bg-purple-50 dark:border-purple-900 dark:text-purple-400",
  },
  {
    value: "out_of_stock",
    label: "نافذ من المخزون",
    icon: Package,
    activeClass: "bg-red-600 text-white hover:bg-red-700",
    inactiveClass:
      "border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400",
  },
  {
    value: "discontinued_unit_stock",
    label: "مخزون على وحدة متوقفة",
    icon: AlertCircle,
    activeClass: "bg-amber-600 text-white hover:bg-amber-700",
    inactiveClass:
      "border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-400",
  },
  {
    value: "inactive_products",
    label: "منتجات معطلة",
    icon: Package,
    activeClass: "bg-zinc-700 text-white hover:bg-zinc-800",
    inactiveClass:
      "border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400",
  },
];

export function InventoryClient() {
  // "New product" and "CSV import" are ADMIN-only server-side (see
  // products/route.ts POST and import/commit/route.ts) — hiding them from
  // a CASHIER session here is a UX courtesy on top of that, not the real
  // security boundary. "Add batch" and "FIFO preview" stay visible to both
  // roles, matching batches/route.ts and fifo-preview/route.ts, which
  // impose no role restriction.
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

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
      setProducts((prev) =>
        prev.map((p) =>
          p.id === productId ? { ...p, isActive: data.isActive, isPublic: data.isPublic } : p
        )
      );
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
      setProducts((prev) =>
        prev.map((p) => {
          if (p.id !== productId) return p;
          return {
            ...p,
            isPublic: data.productIsPublic !== undefined ? data.productIsPublic : p.isPublic,
            units: p.units.map((u) => (u.id === unitId ? { ...u, isActive: data.unit.isActive } : u)),
          };
        })
      );
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء تعديل حالة الوحدة.");
    } finally {
      setTogglingActiveId(null);
    }
  };

  // [FIX] Cancels any in-flight request before starting a new one. Without
  // this, a slow debounced search response landing after a fast filter-tab
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

  // [FIX] The previous version decided the delay by checking whether
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
      setProducts((prev) =>
        prev.map((p) => (p.id === productId ? { ...p, isPublic: data.isPublic } : p))
      );
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

  return (
    <div className="space-y-5 sm:space-y-6" dir="rtl">
      {/* Action Bar Header */}
      <div className="flex flex-col gap-4 pb-2 border-b border-zinc-200 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-zinc-900 dark:text-zinc-100 sm:text-2xl">
            <Package className="w-6 h-6 text-emerald-600 dark:text-emerald-400 sm:w-7 sm:h-7" />
            <span>إدارة المخزون والدفعات</span>
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            إدارة أصلية للمنتجات متعددة الوحدات والتنبيه المباشر للصلاحية مع استيراد CSV والمعاينة الحية لـ FIFO.
          </p>
        </div>

        {/* 2-column grid on mobile for full-width, equal-size tap targets;
            reverts to an inline wrapping row from `sm` up where width isn't
            a constraint. */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          {isAdmin && (
            <Button
              onClick={() => setAddProductOpen(true)}
              className="w-full gap-1.5 bg-emerald-600 text-xs text-white shadow-sm hover:bg-emerald-700 sm:w-auto"
            >
              <Plus className="w-4 h-4" />
              <span>منتج جديد</span>
            </Button>
          )}

          <Button
            onClick={() => handleOpenAddBatch()}
            variant="outline"
            className="w-full gap-1.5 border-emerald-300 text-xs text-emerald-800 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 sm:w-auto"
          >
            <Layers className="w-4 h-4" />
            <span>دفعة جديدة</span>
          </Button>

          {isAdmin && (
            <Button
              onClick={() => setCsvImportOpen(true)}
              variant="outline"
              className="w-full gap-1.5 border-blue-300 text-xs text-blue-800 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 sm:w-auto"
            >
              <FileUp className="w-4 h-4" />
              <span>استيراد CSV</span>
            </Button>
          )}

          <Button
            onClick={() => handleOpenFifoPreview()}
            variant="outline"
            className="w-full gap-1.5 border-indigo-300 text-xs text-indigo-800 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 sm:w-auto"
          >
            <Route className="w-4 h-4" />
            <span>معاينة FIFO</span>
          </Button>
        </div>
      </div>

      {/* Search Bar & Filter Tabs */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full md:max-w-md">
          <Search className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
          <Input
            type="text"
            placeholder="ابحث بالاسم أو الباركود..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white pr-9 text-xs dark:bg-zinc-900"
          />
        </div>

        {/* flex-wrap instead of a horizontal scroller: on a narrow phone
            the chips fall onto a second/third line instead of hiding behind
            an unlabeled scroll area, so every filter stays discoverable. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant={activeFilter === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveFilter("all")}
            className={`h-8 rounded-lg text-xs ${activeFilter === "all" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : ""
              }`}
          >
            الكل
          </Button>

          {FILTER_TABS.map(({ value, label, icon: Icon, activeClass, inactiveClass }) => (
            <Button
              key={value}
              variant={activeFilter === value ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveFilter(value)}
              className={`h-8 gap-1.5 rounded-lg text-xs ${activeFilter === value ? activeClass : inactiveClass
                }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{label}</span>
            </Button>
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
        isAdmin={isAdmin}
      />

      {/* Modals */}
      {isAdmin && (
        <>
          <AddProductModal
            open={addProductOpen}
            onOpenChange={setAddProductOpen}
            onSuccess={fetchProducts}
          />
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
        <CsvImportModal
          open={csvImportOpen}
          onOpenChange={setCsvImportOpen}
          onSuccess={fetchProducts}
        />
      )}

      <FifoPreviewModal
        open={fifoPreviewOpen}
        onOpenChange={setFifoPreviewOpen}
        products={products}
        preselectedProductId={preselectedProductId}
      />
    </div>
  );
}