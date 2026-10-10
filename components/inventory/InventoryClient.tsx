/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import {
  Plus,
  Search,
  Camera,
  X,
  ChevronDown,
  MoreHorizontal,
  PackagePlus,
  PackageSearch,
  PackageX,
  PackageMinus,
  Layers,
  FileUp,
  Route,
  Globe,
  Clock,
  Scale,
  Archive,
  ClipboardList,
  SlidersHorizontal,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AddProductModal } from "@/components/inventory/AddProductModal";
import { EditProductModal } from "@/components/inventory/EditProductModal";
import { AddBatchModal } from "@/components/inventory/AddBatchModal";
import { MultiProductReceiptModal } from "@/components/inventory/MultiProductReceiptModal";
import { CsvImportModal } from "@/components/inventory/CsvImportModal";
import { FifoPreviewModal } from "@/components/inventory/FifoPreviewModal";
import { ReconcileBatchModal } from "@/components/inventory/ReconcileBatchModal";
import { DeleteBatchModal } from "@/components/inventory/DeleteBatchModal";
import { EditBatchModal } from "@/components/inventory/EditBatchModal";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ProductTable, ProductItem, BatchItem } from "@/components/inventory/ProductTable";

// "needs_reconciliation" is the single accepted value for the negative-stock
// filter (the backend's old "reconcile" alias was dropped).
type FilterTab =
  | "all"
  | "public"
  | "expiring"
  | "out_of_stock"
  | "needs_reconciliation"
  | "discontinued_unit_stock"
  | "inactive_products";

// ---------------------------------------------------------------------------
// Filters
//
// Three filters are used every day and stay visible. The other three are rare,
// so they live behind a single "المزيد" chip — that is what keeps the whole
// filter bar on ONE line on a phone. Colour is reserved for states that need
// attention (red = depleted, amber = expiring); everything else is neutral.
// ---------------------------------------------------------------------------
type Tone = "neutral" | "warning" | "danger";

type FilterOption = {
  value: Exclude<FilterTab, "all">;
  label: string;
  icon: LucideIcon;
  tone: Tone;
};

const PRIMARY_FILTERS: FilterOption[] = [
  { value: "expiring", label: "قريب من الانتهاء", icon: Clock, tone: "warning" },
  { value: "out_of_stock", label: "نافد من المخزون", icon: PackageX, tone: "danger" },
  { value: "needs_reconciliation", label: "يحتاج تسوية", icon: Scale, tone: "neutral" },
];

const SECONDARY_FILTERS: FilterOption[] = [
  { value: "public", label: "منشور بالمتجر", icon: Globe, tone: "neutral" },
  { value: "discontinued_unit_stock", label: "مخزون على وحدة متوقفة", icon: PackageMinus, tone: "neutral" },
  { value: "inactive_products", label: "منتجات معطلة", icon: Archive, tone: "neutral" },
];

const ACTIVE_TONE: Record<Tone, string> = {
  neutral: "border-slate-900 bg-slate-900 text-white hover:bg-slate-800 hover:text-white",
  warning: "border-amber-600 bg-amber-600 text-white hover:bg-amber-700 hover:text-white",
  danger: "border-red-600 bg-red-600 text-white hover:bg-red-700 hover:text-white",
};

const ICON_TONE: Record<Tone, string> = {
  neutral: "text-slate-500",
  warning: "text-amber-600",
  danger: "text-red-600",
};

function chipClass(active: boolean, tone: Tone = "neutral") {
  return cn(
    "h-10 shrink-0 gap-1.5 rounded-full border-slate-200 bg-white px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 sm:h-9",
    active && ACTIVE_TONE[tone]
  );
}

