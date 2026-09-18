/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState } from "react";
import Decimal from "decimal.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Route, CheckCircle2, AlertTriangle, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export interface ProductUnitItem {
  id: string;
  unitName: string;
  conversionFactor: number;
}

export interface ProductItem {
  id: string;
  name: string;
  units: ProductUnitItem[];
}

// [FIX] lib/inventory/fifo.ts's allocateBatches() now serializes every
// quantity-shaped field via decimal.js's .toFixed(4) — a Decimal-
// normalized STRING, never a native JS number (see that file's own
// file-header FIX note: "requestedQty is now a decimal STRING, never
// `number`"). These two fields were previously typed `number`, which
// silently mismatched the real API response shape.
export interface FifoAllocationItem {
  batchId: string;
  batchNumber: string;
  expiryDate: string | null;
  allocatedQty: string;
  deductQtyInBatchUnit: string;
  batchUnitName: string;
}

// [FIX] Same as above — requestedQty/totalAllocatedQty/remainingQty are
// all Decimal-serialized strings on the wire now, matching
// lib/inventory/fifo.ts's AllocationPlan and
// app/api/inventory/fifo-preview/route.ts's JSON response exactly.
export interface FifoResolution {
  productId?: string;
  requestedUnitId?: string;
  requestedUnitName: string;
  requestedQty: string;
  totalAllocatedQty: string;
  remainingQty: string;
  isSufficient: boolean;
  fullyAllocated?: boolean;
  shortfallQty?: string;
  allocations: FifoAllocationItem[];
}

export interface FifoPreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products?: ProductItem[];
  preselectedProductId?: string;
  // [RESERVED FOR T4b POS PRE-CHECKOUT REUSE]
  // Allows direct single-product/unit pre-checkout inspection without requiring full catalog list
  productId?: string;
  unitId?: string;
  requestedQty?: number;
  onQuantityChange?: (qty: number) => void;
  onProductChange?: (productId: string) => void;
  onUnitChange?: (unitId: string) => void;
}

const DEFAULT_REQUESTED_QTY = 5;

