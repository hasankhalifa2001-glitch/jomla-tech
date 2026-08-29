/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Route, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface ProductUnitItem {
  id: string;
  unitName: string;
  conversionFactor: number;
}

interface ProductItem {
  id: string;
  name: string;
  units: ProductUnitItem[];
}

interface FifoAllocationItem {
  batchId: string;
  batchNumber: string;
  expiryDate: string | null;
  allocatedQty: number;
  deductQtyInBatchUnit: number;
  batchUnitName: string;
}

interface FifoResolution {
  requestedUnitName: string;
  requestedQty: number;
  totalAllocatedQty: number;
  remainingQty: number;
  isSufficient: boolean;
  allocations: FifoAllocationItem[];
}

interface FifoPreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: ProductItem[];
  preselectedProductId?: string;
}

export function FifoPreviewModal({ open, onOpenChange, products, preselectedProductId }: FifoPreviewModalProps) {
  const [productId, setProductId] = useState<string>("");
  const [unitId, setUnitId] = useState<string>("");
  const [requestedQty, setRequestedQty] = useState<number>(5);
  const [loading, setLoading] = useState<boolean>(false);
  const [resolution, setResolution] = useState<FifoResolution | null>(null);

  // FIX: replaces two `useEffect` blocks that called `setState` directly
  // in their body — a documented anti-pattern (see React's "You Might Not
  // Need An Effect") because it forces an extra render pass after the one
  // that already ran. Both were really just "derive/reset this state when
  // some prop or other state changed," which React's own docs recommend
  // handling by adjusting state DURING render, guarded by comparing
  // against a stored previous value — not inside a separate effect.
  //
  // #1: productId should reset to preselectedProductId (or the first
  // product) whenever preselectedProductId changes — e.g. the merchant
  // clicked "FIFO" on a different product row while this modal was
  // already mounted.
  const [prevPreselectedProductId, setPrevPreselectedProductId] = useState(preselectedProductId);
  if (preselectedProductId !== prevPreselectedProductId) {
    setPrevPreselectedProductId(preselectedProductId);
    setProductId(preselectedProductId || products[0]?.id || "");
  }

  const selectedProduct = products.find((p) => p.id === productId);

  // #2: unitId should reset to the selected product's first unit whenever
  // productId changes (either from #1 above, or the merchant picking a
  // different product from the dropdown).
  const [prevProductId, setPrevProductId] = useState(productId);
  if (productId !== prevProductId) {
    setPrevProductId(productId);
    setUnitId(selectedProduct?.units[0]?.id || "");
  }

  const handleRunPreview = async () => {
    if (!productId || !unitId || requestedQty <= 0) {
      toast.error("يرجى تحديد المنتج والوحدة والكمية المطلوب معاينتها.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          unitId,
          requestedQty: Number(requestedQty),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "فشلت معاينة سحب المخزون.");
      }

      setResolution(data.resolution);
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء الاتصال بمحرك FIFO.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Route className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <span>معاينة محرك FIFO</span>
          </DialogTitle>
          <DialogDescription>
            اختبر آلية السحب التلقائي من الدفعات الأقرب انتهاءً قبل إتمام أي عملية بيع حقيقية.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">اختر المنتج</Label>
              <select
                value={productId}
                onChange={(e) => {
                  setProductId(e.target.value);
                  setResolution(null);
                }}
                className="w-full h-8 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2"
              >
                <option value="">اختر...</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label className="text-xs">وحدة البيع</Label>
              <select
                value={unitId}
                onChange={(e) => {
                  setUnitId(e.target.value);
                  setResolution(null);
                }}
                className="w-full h-8 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2"
                disabled={!selectedProduct}
              >
                {selectedProduct?.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.unitName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label className="text-xs">الكمية المراد بيعها</Label>
              <Input
                type="number"
                min="0.1"
                step="any"
                value={requestedQty}
                onChange={(e) => {
                  setRequestedQty(parseFloat(e.target.value) || 0);
                  setResolution(null);
                }}
                className="h-8 text-xs"
              />
            </div>
          </div>

          <Button
            type="button"
            onClick={handleRunPreview}
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white gap-2"
          >
            <Route className="w-4 h-4" />
            <span>{loading ? "جاري احتساب تخصيص FIFO..." : "تشغيل معاينة التخصيص"}</span>
          </Button>

          {resolution && (
            <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm">نتيجة محاكة السحب:</span>
                {resolution.isSufficient ? (
                  <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>المخزون كافٍ للطلب</span>
                  </Badge>
                ) : (
                  <Badge className="bg-amber-500/15 text-amber-800 dark:text-amber-400 gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>عجز في المخزون ({resolution.remainingQty} {resolution.requestedUnitName})</span>
                  </Badge>
                )}
              </div>

              {resolution.allocations.length === 0 ? (
                <p className="text-xs text-red-500 font-medium">لا توجد دفعات متوفرة بها كمية موجبة لهذا المنتج حالياً.</p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-500">سيتم سحب الكمية عبر الدفعات التالية (الأقرب صلاحية أولاً):</p>
                  <div className="space-y-1.5">
                    {resolution.allocations.map((alloc, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-xs"
                      >
                        <div>
                          <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                            الدفعة #{alloc.batchNumber}
                          </p>
                          <p className="text-zinc-500">
                            تاريخ الصلاحية: {alloc.expiryDate ? new Date(alloc.expiryDate).toLocaleDateString("ar-EG") : "غير محدد"}
                          </p>
                        </div>
                        <div className="text-left font-mono">
                          <p className="text-emerald-600 dark:text-emerald-400 font-bold">
                            +{alloc.allocatedQty} {resolution.requestedUnitName}
                          </p>
                          <p className="text-zinc-400 text-[10px]">
                            (خصم {alloc.deductQtyInBatchUnit} {alloc.batchUnitName} من الدفعة)
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter dir="rtl">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}