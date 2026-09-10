/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, PackagePlus, Camera, Crop, AlertTriangle, CheckCircle2, Check, ScanBarcode, ShieldAlert, Search, Info, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ImageCropModal } from "@/components/inventory/ImageCropModal";
import { CatalogReportModal } from "@/components/inventory/CatalogReportModal";
import { BarcodeSourceModal, type BarcodeSourceChoice } from "@/components/inventory/BarcodeSourceModal";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
import { validatePackagingUnits } from "@/lib/inventory/conversions";

interface UnitForm {
  unitName: string;
  conversionFactor: number;
  pricingCurrency: "SYP" | "USD";
  priceWholesale: number;
  priceRetail: number | "";
  barcode: string;
  // [FIX] "" is the UNCONFIRMED state, distinct from both "GS1" and
  // "INTERNAL". Unlike the previous version of this file, "" is NEVER
  // silently coerced into "INTERNAL" anywhere downstream — see
  // handleSubmit and the barcode-commit flow below. A unit may legally
  // reach submit time with barcode: "" AND barcodeSource: "" together
  // (no barcode at all — fine); it may NEVER reach submit time with a
  // non-empty barcode paired with barcodeSource: "" (an unconfirmed
  // classification) — that combination is actively prevented at every
  // point a barcode value can be set, not just checked-for at the end.
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

  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [scannerModalOpen, setScannerModalOpen] = useState(false);
  const [activeUnitForScan, setActiveUnitForScan] = useState<number>(0);

  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [activeUnitForCrop, setActiveUnitForCrop] = useState<number>(0);

  const [catalogInfo, setCatalogInfo] = useState<CatalogEntryInfo | null>(null);
  const [reportModalOpen, setReportModalOpen] = useState(false);

  const [quickScanModalOpen, setQuickScanModalOpen] = useState(false);
  const [pendingQuickScanBarcode, setPendingQuickScanBarcode] = useState<string>("");
  const [quickScanConsumed, setQuickScanConsumed] = useState(false);
  const [quickLookupState, setQuickLookupState] = useState<"idle" | "loading" | "found" | "not_found">("idle");