export function FifoPreviewModal({
  open,
  onOpenChange,
  products = [],
  preselectedProductId,
  productId: directProductId,
  unitId: directUnitId,
  requestedQty: directRequestedQty,
  onQuantityChange,
  onProductChange,
  onUnitChange,
}: FifoPreviewModalProps) {
  const [internalProductId, setInternalProductId] = useState<string>("");
  const [internalUnitId, setInternalUnitId] = useState<string>("");
  // Kept as a native `number` for the <Input type="number"> control's own
  // value binding — this is purely UI input state, never itself the value
  // sent to the API (see handleRunPreview below, which converts it to a
  // decimal string via decimal.js immediately before the request).
  const [internalRequestedQty, setInternalRequestedQty] = useState<number>(DEFAULT_REQUESTED_QTY);
  const [loading, setLoading] = useState<boolean>(false);
  const [resolution, setResolution] = useState<FifoResolution | null>(null);

  // Active selections (supporting either controlled/direct props or internal state)
  const effectiveProductId = directProductId !== undefined ? directProductId : internalProductId;
  const effectiveUnitId = directUnitId !== undefined ? directUnitId : internalUnitId;
  const effectiveRequestedQty = directRequestedQty !== undefined ? directRequestedQty : internalRequestedQty;

  // #1: productId resets to preselectedProductId (or first product) when preselectedProductId changes
  const [prevPreselectedProductId, setPrevPreselectedProductId] = useState(preselectedProductId);
  if (preselectedProductId !== prevPreselectedProductId) {
    setPrevPreselectedProductId(preselectedProductId);
    const nextProdId = preselectedProductId || products[0]?.id || "";
    setInternalProductId(nextProdId);
    setResolution(null);
    setInternalRequestedQty(DEFAULT_REQUESTED_QTY);
  }

  const selectedProduct = products.find((p) => p.id === effectiveProductId);

  // #2: unitId resets to selected product's first unit when productId changes
  const [prevProductId, setPrevProductId] = useState(effectiveProductId);
  if (effectiveProductId !== prevProductId) {
    setPrevProductId(effectiveProductId);
    const defaultUnitId = selectedProduct?.units[0]?.id || "";
    setInternalUnitId(defaultUnitId);
    setResolution(null);
  }

  const handleProductSelect = (newProdId: string) => {
    setInternalProductId(newProdId);
    setResolution(null);
    onProductChange?.(newProdId);
  };

  const handleUnitSelect = (newUnitId: string) => {
    setInternalUnitId(newUnitId);
    setResolution(null);
    onUnitChange?.(newUnitId);
  };

  const handleQtyChange = (newQty: number) => {
    setInternalRequestedQty(newQty);
    setResolution(null);
    onQuantityChange?.(newQty);
  };

  const handleRunPreview = async () => {
    if (!effectiveProductId || !effectiveUnitId || effectiveRequestedQty <= 0) {
      toast.error("يرجى تحديد المنتج والوحدة والكمية المطلوب معاينتها.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: effectiveProductId,
          unitId: effectiveUnitId,
          // [FIX — critical] The backend's fifoPreviewSchema validates
          // `requestedQty` with `z.string().regex(DECIMAL_STRING_REGEX, ...)`
          // — a bare Zod string schema rejects any non-string value
          // OUTRIGHT, before the regex is even checked. The previous
          // `Number(effectiveRequestedQty)` sent a native JS number every
          // single time, which meant this feature failed validation on
          // every call, unconditionally. Serialized via decimal.js's own
          // .toString() (never a raw template-literal String(...) on a
          // value that might carry float artifacts) so the value the
          // backend receives is exact and already in the API's expected
          // decimal-string shape.
          requestedQty: new Decimal(effectiveRequestedQty).toString(),
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

  // [FIX] resolution.remainingQty is now a Decimal-serialized STRING —
  // `resolution.remainingQty > 0` previously relied on JS's implicit
  // string-to-number coercion for the `>` operator, which happened to
  // work but is exactly the kind of native-arithmetic reliance on a
  // Decimal(18,4)-backed value this project's conventions forbid.
  // Compared via decimal.js explicitly instead.
  const remainingQtyDecimal = resolution ? new Decimal(resolution.remainingQty) : null;
  const isShortfall =
    resolution &&
    (!resolution.isSufficient ||
      resolution.fullyAllocated === false ||
      (remainingQtyDecimal !== null && remainingQtyDecimal.greaterThan(0)));
  const shortfallAmount = resolution?.shortfallQty ?? resolution?.remainingQty ?? "0";

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
          {products.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">اختر المنتج</Label>
                <select
                  value={effectiveProductId}
                  onChange={(e) => handleProductSelect(e.target.value)}
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
                <Label className="text-xs">الوحدة المطلوبة</Label>
                <select
                  value={effectiveUnitId}
                  onChange={(e) => handleUnitSelect(e.target.value)}
                  disabled={!selectedProduct}
                  className="w-full h-8 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 disabled:opacity-50"
                >
                  <option value="">اختر...</option>
                  {selectedProduct?.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.unitName} (معامل {u.conversionFactor})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label className="text-xs">الكمية المطلوبة</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="any"
                  value={effectiveRequestedQty || ""}
                  onChange={(e) => handleQtyChange(parseFloat(e.target.value) || 0)}
                  className="h-8 text-xs font-mono"
                />
              </div>
            </div>
          )}

          <Button
            type="button"
            onClick={handleRunPreview}
            disabled={loading || !effectiveProductId || !effectiveUnitId || effectiveRequestedQty <= 0}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white gap-2"
          >
            <Route className="w-4 h-4" />
            <span>{loading ? "جاري احتساب تخصيص FIFO..." : "تشغيل معاينة التخصيص"}</span>
          </Button>

          {resolution && (
            <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm">نتيجة محاكاة السحب:</span>
                {!isShortfall ? (
                  <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>المخزون كافٍ للطلب</span>
                  </Badge>
                ) : (
                  <Badge className="bg-amber-500/15 text-amber-800 dark:text-amber-400 gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>عجز في المخزون ({shortfallAmount} {resolution.requestedUnitName})</span>
                  </Badge>
                )}
              </div>

              {/* Explicit shortfall explanation warning box */}
              {isShortfall && (
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                  <div>
                    <p className="font-semibold">الكمية المطلوبة غير متوفرة بالكامل</p>
                    <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">
                      تم تخصيص {resolution.totalAllocatedQty} من أصل {resolution.requestedQty} {resolution.requestedUnitName}.
                      يوجد نقص قدره {shortfallAmount} {resolution.requestedUnitName}.
                    </p>
                  </div>
                </div>
              )}

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
                            تاريخ الصلاحية: {alloc.expiryDate ? new Date(alloc.expiryDate).toLocaleDateString("ar-SY") : "غير محدد"}
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