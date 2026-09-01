/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Layers } from "lucide-react";
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

interface AddBatchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: ProductItem[];
  preselectedProductId?: string;
  onSuccess: () => void;
}

export function AddBatchModal({ open, onOpenChange, products, preselectedProductId, onSuccess }: AddBatchModalProps) {
  // FIX: initial value is computed directly here (not left as "" and fixed
  // up later by an effect/render-adjustment block) — this is what was
  // actually broken before. The previous version initialized
  // `prevPreselectedProductId` to the SAME value as `preselectedProductId`,
  // so the "did it change?" check below was always false on first render,
  // and the field silently stayed empty even when a product was passed in.
  const [selectedProductId, setSelectedProductId] = useState<string>(
    () => preselectedProductId || products[0]?.id || ""
  );

  const selectedProduct = products.find((p) => p.id === selectedProductId);

  const [selectedUnitId, setSelectedUnitId] = useState<string>(
    () => selectedProduct?.units[0]?.id || ""
  );

  const [batchNumber, setBatchNumber] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(0);
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  // Adjust-state-during-render pattern (React's documented alternative to
  // an effect that only exists to keep one piece of state in sync with a
  // prop/other state — see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  // Calling setState here, mid-render, is intentional and cheap: React
  // discards this render and immediately re-renders with the new value
  // before anything is painted — there is no extra committed/visible
  // render, unlike the effect-based version these three blocks replace.

  // #1: selectedProductId follows preselectedProductId when it changes
  // (e.g. the modal is reopened from a different product's row).
  const [prevPreselectedProductId, setPrevPreselectedProductId] = useState(preselectedProductId);
  if (preselectedProductId !== prevPreselectedProductId) {
    setPrevPreselectedProductId(preselectedProductId);
    setSelectedProductId(preselectedProductId || products[0]?.id || "");
  }

  // #2: selectedUnitId follows selectedProductId — reset to the new
  // product's first unit, or explicitly cleared (not left stale) if the
  // newly selected product has no units at all.
  const [prevSelectedProductId, setPrevSelectedProductId] = useState(selectedProductId);
  if (selectedProductId !== prevSelectedProductId) {
    setPrevSelectedProductId(selectedProductId);
    setSelectedUnitId(selectedProduct?.units[0]?.id || "");
  }

  // #3: form fields reset whenever the modal transitions to closed (for
  // any reason, including Cancel), so stale values don't linger the next
  // time it's reopened.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setBatchNumber("");
      setQuantity(0);
      setExpiryDate("");
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId || !selectedUnitId) {
      toast.error("يرجى اختيار المنتج ووحدة القياس.");
      return;
    }

    if (!batchNumber.trim()) {
      toast.error("يرجى إدخال رقم الدفعة.");
      return;
    }

    setLoading(true);

    try {
      const payload = {
        productId: selectedProductId,
        unitId: selectedUnitId,
        batchNumber: batchNumber.trim(),
        quantity: Number(quantity),
        expiryDate: expiryDate || null,
      };

      const res = await fetch("/api/inventory/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "حدث خطأ أثناء إضافة الدفعة.");
      }

      toast.success("تمت إضافة الدفعة المخزونية الجديدة بنجاح!");
      onSuccess();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "فشلت عملية حفظ الدفعة.");
    } finally {
      setLoading(false);
    }
  };

  const productIsLocked = !!preselectedProductId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Layers className="w-5 h-5 text-emerald-600" />
            <span>إضافة دفعة مخزونية جديدة (Batch)</span>
          </DialogTitle>
          <DialogDescription>
            سجل رقم الدفعة الجديدة والكمية المستلمة وتاريخ صلاحيتها لتتبع FIFO.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>المنتج *</Label>
            <select
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value)}
              className="w-full h-9 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              required
              disabled={productIsLocked}
            >
              <option value="">اختر المنتج...</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {productIsLocked && (
              <p className="text-xs text-zinc-500">
                تم تحديد المنتج مسبقاً من الشاشة السابقة.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>الوحدة المستلمة *</Label>
            <select
              value={selectedUnitId}
              onChange={(e) => setSelectedUnitId(e.target.value)}
              className="w-full h-9 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-sm"
              required
              disabled={!selectedProduct || selectedProduct.units.length === 0}
            >
              {selectedProduct?.units.length === 0 && (
                <option value="">لا توجد وحدات قياس لهذا المنتج</option>
              )}
              {selectedProduct?.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.unitName} (معامل تحويل: {u.conversionFactor})
                </option>
              ))}
            </select>
            {selectedProduct && selectedProduct.units.length === 0 && (
              <p className="text-xs text-red-600">
                هذا المنتج لا يملك وحدات قياس بعد — أضف وحدة أولاً من شاشة تعديل المنتج.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>رقم الدفعة (Batch Number) *</Label>
            <Input
              placeholder="مثال: BATCH-2026-002"
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>الكمية المستلمة *</Label>
              <Input
                type="number"
                step="any"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(parseFloat(e.target.value) || 0)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>تاريخ الانتهاء</Label>
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              إلغاء
            </Button>
            <Button
              type="submit"
              disabled={loading || !selectedUnitId}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {loading ? "جاري الحفظ..." : "حفظ الدفعة"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}