function FilterChip({
  active,
  tone = "neutral",
  icon: Icon,
  onClick,
  children,
}: {
  active: boolean;
  tone?: Tone;
  icon?: LucideIcon;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={active}
      onClick={onClick}
      className={chipClass(active, tone)}
    >
      {Icon && <Icon className={cn("size-3.5", !active && ICON_TONE[tone])} aria-hidden />}
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Loading / empty / error states
// ---------------------------------------------------------------------------
function ProductListSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="جاري تحميل المنتجات">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function StateBox({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white px-6 py-14 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <Icon className="size-7" aria-hidden />
      </div>
      <h2 className="text-sm font-bold text-slate-800">{title}</h2>
      <p className="max-w-xs text-xs leading-relaxed text-slate-500">{hint}</p>
      {action}
    </div>
  );
}

export function InventoryClient() {
  // "New product", "CSV import", batch entry and reconciliation are ADMIN-only
  // server-side (inventory:mutate). Hiding them from a CASHIER here is a UX
  // courtesy on top of that, not the security boundary. FIFO preview stays
  // visible to both roles.
  const { data: session } = useSessionWithOfflineFallback();
  const isAdmin = session?.role === "ADMIN";

  const [products, setProducts] = useState<ProductItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [expandedProductIds, setExpandedProductIds] = useState<Set<string>>(new Set());
  const [togglingPublicId, setTogglingPublicId] = useState<string | null>(null);
  const [togglingActiveId, setTogglingActiveId] = useState<string | null>(null);

  const [addProductOpen, setAddProductOpen] = useState(false);
  const [editProductOpen, setEditProductOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null);
  const [addBatchOpen, setAddBatchOpen] = useState(false);
  const [multiReceiptOpen, setMultiReceiptOpen] = useState(false);
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

  // Cancels any in-flight request before starting a new one, so a slow search
  // response can never overwrite a newer filter's results.
  const abortRef = useRef<AbortController | null>(null);

  const fetchProducts = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setLoadError(null);
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
      const message = err?.message || "فشل تحميل قائمة المنتجات.";
      setLoadError(message);
      toast.error(message);
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  }, [searchQuery, activeFilter]);

  // Debounce only when the SEARCH TEXT changed; a filter click always fetches
  // immediately, even with text already in the box.
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
      await fetchProducts();
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
      await fetchProducts();
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء تعديل حالة الوحدة.");
    } finally {
      setTogglingActiveId(null);
    }
  };

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

  const resetFilters = () => {
    setSearchQuery("");
    setActiveFilter("all");
  };

  const hasActiveFilters = searchQuery.trim() !== "" || activeFilter !== "all";
  const secondaryActive = SECONDARY_FILTERS.find((f) => f.value === activeFilter);
  const isOffline = typeof navigator !== "undefined" && !navigator.onLine;

  // What fills the area under the toolbar.
  let content: React.ReactNode;
  if (loadError && products.length === 0) {
    content = (
      <StateBox
        icon={isOffline ? WifiOff : PackageX}
        title="تعذّر تحميل المنتجات"
        hint={
          isOffline
            ? "أنت غير متصل بالإنترنت — شاشة المخزون تحتاج اتصالاً بالسيرفر."
            : loadError
        }
        action={
          <Button type="button" variant="outline" onClick={fetchProducts}>
            إعادة المحاولة
          </Button>
        }
      />
    );
  } else if (loading && products.length === 0) {
    content = <ProductListSkeleton />;
  } else if (!loading && products.length === 0) {
    // Two different situations, two different messages: the old single
    // "try changing your search" text was wrong for a tenant with no
    // products at all.
    content = hasActiveFilters ? (
      <StateBox
        icon={PackageSearch}
        title="ما في نتائج مطابقة"
        hint="جرّب كلمة بحث ثانية أو امسح الفلاتر لعرض كل المنتجات."
        action={
          <Button type="button" variant="outline" onClick={resetFilters}>
            مسح البحث والفلاتر
          </Button>
        }
      />
    ) : (
      <StateBox
        icon={PackagePlus}
        title="لسا ما أضفت أي منتج"
        hint={
          isAdmin
            ? "ابدأ بإضافة أول منتج، أو استورد قائمتك كاملة دفعة وحدة من ملف CSV."
            : "ما في منتجات بعد — المدير هو اللي بيضيف المنتجات."
        }
        action={
          isAdmin ? (
            <Button
              type="button"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => setAddProductOpen(true)}
            >
              <Plus className="size-4" aria-hidden />
              أضف أول منتج
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    content = (
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
    );
  }

  return (
    <div className="space-y-4">
      {/* The page title already lives in the top bar, so this screen starts
          straight at the tools — the first products stay on the first screen. */}

      {/* Row 1: search (with the camera inside it) + actions */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <Input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder="ابحث بالاسم أو الباركود..."
            aria-label="بحث في المخزون"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-11 bg-white ps-9 pe-20 text-sm sm:h-10"
          />
          {searchQuery && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="مسح البحث"
              onClick={() => setSearchQuery("")}
              className="absolute end-11 top-1/2 size-8 -translate-y-1/2 text-slate-400 hover:text-slate-700"
            >
              <X className="size-4" aria-hidden />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="مسح الباركود بالكاميرا"
            onClick={() => setBarcodeScannerOpen(true)}
            className="absolute end-1 top-1/2 size-9 -translate-y-1/2 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
          >
            <Camera className="size-5" aria-hidden />
          </Button>
        </div>

        {/* modal={false} on both menus: a Dialog opened from a menu item while
            the menu is modal leaves `pointer-events: none` stuck on <body>. */}
        {isAdmin && (
          <DropdownMenu dir="rtl" modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                aria-label="إضافة"
                className="h-11 gap-1.5 bg-emerald-600 px-3 hover:bg-emerald-700 sm:h-10 sm:px-4"
              >
                <Plus className="size-5 sm:size-4" aria-hidden />
                <span className="hidden sm:inline">إضافة</span>
                <ChevronDown className="hidden size-3.5 opacity-70 sm:block" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>إضافة إلى المخزون</DropdownMenuLabel>
              <DropdownMenuItem className="items-start gap-3 py-2.5" onSelect={() => setAddProductOpen(true)}>
                <PackagePlus className="mt-0.5 size-4 text-emerald-600" aria-hidden />
                <div>
                  <p className="text-sm font-semibold">منتج جديد</p>
                  <p className="text-xs text-slate-500">منتج بوحداته وأسعاره</p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem className="items-start gap-3 py-2.5" onSelect={() => setMultiReceiptOpen(true)}>
                <Layers className="mt-0.5 size-4 text-emerald-600" aria-hidden />
                <div>
                  <p className="text-sm font-semibold">استلام بضاعة</p>
                  <p className="text-xs text-slate-500">فاتورة شراء فيها عدة منتجات برقم دفعة واحد</p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem className="items-start gap-3 py-2.5" onSelect={() => handleOpenAddBatch()}>
                <PackagePlus className="mt-0.5 size-4 text-emerald-600" aria-hidden />
                <div>
                  <p className="text-sm font-semibold">دفعة لمنتج موجود</p>
                  <p className="text-xs text-slate-500">إضافة كمية جديدة لمنتج واحد</p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="items-start gap-3 py-2.5" onSelect={() => setCsvImportOpen(true)}>
                <FileUp className="mt-0.5 size-4 text-slate-500" aria-hidden />
                <div>
                  <p className="text-sm font-semibold">استيراد من ملف CSV</p>
                  <p className="text-xs text-slate-500">لقوائم المنتجات الكبيرة</p>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* [v4.7 Phase 7] Goods-receiving history. Hidden for CASHIER
            client-side (isAdmin) — the real boundary is server-side: every
            GET/PATCH /api/receipts* asserts receipts:view/receipts:edit
            (403 before any query), and the page component redirects a
            CASHIER away from /inventory/receipts too. */}
        {isAdmin && (
          <Link href="/receipts" className="shrink-0">
            <Button
              type="button"
              variant="outline"
              aria-label="سجل الاستلام"
              className="h-11 gap-1.5 border-emerald-200 bg-emerald-50/60 px-3 text-emerald-700 hover:bg-emerald-100 sm:h-10 sm:px-4"
            >
              <ClipboardList className="size-5 sm:size-4" aria-hidden />
              <span className="hidden whitespace-nowrap text-xs font-bold sm:inline">سجل الاستلام</span>
            </Button>
          </Link>
        )}

        <DropdownMenu dir="rtl" modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="المزيد"
              className="size-11 shrink-0 border-slate-200 bg-white sm:size-10"
            >
              <MoreHorizontal className="size-5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem className="items-start gap-3 py-2.5" onSelect={() => handleOpenFifoPreview()}>
              <Route className="mt-0.5 size-4 text-slate-500" aria-hidden />
              <div>
                <p className="text-sm font-semibold">معاينة FIFO</p>
                <p className="text-xs text-slate-500">من أي دفعة رح تنسحب الكمية</p>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Row 2: filters on ONE line (horizontal scroll on a phone, wrapping
          from `sm` up) */}
      <div
        role="group"
        aria-label="تصفية المنتجات"
        className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden"
      >
        <FilterChip active={activeFilter === "all"} onClick={() => setActiveFilter("all")}>
          الكل
        </FilterChip>

        {PRIMARY_FILTERS.map(({ value, label, icon, tone }) => (
          <FilterChip
            key={value}
            active={activeFilter === value}
            tone={tone}
            icon={icon}
            onClick={() => setActiveFilter(value)}
          >
            {label}
          </FilterChip>
        ))}

        <DropdownMenu dir="rtl" modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              aria-pressed={!!secondaryActive}
              className={chipClass(!!secondaryActive)}
            >
              {(() => {
                const Icon = secondaryActive?.icon ?? SlidersHorizontal;
                return <Icon className={cn("size-3.5", !secondaryActive && "text-slate-500")} aria-hidden />;
              })()}
              {secondaryActive ? secondaryActive.label : "المزيد"}
              <ChevronDown className="size-3.5 opacity-70" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuRadioGroup
              value={secondaryActive?.value ?? ""}
              onValueChange={(v) => setActiveFilter(v as FilterTab)}
            >
              {SECONDARY_FILTERS.map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value} className="gap-2">
                  <Icon className="size-4 text-slate-500" aria-hidden />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {content}

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
          {/* The single-batch screen collects the purchase cost, which a
              CASHIER must never even see rendered. */}
          <AddBatchModal
            open={addBatchOpen}
            onOpenChange={setAddBatchOpen}
            products={products}
            preselectedProductId={preselectedProductId}
            onSuccess={fetchProducts}
          />
          <CsvImportModal open={csvImportOpen} onOpenChange={setCsvImportOpen} onSuccess={fetchProducts} />
          <MultiProductReceiptModal
            open={multiReceiptOpen}
            onOpenChange={setMultiReceiptOpen}
            products={products}
            onSuccess={fetchProducts}
          />
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
          {/* Stock reconciliation is ADMIN-only per T2b's Role Capability Matrix. */}
          <ReconcileBatchModal
            open={reconcileOpen}
            onOpenChange={setReconcileOpen}
            batch={reconcileBatch}
            productName={reconcileProductName}
            onSuccess={fetchProducts}
          />
        </>
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