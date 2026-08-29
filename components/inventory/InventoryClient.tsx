/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Package, Plus, FileUp, Route, Search, Globe, Layers, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { AddProductModal } from "@/components/inventory/AddProductModal";
import { AddBatchModal } from "@/components/inventory/AddBatchModal";
import { CsvImportModal } from "@/components/inventory/CsvImportModal";
import { FifoPreviewModal } from "@/components/inventory/FifoPreviewModal";
import { ProductTable, ProductItem } from "@/components/inventory/ProductTable";

type FilterTab = "all" | "public" | "expiring" | "out_of_stock";

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

  const [addProductOpen, setAddProductOpen] = useState(false);
  const [addBatchOpen, setAddBatchOpen] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [fifoPreviewOpen, setFifoPreviewOpen] = useState(false);
  const [preselectedProductId, setPreselectedProductId] = useState<string | undefined>(undefined);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      if (activeFilter !== "all") params.set("filter", activeFilter);

      const res = await fetch(`/api/inventory/products?${params.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "حدث خطأ أثناء جلب المنتجات.");
      }

      setProducts(data.products || []);
    } catch (err: any) {
      toast.error(err.message || "فشل تحميل قائمة المنتجات.");
    } finally {
      setLoading(false);
    }
  }, [searchQuery, activeFilter]);

  // FIX: the previous version decided the delay by checking whether
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

  return (
    <div className="space-y-6" dir="rtl">
      {/* Action Bar Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Package className="w-7 h-7 text-emerald-600 dark:text-emerald-400" />
            <span>إدارة المخزون والدفعات</span>
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            إدارة أصلية للمنتجات متعددة الوحدات والتنبيه المباشر للصلاحية مع استيراد CSV والمعاينة الحية لـ FIFO.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Button
              onClick={() => setAddProductOpen(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs gap-1.5 shadow-sm"
            >
              <Plus className="w-4 h-4" />
              <span>منتج جديد</span>
            </Button>
          )}

          <Button
            onClick={() => handleOpenAddBatch()}
            variant="outline"
            className="border-emerald-300 text-emerald-800 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 text-xs gap-1.5"
          >
            <Layers className="w-4 h-4" />
            <span>دفعة جديدة</span>
          </Button>

          {isAdmin && (
            <Button
              onClick={() => setCsvImportOpen(true)}
              variant="outline"
              className="border-blue-300 text-blue-800 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 text-xs gap-1.5"
            >
              <FileUp className="w-4 h-4" />
              <span>استيراد CSV</span>
            </Button>
          )}

          <Button
            onClick={() => handleOpenFifoPreview()}
            variant="outline"
            className="border-indigo-300 text-indigo-800 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 text-xs gap-1.5"
          >
            <Route className="w-4 h-4" />
            <span>معاينة FIFO</span>
          </Button>
        </div>
      </div>

      {/* Search Bar & Visible Filter Tab Buttons */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute right-3 top-2.5 w-4 h-4 text-zinc-400" />
          <Input
            type="text"
            placeholder="ابحث بالاسم أو الباركود..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pr-9 text-xs bg-white dark:bg-zinc-900"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          <Button
            variant={activeFilter === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveFilter("all")}
            className={`text-xs h-8 rounded-lg ${activeFilter === "all" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : ""
              }`}
          >
            الكل
          </Button>

          <Button
            variant={activeFilter === "public" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveFilter("public")}
            className={`text-xs h-8 rounded-lg gap-1.5 ${activeFilter === "public"
              ? "bg-blue-600 text-white hover:bg-blue-700"
              : "border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-400"
              }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>منشور بالمتجر</span>
          </Button>

          <Button
            variant={activeFilter === "expiring" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveFilter("expiring")}
            className={`text-xs h-8 rounded-lg gap-1.5 ${activeFilter === "expiring"
              ? "bg-amber-600 text-white hover:bg-amber-700"
              : "border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-400"
              }`}
          >
            <AlertCircle className="w-3.5 h-3.5" />
            <span>قريب من الانتهاء</span>
          </Button>

          <Button
            variant={activeFilter === "out_of_stock" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveFilter("out_of_stock")}
            className={`text-xs h-8 rounded-lg gap-1.5 ${activeFilter === "out_of_stock"
              ? "bg-red-600 text-white hover:bg-red-700"
              : "border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
              }`}
          >
            <Package className="w-3.5 h-3.5" />
            <span>نافذ من المخزون</span>
          </Button>
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
        onAddBatch={handleOpenAddBatch}
        onFifoPreview={handleOpenFifoPreview}
        isAdmin={isAdmin}
      />

      {/* Modals */}
      {isAdmin && (
        <AddProductModal
          open={addProductOpen}
          onOpenChange={setAddProductOpen}
          onSuccess={fetchProducts}
        />
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