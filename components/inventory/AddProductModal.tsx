/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, PackagePlus, Camera, Crop, AlertTriangle, CheckCircle2, Check } from "lucide-react";
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

const STEP_LABELS = ["المعلومات الأساسية", "الوحدات والأسعار", "المخزون الأولي"];

// Shared sizing classes: mobile-first at ~44px (comfortable tap target for
// a cashier/merchant using this on a phone with no laptop), shrinking back
// to the original compact desktop density at the sm: breakpoint.
const FIELD_H = "h-11 sm:h-8 text-sm sm:text-xs";
const FIELD_H_PROMINENT = "h-11 sm:h-9 text-sm mt-1"; // step-1 name/category
const BTN_H = "h-11 sm:h-8 text-sm sm:text-xs";

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

  // Wizard step. Keeping the same single <form> for the whole modal (so
  // handleSubmit's existing validation/payload logic doesn't need to be
  // split apart) — this just controls which section is visible and gates
  // the submit button to the last step.
  const [step, setStep] = useState<1 | 2 | 3>(1);

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
    setStep(1);
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

  // [FIX] Publishing to the storefront requires a product photo only.
  // priceWholesale is already required-and-positive on every unit (see
  // unitSchema in route.ts), so a publishable price is guaranteed by
  // construction — it never needs to be re-checked here. priceRetail is
  // a separate, optional "suggested resale price" hint (see the
  // ProductUnit.priceRetail comment in schema.prisma: shown to a buying
  // retailer as a marketing/profit-margin hint, never itself charged on
  // any sale, POS or storefront alike) and must NOT be a precondition for
  // publishing — a wholesaler who wants to list five cartons at plain
  // wholesale price, with no suggested retail number attached, must be
  // able to.
  const handleTogglePublic = (checked: boolean) => {
    if (checked) {
      const isPublishable = units.some(
        (u) => u.imageUrl && u.imageUrl.trim().length > 0
      );

      if (!isPublishable) {
        toast.error("لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج على الأقل لإحدى الوحدات.");
        setIsPublic(false);
        return;
      }
    }
    setIsPublic(checked);
  };

  // Per-step validation before advancing. This is a UX gate only — it
  // deliberately mirrors (a subset of) the checks already in handleSubmit
  // rather than replacing them, so the final submit stays the single
  // source of truth for "is this payload actually valid."
  const goNext = () => {
    if (step === 1) {
      if (!name.trim()) {
        toast.error("يرجى إدخال اسم المنتج قبل المتابعة.");
        return;
      }
    }

    if (step === 2) {
      if (units.some((u) => !u.unitName.trim() || u.conversionFactor <= 0 || u.priceWholesale <= 0)) {
        toast.error("يرجى التأكد من ملء جميع الوحدات بمعامل تحويل وسعر جملة أكبر من الصفر.");
        return;
      }
      const enteredBarcodes = units.map((u) => u.barcode.trim()).filter(Boolean);
      if (new Set(enteredBarcodes).size !== enteredBarcodes.length) {
        toast.error("لا يمكن استخدام نفس الباركود لأكثر من وحدة قياس ضمن المنتج نفسه.");
        return;
      }
    }

    setStep((s) => (s < 3 ? ((s + 1) as 1 | 2 | 3) : s));
  };

  const goBack = () => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s));

  // Enter-to-submit is the default behavior for inputs inside a <form>.
  // With three steps sharing one form, pressing Enter while on step 1 or 2
  // would otherwise silently submit early instead of advancing — block it
  // everywhere except the final step, where Enter submitting is expected.
  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter" && step !== 3) {
      e.preventDefault();
    }
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

    // [FIX] Same relaxed gate as handleTogglePublic — image only.
    if (isPublic) {
      const isPublishable = units.some(
        (u) => u.imageUrl && u.imageUrl.trim().length > 0
      );
      if (!isPublishable) {
        toast.error("شروط النشر بالمتجر غير مكتملة (تتطلب صورة للمنتج على الأقل).");
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
        {/*
          Mobile-first positioning: most merchants/cashiers on this project
          only have a phone (see project decision on mobile-first roles) —
          so on small screens this renders as a bottom sheet (pinned to the
          bottom edge, ~92% of viewport height, rounded top corners only),
          and reverts to a normal centered dialog at the sm: breakpoint and
          up. The base (mobile) position classes intentionally override
          the component's default centered-dialog classes via className
          merging; the sm: variants restore centered desktop positioning.
        */}
        <DialogContent
          className="
            fixed inset-x-0 bottom-0 top-auto left-0 right-0
            translate-x-0 translate-y-0
            w-full sm:w-auto
            max-w-full sm:max-w-3xl
            max-h-[92vh] sm:max-h-[90vh]
            rounded-t-2xl rounded-b-none sm:rounded-xl
            overflow-y-auto
            p-4 sm:p-6
            bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800
            sm:left-[50%] sm:right-auto sm:top-[50%]
            sm:-translate-x-1/2 sm:-translate-y-1/2
          "
          dir="rtl"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-bold">
              <PackagePlus className="w-5 h-5 text-emerald-600" />
              <span>إضافة منتج جديد متعدد الوحدات</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              أدخل بيانات المنتج، وحدات التعبئة (طرد / كرتونة / قطعة)، أسعار الجملة والتجزئة، وتصنيف الباركود.
            </DialogDescription>
          </DialogHeader>

          {/* Step indicator */}
          <div className="flex items-center justify-center gap-1.5 sm:gap-2 py-1">
            {STEP_LABELS.map((label, i) => {
              const stepNum = (i + 1) as 1 | 2 | 3;
              const isActive = stepNum === step;
              const isDone = stepNum < step;
              return (
                <div key={stepNum} className="flex items-center gap-1.5 sm:gap-2">
                  <div
                    className={`flex items-center justify-center w-7 h-7 sm:w-6 sm:h-6 rounded-full text-xs sm:text-[11px] font-bold border-2 shrink-0 transition-colors ${isActive
                      ? "bg-emerald-600 border-emerald-600 text-white"
                      : isDone
                        ? "bg-emerald-100 border-emerald-400 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                        : "bg-zinc-100 border-zinc-300 text-zinc-400 dark:bg-zinc-800 dark:border-zinc-700"
                      }`}
                  >
                    {isDone ? <Check className="w-4 h-4 sm:w-3.5 sm:h-3.5" /> : stepNum}
                  </div>
                  <span
                    className={`text-[11px] font-medium hidden sm:inline ${isActive ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500"
                      }`}
                  >
                    {label}
                  </span>
                  {stepNum < 3 && (
                    <div className={`w-5 sm:w-8 h-0.5 rounded ${isDone ? "bg-emerald-400" : "bg-zinc-200 dark:bg-zinc-700"}`} />
                  )}
                </div>
              );
            })}
          </div>

          <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} className="space-y-4 my-2 text-xs">
            {catalogInfo && (
              <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
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
                    className={`${BTN_H} border-blue-300 dark:border-blue-800 text-blue-800 dark:text-blue-300 gap-1 shrink-0 w-full sm:w-auto`}
                  >
                    <AlertTriangle className="w-3 h-3 text-amber-500" />
                    <span>تقديم اقتراح تصحيح</span>
                  </Button>
                )}
              </div>
            )}

            {/* STEP 1 — Basic info */}
            {step === 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                <div>
                  <Label className="text-xs font-semibold">اسم المنتج الرئيسي *</Label>
                  <Input
                    placeholder="مثال: زيت زيتون ممتاز 1 ليتر"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={FIELD_H_PROMINENT}
                    autoFocus
                    required
                  />
                </div>

                <div>
                  <Label className="text-xs font-semibold">التصنيف / الفئة</Label>
                  <Input
                    placeholder="مثال: زيوت ومواد غذائية"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className={FIELD_H_PROMINENT}
                  />
                </div>

              </div>
            )}

            {/* STEP 2 — Units & pricing */}
            {step === 2 && (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <Label className="font-bold text-sm text-zinc-900 dark:text-zinc-100">
                    وحدات التعبئة والأسعار (Packaging Units)
                  </Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddUnit}
                    className={`gap-1 ${BTN_H} border-emerald-600 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 w-full sm:w-auto`}
                  >
                    <Plus className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
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
                            className="h-9 w-9 sm:h-6 sm:w-6 p-0 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                          >
                            <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                          </Button>
                        )}
                      </div>

                      {/* Identity row: name / conversion factor / currency */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                        <div>
                          <Label className="text-[11px]">اسم الوحدة *</Label>
                          <Input
                            placeholder="مثال: قطعة / كرتونة / طرد"
                            value={unit.unitName}
                            onChange={(e) => handleUnitChange(idx, "unitName", e.target.value)}
                            className={`${FIELD_H} mt-1`}
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
                            className={`${FIELD_H} mt-1`}
                            required
                          />
                        </div>

                        <div>
                          <Label className="text-[11px]">العملة *</Label>
                          <select
                            value={unit.pricingCurrency}
                            onChange={(e) => handleUnitChange(idx, "pricingCurrency", e.target.value as "SYP" | "USD")}
                            className={`w-full ${FIELD_H} rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 mt-1`}
                          >
                            <option value="SYP">ليرة سورية (SYP)</option>
                            <option value="USD">دولار أمريكي (USD)</option>
                          </select>
                        </div>
                      </div>

                      {/* Pricing row: wholesale vs retail, visually separated since these are the two most-consulted fields */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/20">
                          {/* [FIX] Dynamic label — this field is the ONLY
                              price ever actually charged for THIS unit, on
                              POS and on the storefront alike
                              (ProductUnit.priceWholesale in schema.prisma).
                              For the base unit that's typically a single-
                              piece sale to a walk-in customer; for a
                              packaging unit it's the bulk/carton price.
                              Both are the same field — just labeled to
                              match what's actually being sold. */}
                          <Label className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-400">
                            {idx === 0 ? "سعر بيع القطعة (POS) *" : "سعر الجملة للوحدة (POS) *"}
                          </Label>
                          <Input
                            type="number"
                            step="any"
                            min="0.01"
                            value={unit.priceWholesale === 0 ? "" : unit.priceWholesale}
                            onChange={(e) => {
                              const raw = e.target.value;
                              handleUnitChange(idx, "priceWholesale", raw === "" ? 0 : parseFloat(raw));
                            }}
                            className={`${FIELD_H} mt-1 font-mono bg-white dark:bg-zinc-900`}
                            required
                          />
                        </div>

                        <div className="p-2.5 rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50/60 dark:bg-blue-950/20">
                          <Label className="text-[11px] font-semibold text-blue-800 dark:text-blue-400">
                            سعر التجزئة للمتجر (اختياري)
                          </Label>
                          <Input
                            type="number"
                            step="any"
                            min="0"
                            placeholder="للنشر بالمتجر"
                            value={unit.priceRetail}
                            onChange={(e) => handleUnitChange(idx, "priceRetail", e.target.value)}
                            className={`${FIELD_H} mt-1 font-mono bg-white dark:bg-zinc-900`}
                          />
                          {/* [FIX] Clarifies this number is never charged —
                              it's a display-only hint for the storefront
                              buyer, unrelated to what gets billed. */}
                          <p className="text-[10px] text-blue-600/80 dark:text-blue-400/70 mt-1 leading-snug">
                            سعر استرشادي يظهر لعميل المتجر الإلكتروني فقط — لا يُستخدم أبدًا كسعر فعلي عند البيع من الـ POS.
                          </p>
                        </div>
                      </div>

                      {/* Barcode row */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                        <div>
                          <Label className="text-[11px]">تصنيف الباركود</Label>
                          <select
                            value={unit.barcodeSource}
                            onChange={(e) => handleUnitChange(idx, "barcodeSource", e.target.value)}
                            className={`w-full ${FIELD_H} rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 mt-1`}
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
                              className={`${FIELD_H} font-mono`}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setActiveUnitForScan(idx);
                                setScannerModalOpen(true);
                              }}
                              className={`${BTN_H} px-3 sm:px-2.5 shrink-0 gap-1`}
                              title="مسح الكاميرا"
                            >
                              <Camera className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-emerald-600" />
                              <span>كاميرا</span>
                            </Button>
                          </div>
                        </div>
                      </div>

                      {/* Image row */}
                      <div>
                        <Label className="text-[11px]">صورة الوحدة/المنتج</Label>
                        <div className="flex items-center gap-1.5 mt-1">
                          <Input
                            placeholder="رابط الصورة"
                            value={unit.imageUrl}
                            onChange={(e) => handleUnitChange(idx, "imageUrl", e.target.value)}
                            className={`${FIELD_H} truncate`}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setActiveUnitForCrop(idx);
                              setCropModalOpen(true);
                            }}
                            className={`${BTN_H} px-3 sm:px-2.5 shrink-0 gap-1`}
                            title="معالجة وقص الصورة"
                          >
                            <Crop className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-blue-600" />
                            <span>قص</span>
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* STEP 3 — Initial stock + review */}
            {step === 3 && (
              <div className="space-y-3">
                <div className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 space-y-1">
                  <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">{name || "—"}</p>
                  {category && <p className="text-[11px] text-zinc-500">{category}</p>}
                  <p className="text-[11px] text-zinc-500">
                    {units.length} {units.length === 1 ? "وحدة قياس" : "وحدات قياس"} مُدخلة
                    {isPublic ? " · معروض في المتجر الإلكتروني" : ""}
                  </p>
                </div>

                {/* [MOVED FROM STEP 1] The storefront-publish toggle now
                    sits on the final review step, after the merchant has
                    already gone through step 2 and (ideally) attached a
                    photo to at least one unit. handleTogglePublic's gate
                    check is unchanged — this is purely a placement change
                    so the checkbox isn't reachable before any unit data
                    (and possibly no photo) exists yet. */}
                <div className="flex items-start gap-3 p-3 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900/40">
                  <input
                    type="checkbox"
                    id="is-public-toggle"
                    checked={isPublic}
                    onChange={(e) => handleTogglePublic(e.target.checked)}
                    className="mt-0.5 w-5 h-5 sm:w-4 sm:h-4 shrink-0 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div>
                    <Label htmlFor="is-public-toggle" className="cursor-pointer font-semibold text-xs text-zinc-800 dark:text-zinc-200">
                      عرض المنتج في متجر العملاء الإلكتروني
                    </Label>
                    <p className="text-[11px] text-zinc-500 mt-0.5">
                      يتطلب صورة للمنتج على الأقل لإحدى الوحدات — يمكن تفعيله لاحقًا من صفحة المنتج.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="has-batch"
                    checked={hasInitialBatch}
                    onChange={(e) => setHasInitialBatch(e.target.checked)}
                    className="w-5 h-5 sm:w-4 sm:h-4 shrink-0 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
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
                        className={`w-full ${FIELD_H} rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 mt-1`}
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
                        className={`${FIELD_H} mt-1`}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">الكمية المستلمة</Label>
                      <Input
                        type="number"
                        min="0"
                        value={batchQuantity}
                        onChange={(e) => setBatchQuantity(parseFloat(e.target.value) || 0)}
                        className={`${FIELD_H} mt-1`}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">تاريخ الانتهاء</Label>
                      <Input
                        type="date"
                        value={expiryDate}
                        onChange={(e) => setExpiryDate(e.target.value)}
                        className={`${FIELD_H} mt-1`}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/*
              Footer: stacked, full-width buttons on mobile with the
              primary action (Next / Save) last in DOM order so it sits at
              the bottom of the sheet — closest to a thumb holding the
              phone. Reverts to a compact inline row at sm: and up.
            */}
            <DialogFooter className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={loading}
                className="w-full sm:w-auto h-11 sm:h-9"
              >
                إلغاء
              </Button>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                {step > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={goBack}
                    disabled={loading}
                    className="w-full sm:w-auto h-11 sm:h-9"
                  >
                    رجوع
                  </Button>
                )}
                {step < 3 ? (
                  <Button
                    type="button"
                    onClick={goNext}
                    className="w-full sm:w-auto h-11 sm:h-9 bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    التالي
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full sm:w-auto h-11 sm:h-9 bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {loading ? "جاري الحفظ..." : "حفظ المنتج"}
                  </Button>
                )}
              </div>
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