  const [barcodeGate, setBarcodeGate] = useState<{
    unitIndex: number | null;
    barcode: string;
  }>({ unitIndex: null, barcode: "" });

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
    setPendingQuickScanBarcode("");
    setQuickScanConsumed(false);
    setBarcodeGate({ unitIndex: null, barcode: "" });
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      resetForm();
    }
    onOpenChange(isOpen);
  };

  // [FIX] Previously assigned a FIXED `conversionFactor: 12` to every new
  // unit regardless of how many units already existed — adding two
  // secondary units in the same session silently created a duplicate
  // conversionFactor (12, 12), which now gets rejected by
  // validatePackagingUnits (per the confirmed no-duplicate-factors rule)
  // only at final submit, with no earlier signal to the merchant about
  // which two units conflict. Mirrors EditProductModal.tsx's own
  // `highestFactor * 6` pattern instead: each new unit's factor is always
  // strictly greater than every existing unit's factor, so two
  // auto-generated units can never collide with each other. A merchant
  // can still manually edit the value afterward into an accidental
  // duplicate — that case is now caught immediately at the Step 2 gate
  // (see goNext below) rather than silently reaching submit.
  const handleAddUnit = () => {
    if (units.length >= 5) {
      toast.error("الحد الأقصى لوحدات التعبئة هو 5 وحدات.");
      return;
    }
    const highestFactor = Math.max(...units.map((u) => u.conversionFactor || 1), 1);
    setUnits([
      ...units,
      {
        unitName: "",
        conversionFactor: highestFactor * 6,
        pricingCurrency: units[0]?.pricingCurrency || "SYP",
        priceWholesale: 0,
        priceRetail: "",
        barcode: "",
        barcodeSource: "",
        imageUrl: "",
      },
    ]);
  };

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

    if (barcodeGate.unitIndex === index) {
      setBarcodeGate({ unitIndex: null, barcode: "" });
    }
  };

  const handleUnitChange = (index: number, field: keyof UnitForm, value: any) => {
    const updated = [...units];
    updated[index] = { ...updated[index], [field]: value };
    setUnits(updated);
  };

  const requestBarcodeClassification = (unitIndex: number, rawBarcode: string) => {
    const cleaned = rawBarcode.trim();

    if (!cleaned) {
      const updated = [...units];
      updated[unitIndex] = { ...updated[unitIndex], barcode: "", barcodeSource: "" };
      setUnits(updated);
      setCatalogInfo(null);
      return;
    }

    const currentUnit = units[unitIndex];
    if (currentUnit && currentUnit.barcode === cleaned && currentUnit.barcodeSource) {
      return;
    }

    const updated = [...units];
    updated[unitIndex] = { ...updated[unitIndex], barcodeSource: "" };
    setUnits(updated);

    setBarcodeGate({ unitIndex, barcode: cleaned });
    lookupBarcodeInCatalog(cleaned, unitIndex);
  };

  const handleBarcodeSourceConfirm = (source: BarcodeSourceChoice) => {
    const { unitIndex, barcode } = barcodeGate;
    if (unitIndex === null) return;

    setUnits((prev) => {
      const updated = [...prev];
      updated[unitIndex] = { ...updated[unitIndex], barcode, barcodeSource: source };
      return updated;
    });

    setBarcodeGate({ unitIndex: null, barcode: "" });
  };

  const handleBarcodeSourceDismiss = () => {
    const { unitIndex } = barcodeGate;
    if (unitIndex !== null) {
      setUnits((prev) => {
        const updated = [...prev];
        updated[unitIndex] = { ...updated[unitIndex], barcode: "", barcodeSource: "" };
        return updated;
      });
    }
    setBarcodeGate({ unitIndex: null, barcode: "" });
  };

  const lookupBarcodeInCatalog = (barcodeVal: string, targetUnitIndex: number) => {
    if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);

    const cleanBarcode = barcodeVal.trim();
    if (!cleanBarcode) {
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
      }
    }, 300);
  };

  const handleBarcodeScanResult = (scannedBarcode: string) => {
    requestBarcodeClassification(activeUnitForScan, scannedBarcode);
  };

  const handleCropResult = (croppedDataUrl: string) => {
    const updated = [...units];
    updated[activeUnitForCrop] = {
      ...updated[activeUnitForCrop],
      imageUrl: croppedDataUrl,
    };
    setUnits(updated);
  };

  const runQuickCatalogCheck = async (barcodeOverride?: string) => {
    const cleaned = (barcodeOverride ?? pendingQuickScanBarcode).trim();
    if (!cleaned) {
      toast.error("يرجى إدخال أو مسح باركود أولاً.");
      return;
    }

    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;

    setQuickLookupState("loading");
    try {
      const res = await fetch(`/api/catalog/lookup?barcode=${encodeURIComponent(cleaned)}`, {
        signal: controller.signal,
      });
      const data = await res.json();

      if (res.ok && data.success && data.entry) {
        setCatalogInfo(data.entry);
        if (data.entry.name) setName((prev) => prev || data.entry.name);
        if (data.entry.category) setCategory((prev) => prev || data.entry.category);
        setQuickLookupState("found");
      } else {
        setCatalogInfo(null);
        setQuickLookupState("not_found");
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setQuickLookupState("idle");
      toast.error("تعذّر الاتصال بالكتالوج المشترك، يرجى المحاولة مجدداً.");
    }
  };

  const handleQuickScanResult = (scannedBarcode: string) => {
    const cleaned = scannedBarcode.trim();
    setPendingQuickScanBarcode(cleaned);
    setQuickScanConsumed(false);
    setQuickLookupState("idle");
    runQuickCatalogCheck(cleaned);
  };

  const handleTogglePublic = (checked: boolean) => {
    if (checked) {
      const candidateUnits = units.map((u) => ({
        isActive: true,
        priceRetail: u.priceRetail === "" ? null : Number(u.priceRetail),
        imageUrl: u.imageUrl || null,
      }));

      const gate = checkProductPublishable({
        isActive: true,
        units: candidateUnits,
      });

      if (!gate.publishable) {
        toast.error(`لا يمكن نشر المنتج: ${gate.reason}`);
        return;
      }
    }
    setIsPublic(checked);
  };

  const goNext = () => {
    if (step === 1) {
      if (!name.trim()) {
        toast.error("يرجى إدخال اسم المنتج قبل المتابعة.");
        return;
      }

      if (pendingQuickScanBarcode && !quickScanConsumed) {
        setQuickScanConsumed(true);
        requestBarcodeClassification(0, pendingQuickScanBarcode);
      }
    }

    if (step === 2) {
      if (units.some((u) => !u.unitName.trim() || u.conversionFactor <= 0 || u.priceWholesale <= 0)) {
        toast.error("يرجى التأكد من ملء جميع الوحدات بمعامل تحويل وسعر جملة أكبر من الصفر.");
        return;
      }

      // [FIX — new] Delegates base-unit-required and no-duplicate-factor
      // checks to the single shared implementation in unit-conversion.ts,
      // instead of relying only on the per-field checks above (which never
      // caught a duplicate conversionFactor or a missing/extra base unit).
      // Surfaces the problem right here at Step 2, before the merchant
      // fills in Step 3 and only discovers it at final submit.
      const packagingCheck = validatePackagingUnits(
        units.map((u) => ({
          ...u,
          priceRetail: u.priceRetail === "" ? null : u.priceRetail,
        }))
      );
      if (!packagingCheck.valid) {
        toast.error(packagingCheck.error);
        return;
      }

      const enteredBarcodes = units.map((u) => u.barcode.trim()).filter(Boolean);
      if (new Set(enteredBarcodes).size !== enteredBarcodes.length) {
        toast.error("لا يمكن استخدام نفس الباركود لأكثر من وحدة قياس ضمن المنتج نفسه.");
        return;
      }
      if (barcodeGate.unitIndex !== null) {
        toast.error("يرجى إكمال تصنيف مصدر الباركود المعلّق قبل المتابعة.");
        return;
      }
      const hasUnclassified = units.some((u) => u.barcode.trim() && !u.barcodeSource);
      if (hasUnclassified) {
        toast.error("يوجد باركود بدون تصنيف مصدر — يرجى إعادة إدخاله لتصنيفه.");
        return;
      }
    }

    setStep((s) => (s < 3 ? ((s + 1) as 1 | 2 | 3) : s));
  };

  const goBack = () => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s));

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

    // [FIX — new] Same shared validation as goNext's Step 2 gate, run
    // again here as the final backstop before submit — mirrors how the
    // barcode-classification check below is also duplicated between
    // goNext and handleSubmit for the same reason: the Step gate is a UX
    // convenience, this is the actual source of truth right before the
    // request is sent.
    const packagingCheck = validatePackagingUnits(
      units.map((u) => ({
        ...u,
        priceRetail: u.priceRetail === "" ? null : u.priceRetail,
      }))
    );
    if (!packagingCheck.valid) {
      toast.error(packagingCheck.error);
      setStep(2);
      return;
    }

    const enteredBarcodes = units.map((u) => u.barcode.trim()).filter(Boolean);
    if (new Set(enteredBarcodes).size !== enteredBarcodes.length) {
      toast.error("لا يمكن استخدام نفس الباركود لأكثر من وحدة قياس ضمن المنتج نفسه.");
      return;
    }

    const hasUnclassifiedBarcode = units.some((u) => u.barcode.trim() && !u.barcodeSource);
    if (hasUnclassifiedBarcode) {
      toast.error("يوجد باركود واحد أو أكثر بدون تصنيف مصدر (GS1/داخلي) مؤكد. يرجى إعادة إدخاله لإكمال التصنيف.");
      setStep(2);
      return;
    }

    if (hasInitialBatch && (!batchQuantity || batchQuantity <= 0)) {
      toast.error("يرجى إدخال كمية أكبر من الصفر للدفعة المخزونية الأولية، أو إلغاء تفعيلها.");
      return;
    }

    if (isPublic) {
      const candidateUnits = units.map((u) => ({
        isActive: true,
        priceRetail: u.priceRetail === "" ? null : Number(u.priceRetail),
        imageUrl: u.imageUrl || null,
      }));
      const gate = checkProductPublishable({ isActive: true, units: candidateUnits });
      if (!gate.publishable) {
        toast.error(`لا يمكن نشر المنتج: ${gate.reason}`);
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
          barcodeSource: u.barcode.trim() ? (u.barcodeSource as "GS1" | "INTERNAL") : null,
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

            {step === 1 && (
              <div className="space-y-3">
                <div className="p-3 rounded-lg border border-dashed border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 space-y-2">
                  <div className="flex items-start gap-2.5">
                    <ScanBarcode className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-bold text-emerald-800 dark:text-emerald-400">
                        عندك المنتج قدّامك؟ اكتب أو امسح الباركود أولاً
                      </p>
                      <p className="text-[11px] text-emerald-700/80 dark:text-emerald-500/80">
                        إذا كان مسجّلاً في الكتالوج المشترك، سيتم تعبئة الاسم والتصنيف تلقائياً
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Input
                      placeholder="اكتب الباركود هنا يدوياً..."
                      value={pendingQuickScanBarcode}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPendingQuickScanBarcode(val);
                        setQuickScanConsumed(false);
                        setQuickLookupState("idle");
                      }}
                      className={`${FIELD_H} font-mono bg-white dark:bg-zinc-900`}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => runQuickCatalogCheck()}
                      disabled={!pendingQuickScanBarcode.trim() || quickLookupState === "loading"}
                      className={`${BTN_H} px-3 shrink-0 gap-1 border-emerald-400 text-emerald-700 dark:text-emerald-400 disabled:opacity-40`}
                    >
                      <Search className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                      <span>{quickLookupState === "loading" ? "جارِ التحقق..." : "تحقق"}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setQuickScanModalOpen(true)}
                      className={`${BTN_H} px-3 sm:px-2.5 shrink-0 gap-1 border-emerald-300 dark:border-emerald-800`}
                      title="مسح الكاميرا"
                    >
                      <Camera className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-emerald-600" />
                      <span>كاميرا</span>
                    </Button>
                  </div>

                  {quickLookupState === "loading" && (
                    <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>جارِ البحث في الكتالوج المشترك...</span>
                    </p>
                  )}
                  {quickLookupState === "found" && catalogInfo && (
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        تم العثور على هذا الباركود في الكتالوج المشترك: &quot;{catalogInfo.name}&quot; — تم تعبئة الاسم/التصنيف تلقائياً.
                      </span>
                    </p>
                  )}
                  {quickLookupState === "not_found" && (
                    <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                      <Info className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        هذا الباركود غير مسجّل في الكتالوج المشترك بعد — سيُعتبر منتجاً جديداً، تابع إدخال البيانات يدوياً.
                      </span>
                    </p>
                  )}
                </div>

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
              </div>
            )}

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
                  {units.map((unit, idx) => {
                    const isPendingClassification = barcodeGate.unitIndex === idx;
                    return (
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

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <div className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/20">
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
                            <p className="text-[10px] text-blue-600/80 dark:text-blue-400/70 mt-1 leading-snug">
                              سعر استرشادي يظهر لعميل المتجر الإلكتروني فقط — لا يُستخدم أبدًا كسعر فعلي عند البيع من الـ POS.
                            </p>
                          </div>
                        </div>

                        <div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                            <div>
                              <Label className="text-[11px]">تصنيف الباركود</Label>
                              <div
                                className={`w-full ${FIELD_H} mt-1 rounded-md border flex items-center px-2 gap-1.5 ${unit.barcodeSource === "GS1"
                                  ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                                  : unit.barcodeSource === "INTERNAL"
                                    ? "border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400"
                                    : unit.barcode.trim()
                                      ? "border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
                                      : "border-zinc-200 dark:border-zinc-800 text-zinc-400"
                                  }`}
                              >
                                {unit.barcode.trim() && !unit.barcodeSource && (
                                  <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                                )}
                                <span className="truncate">
                                  {unit.barcodeSource === "GS1"
                                    ? "دولي (GS1)"
                                    : unit.barcodeSource === "INTERNAL"
                                      ? "داخلي"
                                      : unit.barcode.trim()
                                        ? "بانتظار التصنيف..."
                                        : "بدون باركود"}
                                </span>
                              </div>
                            </div>
                            <div className="sm:col-span-2">
                              <Label className="text-[11px]">الباركود (Barcode)</Label>
                              <div className="flex items-center gap-1.5 mt-1">
                                <Input
                                  placeholder="امسح أو أدخل الباركود"
                                  value={unit.barcode}
                                  onChange={(e) => handleUnitChange(idx, "barcode", e.target.value)}
                                  onBlur={(e) => requestBarcodeClassification(idx, e.target.value)}
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
                          {isPendingClassification && (
                            <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                              <ShieldAlert className="w-3 h-3" />
                              <span>بانتظار تأكيد مصدر الباركود في النافذة المنبثقة...</span>
                            </p>
                          )}
                        </div>

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
                    );
                  })}
                </div>
              </div>
            )}

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
                      يتطلب صورة وسعر تجزئة أكبر من صفر لوحدة نشطة واحدة على الأقل — يمكن تفعيله لاحقًا من صفحة المنتج.
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
                    key="back-btn"
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
                    key="next-btn"
                    type="button"
                    onClick={goNext}
                    className="w-full sm:w-auto h-11 sm:h-9 bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    التالي
                  </Button>
                ) : (
                  <Button
                    key="submit-btn"
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

      <BarcodeScannerModal
        open={scannerModalOpen}
        onOpenChange={setScannerModalOpen}
        onScan={handleBarcodeScanResult}
      />

      <BarcodeScannerModal
        open={quickScanModalOpen}
        onOpenChange={setQuickScanModalOpen}
        onScan={handleQuickScanResult}
      />

      <ImageCropModal
        open={cropModalOpen}
        onOpenChange={setCropModalOpen}
        onCropComplete={handleCropResult}
      />

      <BarcodeSourceModal
        key={barcodeGate.unitIndex !== null ? `${barcodeGate.unitIndex}-${barcodeGate.barcode}` : "closed"}
        open={barcodeGate.unitIndex !== null}
        barcode={barcodeGate.barcode}
        onConfirm={handleBarcodeSourceConfirm}
        onDismiss={handleBarcodeSourceDismiss}
        catalogMatch={
          catalogInfo && catalogInfo.barcode === barcodeGate.barcode
            ? { name: catalogInfo.name }
            : null
        }
      />

      {catalogInfo && (
        <CatalogReportModal
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