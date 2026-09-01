/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, PackagePlus, Camera, Crop, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ImageCropModal } from "@/components/inventory/ImageCropModal";
import { CatalogReportModal } from "@/components/inventory/CatalogReportModal";

interface UnitForm {
  unitName: string;
  conversionFactor: number;
  pricingCurrency: "SYP" | "USD";
  priceWholesale: number;
  priceRetail: number | "";
  barcode: string;
  barcodeSource: "GS1" | "INTERNAL" | "";
  imageUrl: string;
}

interface AddProductModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const DEFAULT_BASE_UNIT: UnitForm = {
  unitName: "قطعة",
  conversionFactor: 1,
  pricingCurrency: "SYP",
  priceWholesale: 1000,
  priceRetail: "",
  barcode: "",
  barcodeSource: "",
  imageUrl: "",
};

interface CatalogEntryInfo {
  id: string;
  barcode: string;
  name: string;
  category: string | null;
  imageUrl: string | null;
  isOwner: boolean;
}

export function AddProductModal({ open, onOpenChange, onSuccess }: AddProductModalProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  const [units, setUnits] = useState<UnitForm[]>([{ ...DEFAULT_BASE_UNIT }]);

  const [hasInitialBatch, setHasInitialBatch] = useState(false);
  const [batchUnitIndex, setBatchUnitIndex] = useState(0);
  const [batchNumber, setBatchNumber] = useState("");
  const [batchQuantity, setBatchQuantity] = useState<number>(0);
  const [expiryDate, setExpiryDate] = useState("");

  const [loading, setLoading] = useState(false);

  // Modal child states
  const [scannerModalOpen, setScannerModalOpen] = useState(false);
  const [activeUnitForScan, setActiveUnitForScan] = useState<number>(0);

  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [activeUnitForCrop, setActiveUnitForCrop] = useState<number>(0);

  const [catalogInfo, setCatalogInfo] = useState<CatalogEntryInfo | null>(null);
  const [reportModalOpen, setReportModalOpen] = useState(false);

  // Debounce + cancellation for the manual/scanned barcode lookup, mirroring
  // the pattern used in InventoryClient.tsx's product search. Without this,
  // every keystroke fires its own fetch with nothing stopping an older,
  // slower response from overwriting a newer one.
  const lookupAbortRef = useRef<AbortController | null>(null);
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);
      lookupAbortRef.current?.abort();
    };
  }, []);

  const resetForm = () => {
    setName("");
    setCategory("");
    setIsPublic(false);
    setUnits([{ ...DEFAULT_BASE_UNIT }]);
    setHasInitialBatch(false);
    setBatchUnitIndex(0);
    setBatchNumber("");
    setBatchQuantity(0);
    setExpiryDate("");
    setCatalogInfo(null);
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      resetForm();
    }
    onOpenChange(isOpen);
  };

  const handleAddUnit = () => {
    setUnits([
      ...units,
      {
        unitName: "كرتونة",
        conversionFactor: 12,
        pricingCurrency: "SYP",
        priceWholesale: 12000,
        priceRetail: "",
        barcode: "",
        barcodeSource: "",
        imageUrl: "",
      },
    ]);
  };

  // Tracks whether the removed unit was the one selected for the initial
  // batch, OR sat before it in the array (which shifts every later index
  // down by one). Either way the previous batchUnitIndex no longer safely
  // identifies the same unit it did before removal — checking only
  // "did the index fall out of range" misses the case where it stays
  // numerically valid but now silently points at a *different* unit,
  // which would write the initial stock batch against the wrong
  // ProductUnit on submit. Resetting to 0 forces the merchant to
  // consciously re-pick instead.
  const handleRemoveUnit = (index: number) => {
    if (units.length <= 1) {
      toast.error("يجب الإبقاء على وحدة قياس واحدة على الأقل.");
      return;
    }
    const updated = units.filter((_, i) => i !== index);
    setUnits(updated);

    if (index <= batchUnitIndex) {
      setBatchUnitIndex(0);
    }
  };

  const handleUnitChange = (index: number, field: keyof UnitForm, value: any) => {
    const updated = [...units];
    updated[index] = { ...updated[index], [field]: value };
    setUnits(updated);
  };

  // `targetUnitIndex` is an explicit, required parameter rather than
  // implicitly reading `activeUnitForScan` from state — that state is only
  // ever updated when the camera scanner is opened, never when a barcode
  // is typed manually into a specific unit's input, so relying on it here
  // could silently apply the catalog's suggested image to the wrong unit.
  //
  // Debounced (300ms) and cancels any in-flight request before starting a
  // new one, so a fast keystroke can't have its response overwritten by a
  // slower, now-stale one that lands later.
  const lookupBarcodeInCatalog = (barcodeVal: string, targetUnitIndex: number) => {
    if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);

    const cleanBarcode = barcodeVal.trim();
    if (!cleanBarcode) {
      // Clear any stale catalog banner when the barcode field this lookup
      // was tracking is emptied out — otherwise catalogInfo could keep
      // showing a match for a barcode no longer present in the form at
      // all (e.g. a match was found, then the barcode was deleted to type
      // a different one).
      setCatalogInfo(null);
      return;
    }

    lookupTimerRef.current = setTimeout(async () => {
      lookupAbortRef.current?.abort();
      const controller = new AbortController();
      lookupAbortRef.current = controller;

      try {
        const res = await fetch(`/api/catalog/lookup?barcode=${encodeURIComponent(cleanBarcode)}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (res.ok && data.success && data.entry) {
          setCatalogInfo(data.entry);
          if (data.entry.name) {
            setName((prev) => prev || data.entry.name);
          }
          if (data.entry.category) {
            setCategory((prev) => prev || data.entry.category);
          }
          if (data.entry.imageUrl) {
            setUnits((prevUnits) => {
              const updated = [...prevUnits];
              if (updated[targetUnitIndex] && !updated[targetUnitIndex].imageUrl) {
                updated[targetUnitIndex] = {
                  ...updated[targetUnitIndex],
                  imageUrl: data.entry.imageUrl,
                };
              }
              return updated;
            });
          }
          toast.success(`تم العثور على المنتج في الكتالوج المشترك: "${data.entry.name}"`);
        } else {
          setCatalogInfo(null);
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        // Ignore other lookup network errors — this is a convenience
        // lookup, not a required step.
      }
    }, 300);
  };

  // [CRITICAL] Never auto-sets barcodeSource on a camera scan result.
  // schema.prisma's v3.1 note is explicit that this exact shortcut must
  // never happen: "a silent default of GS1 would make an unreviewed
  // barcode eligible for the shared catalog by accident... must be set
  // explicitly by the merchant... never guessed." Scanning a barcode with
  // the camera only reads a number — it says nothing about whether that
  // number is a real, factory-printed GS1/EAN code or an internal sticker
  // the merchant wrote themselves. This behaves exactly like manual entry:
  // the scanned value fills the barcode field only, and barcodeSource
  // stays whatever the merchant explicitly picks from the dropdown below —
  // matching T3's acceptance criterion ("barcodeSource is only ever set
  // via explicit merchant confirmation") for BOTH entry paths, not just
  // manual typing.
  const handleBarcodeScanResult = (scannedBarcode: string) => {
    const updated = [...units];
    updated[activeUnitForScan] = {
      ...updated[activeUnitForScan],
      barcode: scannedBarcode,
    };
    setUnits(updated);
    lookupBarcodeInCatalog(scannedBarcode, activeUnitForScan);
  };

  const handleCropResult = (croppedDataUrl: string) => {
    const updated = [...units];
    updated[activeUnitForCrop] = {
      ...updated[activeUnitForCrop],
      imageUrl: croppedDataUrl,
    };
    setUnits(updated);
  };

  const handleTogglePublic = (checked: boolean) => {
    if (checked) {
      const isPublishable = units.some(
        (u) =>
          u.priceRetail !== "" &&
          Number(u.priceRetail) > 0 &&
          u.imageUrl &&
          u.imageUrl.trim().length > 0
      );

      if (!isPublishable) {
        toast.error("لا يمكن نشر المنتج في المتجر إلا بعد إدخال سعر التجزئة وصورة المنتج على الأقل لإحدى الوحدات.");
        setIsPublic(false);
        return;
      }
    }
    setIsPublic(checked);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("يرجى إدخال اسم المنتج.");
      return;
    }

    if (units.some((u) => !u.unitName.trim() || u.conversionFactor <= 0 || u.priceWholesale <= 0)) {
      toast.error("يرجى التأكد من ملء جميع الوحدات بمعامل تحويل وسعر جملة أكبر من الصفر.");
      return;
    }

    const enteredBarcodes = units.map((u) => u.barcode.trim()).filter(Boolean);
    if (new Set(enteredBarcodes).size !== enteredBarcodes.length) {
      toast.error("لا يمكن استخدام نفس الباركود لأكثر من وحدة قياس ضمن المنتج نفسه.");
      return;
    }

    if (hasInitialBatch && (!batchQuantity || batchQuantity <= 0)) {
      toast.error("يرجى إدخال كمية أكبر من الصفر للدفعة المخزونية الأولية، أو إلغاء تفعيلها.");
      return;
    }

    if (isPublic) {
      const isPublishable = units.some(
        (u) =>
          u.priceRetail !== "" &&
          Number(u.priceRetail) > 0 &&
          u.imageUrl &&
          u.imageUrl.trim().length > 0
      );
      if (!isPublishable) {
        toast.error("شروط النشر بالمتجر غير مكتملة (تتطلب سعر تجزئة وصورة للمنتج).");
        return;
      }
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
          pricingCurrency: u.pricingCurrency,
          priceWholesale: Number(u.priceWholesale),
          priceRetail: u.priceRetail !== "" ? Number(u.priceRetail) : null,
          barcode: u.barcode.trim() || null,
          barcodeSource: u.barcode.trim() ? (u.barcodeSource || "INTERNAL") : null,
          imageUrl: u.imageUrl.trim() || null,
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
      handleOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "فشلت عملية الإضافة.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-bold">
              <PackagePlus className="w-5 h-5 text-emerald-600" />
              <span>إضافة منتج جديد متعدد الوحدات</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              أدخل بيانات المنتج، وحدات التعبئة (طرد / كرتونة / قطعة)، أسعار الجملة والتجزئة، وتصنيف الباركود.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 my-2 text-xs">
            {catalogInfo && (
              <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 rounded-lg flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                  <div>
                    <p className="font-bold text-blue-900 dark:text-blue-300">
                      تم جلب البيانات من الكتالوج المشترك (GS1)
                    </p>
                    <p className="text-[11px] text-blue-700 dark:text-blue-400">
                      المنتج: {catalogInfo.name} {catalogInfo.category ? `(${catalogInfo.category})` : ""}
                    </p>
                  </div>
                </div>
                {!catalogInfo.isOwner && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setReportModalOpen(true)}
                    className="text-[11px] h-7 border-blue-300 dark:border-blue-800 text-blue-800 dark:text-blue-300 gap-1 shrink-0"
                  >
                    <AlertTriangle className="w-3 h-3 text-amber-500" />
                    <span>تقديم اقتراح تصحيح</span>
                  </Button>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
              <div>
                <Label className="text-xs font-semibold">اسم المنتج الرئيسي *</Label>
                <Input
                  placeholder="مثال: زيت زيتون ممتاز 1 ليتر"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-8 text-xs mt-1"
                  required
                />
              </div>

              <div>
                <Label className="text-xs font-semibold">التصنيف / الفئة</Label>
                <Input
                  placeholder="مثال: زيوت ومواد غذائية"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-8 text-xs mt-1"
                />
              </div>

              <div className="sm:col-span-2 flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="is-public-toggle"
                  checked={isPublic}
                  onChange={(e) => handleTogglePublic(e.target.checked)}
                  className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                />
                <Label htmlFor="is-public-toggle" className="cursor-pointer font-semibold text-xs text-zinc-800 dark:text-zinc-200">
                  عرض المنتج في متجر العملاء الإلكتروني (يتطلب سعر تجزئة وصورة للمنتج)
                </Label>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="font-bold text-sm text-zinc-900 dark:text-zinc-100">
                  وحدات التعبئة والأسعار (Packaging Units)
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddUnit}
                  className="gap-1 h-7 text-xs border-emerald-600 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>إضافة وحدة فرعية/ثانوية</span>
                </Button>
              </div>

              <div className="space-y-3">
                {units.map((unit, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg space-y-3 shadow-2xs"
                  >
                    <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 pb-2">
                      <span className="font-bold text-xs text-zinc-700 dark:text-zinc-300">
                        {idx === 0 ? "الوحدة الأساسية (Base Unit)" : `وحدة تجميعية #${idx + 1}`}
                      </span>
                      {units.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveUnit(idx)}
                          className="h-6 w-6 p-0 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div>
                        <Label className="text-[11px]">اسم الوحدة *</Label>
                        <Input
                          placeholder="مثال: قطعة / كرتونة / طرد"
                          value={unit.unitName}
                          onChange={(e) => handleUnitChange(idx, "unitName", e.target.value)}
                          className="h-8 text-xs mt-1"
                          required
                        />
                      </div>

                      <div>
                        <Label className="text-[11px]">معامل التحويل (عدد الوحدات الأساسية) *</Label>
                        <Input
                          type="number"
                          step="any"
                          min="0.0001"
                          disabled={idx === 0}
                          value={idx === 0 ? 1 : unit.conversionFactor}
                          onChange={(e) => handleUnitChange(idx, "conversionFactor", parseFloat(e.target.value) || 1)}
                          className="h-8 text-xs mt-1"
                          required
                        />
                      </div>

                      <div>
                        <Label className="text-[11px]">العملة *</Label>
                        <select
                          value={unit.pricingCurrency}
                          onChange={(e) => handleUnitChange(idx, "pricingCurrency", e.target.value as "SYP" | "USD")}
                          className="w-full h-8 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 mt-1"
                        >
                          <option value="SYP">ليرة سورية (SYP)</option>
                          <option value="USD">دولار أمريكي (USD)</option>
                        </select>
                      </div>

                      <div>
                        <Label className="text-[11px]">سعر الجملة *</Label>
                        <Input
                          type="number"
                          step="any"
                          min="0.01"
                          value={unit.priceWholesale}
                          onChange={(e) => handleUnitChange(idx, "priceWholesale", parseFloat(e.target.value) || 0)}
                          className="h-8 text-xs mt-1 font-mono"
                          required
                        />
                      </div>

                      <div>
                        <Label className="text-[11px]">سعر التجزئة للمتجر (اختياري)</Label>
                        <Input
                          type="number"
                          step="any"
                          min="0"
                          placeholder="للنشر بالمتجر"
                          value={unit.priceRetail}
                          onChange={(e) => handleUnitChange(idx, "priceRetail", e.target.value)}
                          className="h-8 text-xs mt-1 font-mono"
                        />
                      </div>

                      <div>
                        <Label className="text-[11px]">تصنيف الباركود</Label>
                        <select
                          value={unit.barcodeSource}
                          onChange={(e) => handleUnitChange(idx, "barcodeSource", e.target.value)}
                          className="w-full h-8 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 mt-1"
                        >
                          <option value="">بدون تصنيف</option>
                          <option value="GS1">دولي (GS1 / EAN)</option>
                          <option value="INTERNAL">داخلي للمتجر (INTERNAL)</option>
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <Label className="text-[11px]">الباركود (Barcode)</Label>
                        <div className="flex items-center gap-1.5 mt-1">
                          <Input
                            placeholder="امسح أو أدخل الباركود"
                            value={unit.barcode}
                            onChange={(e) => {
                              handleUnitChange(idx, "barcode", e.target.value);
                              // Pass `idx` explicitly — the unit being
                              // typed into right now, not whatever
                              // activeUnitForScan last happened to be.
                              lookupBarcodeInCatalog(e.target.value, idx);
                            }}
                            className="h-8 text-xs font-mono"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setActiveUnitForScan(idx);
                              setScannerModalOpen(true);
                            }}
                            className="h-8 px-2.5 shrink-0 gap-1 text-xs"
                            title="مسح الكاميرا"
                          >
                            <Camera className="w-3.5 h-3.5 text-emerald-600" />
                            <span>كاميرا</span>
                          </Button>
                        </div>
                      </div>

                      <div>
                        <Label className="text-[11px]">صورة الوحدة/المنتج</Label>
                        <div className="flex items-center gap-1.5 mt-1">
                          <Input
                            placeholder="رابط الصورة"
                            value={unit.imageUrl}
                            onChange={(e) => handleUnitChange(idx, "imageUrl", e.target.value)}
                            className="h-8 text-xs truncate"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setActiveUnitForCrop(idx);
                              setCropModalOpen(true);
                            }}
                            className="h-8 px-2.5 shrink-0 gap-1 text-xs"
                            title="معالجة وقص الصورة"
                          >
                            <Crop className="w-3.5 h-3.5 text-blue-600" />
                            <span>قص</span>
                          </Button>
                        </div>
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

      {/* Barcode Scanner Modal */}
      <BarcodeScannerModal
        open={scannerModalOpen}
        onOpenChange={setScannerModalOpen}
        onScan={handleBarcodeScanResult}
      />

      {/* Image Crop Modal */}
      <ImageCropModal
        open={cropModalOpen}
        onOpenChange={setCropModalOpen}
        onCropComplete={handleCropResult}
      />

      {/* Shared Catalog Correction Report Modal */}
      {catalogInfo && (
        <CatalogReportModal
          // [FIX] `key={catalogInfo.id}` forces React to fully unmount and
          // remount this component whenever a DIFFERENT catalog entry is
          // matched (e.g. scanning a new barcode after cancelling a draft
          // report for a previous one) — see CatalogReportModal.tsx's own
          // comment for why this replaces an earlier useEffect-based reset
          // that triggered React's setState-in-effect warning.
          key={catalogInfo.id}
          open={reportModalOpen}
          onOpenChange={setReportModalOpen}
          catalogEntryId={catalogInfo.id}
          currentName={catalogInfo.name}
          currentCategory={catalogInfo.category || undefined}
        />
      )}
    </>
  );
}