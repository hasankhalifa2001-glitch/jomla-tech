/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, PackagePlus } from "lucide-react";
import { toast } from "sonner";

interface UnitForm {
  unitName: string;
  conversionFactor: number;
  priceUSD: number;
  barcode: string;
}

interface AddProductModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const EMPTY_UNITS: UnitForm[] = [
  { unitName: "قطعة", conversionFactor: 1, priceUSD: 1.0, barcode: "" },
];

export function AddProductModal({ open, onOpenChange, onSuccess }: AddProductModalProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  const [units, setUnits] = useState<UnitForm[]>(EMPTY_UNITS);

  const [hasInitialBatch, setHasInitialBatch] = useState(false);
  const [batchUnitIndex, setBatchUnitIndex] = useState(0);
  const [batchNumber, setBatchNumber] = useState("");
  // 0, not an arbitrary starting quantity like 10 — forces a deliberate
  // entry instead of letting a merchant submit an unintended default
  // quantity for the initial batch. Mirrors the same fix on AddBatchModal.
  const [batchQuantity, setBatchQuantity] = useState<number>(0);
  const [expiryDate, setExpiryDate] = useState("");

  const [loading, setLoading] = useState(false);

  const resetForm = () => {
    setName("");
    setCategory("");
    setIsPublic(false);
    setUnits(EMPTY_UNITS);
    setHasInitialBatch(false);
    setBatchUnitIndex(0);
    setBatchNumber("");
    setBatchQuantity(0);
    setExpiryDate("");
  };

  // Wraps the Dialog's own onOpenChange rather than watching `open` via a
  // render-time comparison: every path that closes the dialog (Cancel,
  // Escape, an outside click, or a successful save calling this with
  // `false`) already funnels through this single callback, so there's no
  // prop-derived state to reconcile — just react to the close event here.
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      resetForm();
    }
    onOpenChange(isOpen);
  };

  const handleAddUnit = () => {
    setUnits([
      ...units,
      { unitName: "طرد", conversionFactor: 12, priceUSD: 10.0, barcode: "" },
    ]);
  };

  const handleRemoveUnit = (index: number) => {
    if (units.length <= 1) {
      toast.error("يجب الإبقاء على وحدة قياس واحدة على الأقل.");
      return;
    }
    const updated = units.filter((_, i) => i !== index);
    setUnits(updated);
    if (batchUnitIndex >= updated.length) {
      setBatchUnitIndex(0);
    }
  };

  const handleUnitChange = (index: number, field: keyof UnitForm, value: string | number) => {
    const updated = [...units];
    updated[index] = { ...updated[index], [field]: value };
    setUnits(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("يرجى إدخال اسم المنتج.");
      return;
    }

    if (units.some((u) => !u.unitName.trim() || u.conversionFactor <= 0 || u.priceUSD <= 0)) {
      toast.error("يرجى التأكد من ملء جميع الوحدات بمعاملات وسعر أكبر من الصفر.");
      return;
    }

    // Catches a duplicate barcode across this product's OWN units before
    // hitting the network — the database's @@unique([tenantId, barcode])
    // constraint would catch it too, but there's no reason to make a round
    // trip for a mistake that's checkable instantly from what's already
    // on screen.
    const enteredBarcodes = units.map((u) => u.barcode.trim()).filter(Boolean);
    if (new Set(enteredBarcodes).size !== enteredBarcodes.length) {
      toast.error("لا يمكن استخدام نفس الباركود لأكثر من وحدة قياس ضمن المنتج نفسه.");
      return;
    }

    if (hasInitialBatch && (!batchQuantity || batchQuantity <= 0)) {
      toast.error("يرجى إدخال كمية أكبر من الصفر للدفعة المخزونية الأولية، أو إلغاء تفعيلها.");
      return;
    }

    setLoading(true);

    try {
      const payload = {
        name: name.trim(),
        category: category.trim() || null,
        isPublic,
        units: units.map((u) => ({
          unitName: u.unitName.trim(),
          conversionFactor: Number(u.conversionFactor),
          priceUSD: Number(u.priceUSD),
          barcode: u.barcode.trim() || null,
        })),
        initialBatch: hasInitialBatch
          ? {
            unitIndex: batchUnitIndex,
            batchNumber: batchNumber.trim() || `BATCH-${Date.now().toString().slice(-6)}`,
            quantity: Number(batchQuantity),
            expiryDate: expiryDate || null,
          }
          : null,
      };

      const res = await fetch("/api/inventory/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "حدث خطأ أثناء إضافة المنتج.");
      }

      toast.success("تم إدخال المنتج ووحداته بنجاح!");
      onSuccess();
      handleOpenChange(false); // closes AND resets in one call
    } catch (err: any) {
      toast.error(err.message || "فشلت عملية الإضافة.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <PackagePlus className="w-5 h-5 text-emerald-600" />
            <span>إضافة منتج جديد متعدد الوحدات</span>
          </DialogTitle>
          <DialogDescription>
            حدد اسم المنتج والتصنيف، وأضف وحدة القياس الأساسية والفرعية مع معامل التحويل وسعر البيع.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="product-name">اسم المنتج *</Label>
              <Input
                id="product-name"
                placeholder="مثال: أرز مصري ممتاز"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="product-category">التصنيف (اختياري)</Label>
              <Input
                id="product-category"
                placeholder="مثال: المواد الغذائية"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                وحدات التعبئة والأسعار (Packaging Units)
              </h3>
              <Button type="button" variant="outline" size="sm" onClick={handleAddUnit} className="gap-1">
                <Plus className="w-4 h-4" />
                <span>إضافة وحدة فرعية</span>
              </Button>
            </div>

            <div className="space-y-3">
              {units.map((unit, idx) => (
                <div
                  key={idx}
                  className="p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg space-y-3"
                >
                  <div className="flex items-center justify-between text-xs text-zinc-500 font-medium">
                    <span>{idx === 0 ? "الوحدة الأساسية (Base Unit)" : `وحدة فرعية (${idx + 1})`}</span>
                    {units.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-red-500 hover:text-red-700"
                        onClick={() => handleRemoveUnit(idx)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <Label className="text-xs">اسم الوحدة</Label>
                      <Input
                        placeholder="مثال: قطعة / طرد"
                        value={unit.unitName}
                        onChange={(e) => handleUnitChange(idx, "unitName", e.target.value)}
                        className="h-8 text-xs"
                        required
                      />
                    </div>
                    <div>
                      <Label className="text-xs">معامل التحويل</Label>
                      <Input
                        type="number"
                        step="any"
                        min="0.0001"
                        value={unit.conversionFactor}
                        onChange={(e) => handleUnitChange(idx, "conversionFactor", parseFloat(e.target.value) || 1)}
                        className="h-8 text-xs"
                        required
                      />
                    </div>
                    <div>
                      <Label className="text-xs">السعر ($USD)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={unit.priceUSD}
                        onChange={(e) => handleUnitChange(idx, "priceUSD", parseFloat(e.target.value) || 0)}
                        className="h-8 text-xs"
                        required
                      />
                    </div>
                    <div>
                      <Label className="text-xs">الباركود</Label>
                      <Input
                        placeholder="رمز الباركود"
                        value={unit.barcode}
                        onChange={(e) => handleUnitChange(idx, "barcode", e.target.value)}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="has-batch"
                checked={hasInitialBatch}
                onChange={(e) => setHasInitialBatch(e.target.checked)}
                className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
              />
              <Label htmlFor="has-batch" className="cursor-pointer font-semibold text-sm">
                إضافة دفعة مخزونية أولية فوراً
              </Label>
            </div>

            {hasInitialBatch && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 rounded-lg">
                <div>
                  <Label className="text-xs">الوحدة المستلمة</Label>
                  <select
                    value={batchUnitIndex}
                    onChange={(e) => setBatchUnitIndex(parseInt(e.target.value))}
                    className="w-full h-8 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2"
                  >
                    {units.map((u, i) => (
                      <option key={i} value={i}>
                        {u.unitName} (معامل {u.conversionFactor})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">رقم الدفعة</Label>
                  <Input
                    placeholder="مثال: BATCH-2026-001"
                    value={batchNumber}
                    onChange={(e) => setBatchNumber(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs">الكمية المستلمة</Label>
                  <Input
                    type="number"
                    min="0"
                    value={batchQuantity}
                    onChange={(e) => setBatchQuantity(parseFloat(e.target.value) || 0)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs">تاريخ الانتهاء</Label>
                  <Input
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={loading}>
              إلغاء
            </Button>
            <Button type="submit" disabled={loading} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {loading ? "جاري الحفظ..." : "حفظ المنتج"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}