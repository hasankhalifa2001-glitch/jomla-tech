/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Plus, Trash2, PackagePlus, Camera, Crop, AlertTriangle, CheckCircle2, Check, ScanBarcode, ShieldAlert, Search, Info, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ImageCropModal } from "@/components/inventory/ImageCropModal";
import { CatalogReportModal } from "@/components/inventory/CatalogReportModal";
import { BarcodeSourceModal, type BarcodeSourceChoice } from "@/components/inventory/BarcodeSourceModal";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
// lib/inventory/packaging-unit-validation.ts was deleted when
// validatePackagingUnits() was merged into lib/inventory/units.ts (see
// that file's header FIX #3 note) — every former importer, including this
// component, now imports it from there instead. The old path no longer
// resolves to anything and previously broke the build/dev server on this
// file ("Module not found").
import { validatePackagingUnits } from "@/lib/inventory/units";
import m from "./modals.module.css";

// products/route.ts's POST now requires conversionFactor/priceWholesale/
// priceRetail/initialBatch.quantity as validated DECIMAL STRINGS
// (regex-checked, max 4 decimal places) rather than JSON numbers — see
// that file's DECIMAL_STRING_REGEX note. This component's internal state
// stays `number` (simplest for <input type="number"> controls), but every
// value crossing into the API payload must go through this helper rather
// than a raw `Number(...)`/`String(...)` cast:
//   - `String(0.1 + 0.2)` can produce floating-point noise like
//     "0.30000000000000004", which has more than 4 decimal digits and
//     would fail the backend's regex outright.
//   - `toFixed(4)` both rounds to the column's actual precision
//     (Decimal(18,4)) and guarantees a plain, non-exponential decimal
//     string, matching the regex `^-?\d{1,14}(\.\d{1,4})?$` in every case.
// Non-finite input (a NaN slipping through a bad parseFloat) is coerced to
// "0" rather than emitting an invalid string like "NaN".
const toDecimalString = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(4);
};

interface UnitForm {
  unitName: string;
  conversionFactor: number;
  pricingCurrency: "SYP" | "USD";
  priceWholesale: number;
  priceRetail: number | "";
  barcode: string;
  // "" is the UNCONFIRMED state, distinct from both "GS1" and "INTERNAL".
  // "" is NEVER silently coerced into "INTERNAL" anywhere downstream —
  // see handleSubmit and the barcode-commit flow below. A unit may
  // legally reach submit time with barcode: "" AND barcodeSource: ""
  // together (no barcode at all — fine); it may NEVER reach submit time
  // with a non-empty barcode paired with barcodeSource: "" (an
  // unconfirmed classification) — that combination is actively prevented
  // at every point a barcode value can be set, not just checked-for at
  // the end.
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
    // Unit 0 is always the product's base unit (T3a §0: the first unit
    // entered at creation automatically becomes Product.baseUnitId, with
    // conversionFactor locked to 1). Previously only `units.length <= 1`
    // was guarded against — nothing stopped removing index 0 specifically
    // when 2+ units existed. Doing so left the array's NEW index 0 (the
    // old index 1) displayed as "الوحدة الأساسية" with its
    // conversionFactor field forced to show "1" and disabled (`idx === 0`
    // in the JSX below) — while the underlying state for that unit still
    // held its real, original factor (e.g. 6). The user could never fix
    // this (the field is disabled), and validatePackagingUnits() would
    // then fail with "يجب تحديد وحدة أساسية واحدة بمعامل تحويل يساوي 1"
    // even though the screen showed a "1". This guard makes index-0
    // removal impossible regardless of caller, as defense in depth
    // alongside hiding the delete button for idx === 0 in the JSX below.
    if (index === 0) {
      toast.error("لا يمكن حذف الوحدة الأساسية — هي المرجع الذي تُحسب عليه كل الوحدات الأخرى.");
      return;
    }

    if (units.length <= 1) {
      toast.error("يجب الإبقاء على وحدة قياس واحدة على الأقل.");
      return;
    }
    const updated = units.filter((_, i) => i !== index);
    setUnits(updated);

    if (index <= batchUnitIndex) {
      setBatchUnitIndex(0);
    }

    // Previously only cleared the gate when `barcodeGate.unitIndex ===
    // index` (an exact match). If the gate was open for a LATER unit
    // (e.g. unitIndex: 2) and an EARLIER unit was removed (index: 1),
    // every index after the removed one shifts down by one in the new
    // array — but the gate's stored unitIndex was left unchanged,
    // pointing at the wrong unit (or, if it was the last one, out of
    // bounds). Fixed to shift the index down when it's past the removed
    // position, and only clear it on an exact match.
    setBarcodeGate((prev) => {
      if (prev.unitIndex === null) return prev;
      if (prev.unitIndex === index) return { unitIndex: null, barcode: "" };
      if (prev.unitIndex > index) return { ...prev, unitIndex: prev.unitIndex - 1 };
      return prev;
    });
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
      // Also close the classification gate if it was open for this exact
      // unit — previously only the unit's own barcode/barcodeSource
      // fields were cleared, but a still-open BarcodeSourceModal (opened
      // for the barcode value that just got erased) could be left
      // pointing at a barcode that no longer exists on this unit.
      if (barcodeGate.unitIndex === unitIndex) {
        setBarcodeGate({ unitIndex: null, barcode: "" });
      }
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
        // Every field the backend validates as a decimal string
        // (conversionFactor, priceWholesale, priceRetail) now goes
        // through `toDecimalString` instead of `Number(...)` — see the
        // helper's comment above for why a plain String()/Number() cast
        // is unsafe here. `pricingCurrency`/`barcode`/`barcodeSource`/
        // `imageUrl` are untouched — none of those are Decimal-backed
        // columns.
        units: units.map((u) => ({
          unitName: u.unitName.trim(),
          conversionFactor: toDecimalString(Number(u.conversionFactor)),
          pricingCurrency: u.pricingCurrency,
          priceWholesale: toDecimalString(Number(u.priceWholesale)),
          priceRetail: u.priceRetail !== "" ? toDecimalString(Number(u.priceRetail)) : null,
          barcode: u.barcode.trim() || null,
          barcodeSource: u.barcode.trim() ? (u.barcodeSource as "GS1" | "INTERNAL") : null,
          imageUrl: u.imageUrl.trim() || null,
        })),
        initialBatch: hasInitialBatch
          ? {
            unitIndex: batchUnitIndex,
            batchNumber: batchNumber.trim() || `BATCH-${Date.now().toString().slice(-6)}`,
            // Same reasoning — initialBatch.quantity is validated as a
            // nonNegativeDecimalString on the backend now too.
            quantity: toDecimalString(Number(batchQuantity)),
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
          <div className={m.m}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg font-bold">
                <PackagePlus className={`w-5 h-5 ${m.titleIcon}`} aria-hidden />
                <span>إضافة منتج جديد متعدد الوحدات</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-500">
                أدخل بيانات المنتج، وحدات التعبئة (طرد / كرتونة / قطعة)، أسعار الجملة والتجزئة، وتصنيف الباركود.
              </DialogDescription>
            </DialogHeader>

            <div className={m.steps}>
              {STEP_LABELS.map((label, i) => {
                const stepNum = (i + 1) as 1 | 2 | 3;
                const isActive = stepNum === step;
                const isDone = stepNum < step;
                return (
                  <div key={stepNum} className={m.stepItem}>
                    <div className={`${m.stepDot} ${isActive ? m.stepDotActive : isDone ? m.stepDotDone : ""}`}>
                      {isDone ? <Check size={14} aria-hidden /> : stepNum}
                    </div>
                    <span className={`${m.stepLabel} ${isActive ? m.stepLabelActive : ""}`}>{label}</span>
                    {stepNum < 3 && <div className={`${m.stepBar} ${isDone ? m.stepBarDone : ""}`} />}
                  </div>
                );
              })}
            </div>

            <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} className={m.form}>
              {catalogInfo && (
                <div className={m.boxBlue}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <CheckCircle2 size={16} color="#2563eb" aria-hidden style={{ flexShrink: 0 }} />
                    <div>
                      <p style={{ fontWeight: 800, color: "#1e3a8a" }}>تم جلب البيانات من الكتالوج المشترك (GS1)</p>
                      <p style={{ fontSize: "0.6875rem", color: "#1d4ed8" }}>
                        المنتج: {catalogInfo.name} {catalogInfo.category ? `(${catalogInfo.category})` : ""}
                      </p>
                    </div>
                  </div>
                  {!catalogInfo.isOwner && (
                    <button
                      type="button"
                      onClick={() => setReportModalOpen(true)}
                      className={`${m.btn} ${m.btnSm} ${m.btnOutlineBlue} ${m.btnFull}`}
                    >
                      <AlertTriangle size={12} color="#f59e0b" aria-hidden />
                      <span>تقديم اقتراح تصحيح</span>
                    </button>
                  )}
                </div>
              )}

              {step === 1 && (
                <div className={m.stack}>
                  <div className={m.boxDashedEmerald}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <ScanBarcode size={20} className={m.titleIcon} style={{ marginTop: 2 }} aria-hidden />
                      <div>
                        <p style={{ fontWeight: 800, color: "#065f46" }}>عندك المنتج قدّامك؟ اكتب أو امسح الباركود أولاً</p>
                        <p style={{ fontSize: "0.6875rem", color: "#047857cc" }}>
                          إذا كان مسجّلاً في الكتالوج المشترك، سيتم تعبئة الاسم والتصنيف تلقائياً
                        </p>
                      </div>
                    </div>

                    <div className={m.inputRow}>
                      <input
                        type="text"
                        placeholder="اكتب الباركود هنا يدوياً..."
                        value={pendingQuickScanBarcode}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPendingQuickScanBarcode(val);
                          setQuickScanConsumed(false);
                          setQuickLookupState("idle");
                        }}
                        className={`${m.input} ${m.inputMono}`}
                      />
                      <button
                        type="button"
                        onClick={() => runQuickCatalogCheck()}
                        disabled={!pendingQuickScanBarcode.trim() || quickLookupState === "loading"}
                        className={`${m.btn} ${m.btnSm} ${m.btnOutlineEmerald}`}
                      >
                        <Search size={14} aria-hidden />
                        <span>{quickLookupState === "loading" ? "جارِ التحقق..." : "تحقق"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setQuickScanModalOpen(true)}
                        className={`${m.btn} ${m.btnSm} ${m.btnOutlineEmerald}`}
                        title="مسح الكاميرا"
                      >
                        <Camera size={14} className={m.titleIcon} aria-hidden />
                        <span>كاميرا</span>
                      </button>
                    </div>

                    {quickLookupState === "loading" && (
                      <p className={m.statusRow}>
                        <RefreshCw size={12} className={m.spin} aria-hidden />
                        <span>جارِ البحث في الكتالوج المشترك...</span>
                      </p>
                    )}
                    {quickLookupState === "found" && catalogInfo && (
                      <p className={`${m.statusRow} ${m.statusOk}`}>
                        <CheckCircle2 size={14} aria-hidden />
                        <span>
                          تم العثور على هذا الباركود في الكتالوج المشترك: &quot;{catalogInfo.name}&quot; — تم تعبئة الاسم/التصنيف تلقائياً.
                        </span>
                      </p>
                    )}
                    {quickLookupState === "not_found" && (
                      <p className={m.statusRow}>
                        <Info size={14} aria-hidden />
                        <span>هذا الباركود غير مسجّل في الكتالوج المشترك بعد — سيُعتبر منتجاً جديداً، تابع إدخال البيانات يدوياً.</span>
                      </p>
                    )}
                  </div>

                  <div className={`${m.grid2} ${m.box}`}>
                    <div className={m.field}>
                      <label className={m.label}>اسم المنتج الرئيسي *</label>
                      <input
                        type="text"
                        placeholder="مثال: زيت زيتون ممتاز 1 ليتر"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className={`${m.input} ${m.inputProminent}`}
                        autoFocus
                        required
                      />
                    </div>

                    <div className={m.field}>
                      <label className={m.label}>التصنيف / الفئة</label>
                      <input
                        type="text"
                        placeholder="مثال: زيوت ومواد غذائية"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className={`${m.input} ${m.inputProminent}`}
                      />
                    </div>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className={m.stack}>
                  <div className={m.footerRow} style={{ paddingTop: 0 }}>
                    <label className={m.labelMd}>وحدات التعبئة والأسعار (Packaging Units)</label>
                    <button
                      type="button"
                      onClick={handleAddUnit}
                      className={`${m.btn} ${m.btnSm} ${m.btnOutlineEmerald} ${m.btnFull}`}
                    >
                      <Plus size={14} aria-hidden />
                      <span>إضافة وحدة فرعية/ثانوية</span>
                    </button>
                  </div>

                  <div className={m.stack}>
                    {units.map((unit, idx) => {
                      const isPendingClassification = barcodeGate.unitIndex === idx;
                      return (
                        <div key={idx} className={m.unitBox}>
                          <div className={m.unitBoxHead}>
                            <span>{idx === 0 ? "الوحدة الأساسية (Base Unit)" : `وحدة تجميعية #${idx + 1}`}</span>
                            {/* Was `units.length > 1` only, which let the
                                base unit (idx 0) be deleted whenever a
                                second unit existed. The base unit can
                                never be removed (T3a §0) — see
                                handleRemoveUnit()'s matching guard above,
                                kept as defense in depth. */}
                            {idx !== 0 && units.length > 1 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveUnit(idx)}
                                className={`${m.btn} ${m.btnXs} ${m.btnGhostRed}`}
                                aria-label="حذف الوحدة"
                              >
                                <Trash2 size={14} aria-hidden />
                              </button>
                            )}
                          </div>

                          <div className={m.grid3}>
                            <div className={m.field}>
                              <label className={m.label}>اسم الوحدة *</label>
                              <input
                                type="text"
                                placeholder="مثال: قطعة / كرتونة / طرد"
                                value={unit.unitName}
                                onChange={(e) => handleUnitChange(idx, "unitName", e.target.value)}
                                className={m.input}
                                required
                              />
                            </div>

                            <div className={m.field}>
                              <label className={m.label}>معامل التحويل (عدد الوحدات الأساسية) *</label>
                              <input
                                type="number"
                                step="any"
                                min="0.0001"
                                disabled={idx === 0}
                                value={idx === 0 ? 1 : unit.conversionFactor}
                                onChange={(e) => {
                                  // Was `parseFloat(e.target.value) || 1`.
                                  // Since `0` is falsy in JS, the very
                                  // first keystroke of any fractional
                                  // value under 1 (e.g. typing "0" on the
                                  // way to "0.25") was immediately
                                  // snapped back to "1", making it
                                  // practically impossible to type a
                                  // fractional conversionFactor — even
                                  // though fractional factors are
                                  // explicitly allowed (a wholesaler
                                  // selling a quarter- or half-carton).
                                  // Fixed to only fall back when the
                                  // parsed value isn't a real number at
                                  // all (e.g. an empty string);
                                  // validatePackagingUnits() below
                                  // already rejects a submitted value
                                  // <= 0, so no separate floor is needed
                                  // here.
                                  const parsed = parseFloat(e.target.value);
                                  handleUnitChange(idx, "conversionFactor", Number.isFinite(parsed) ? parsed : 0);
                                }}
                                className={m.input}
                                required
                              />
                            </div>

                            <div className={m.field}>
                              <label className={m.label}>العملة *</label>
                              <select
                                value={unit.pricingCurrency}
                                onChange={(e) => handleUnitChange(idx, "pricingCurrency", e.target.value as "SYP" | "USD")}
                                className={m.select}
                              >
                                <option value="SYP">ليرة سورية (SYP)</option>
                                <option value="USD">دولار أمريكي (USD)</option>
                              </select>
                            </div>
                          </div>

                          <div className={m.grid2}>
                            <div className={m.priceBoxEmerald}>
                              <label className={m.label} style={{ color: "#065f46" }}>
                                {idx === 0 ? "سعر بيع القطعة (POS) *" : "سعر الجملة للوحدة (POS) *"}
                              </label>
                              <input
                                type="number"
                                step="any"
                                min="0.01"
                                value={unit.priceWholesale === 0 ? "" : unit.priceWholesale}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  handleUnitChange(idx, "priceWholesale", raw === "" ? 0 : parseFloat(raw));
                                }}
                                className={`${m.input} ${m.inputMono}`}
                                style={{ marginTop: 4, background: "#fff" }}
                                required
                              />
                            </div>

                            <div className={m.priceBoxBlue}>
                              <label className={m.label} style={{ color: "#1d4ed8" }}>
                                سعر التجزئة للمتجر (اختياري)
                              </label>
                              <input
                                type="number"
                                step="any"
                                min="0"
                                placeholder="للنشر بالمتجر"
                                value={unit.priceRetail}
                                onChange={(e) => handleUnitChange(idx, "priceRetail", e.target.value)}
                                className={`${m.input} ${m.inputMono}`}
                                style={{ marginTop: 4, background: "#fff" }}
                              />
                              <p className={m.hintBlue}>
                                سعر استرشادي يظهر لعميل المتجر الإلكتروني فقط — لا يُستخدم أبدًا كسعر فعلي عند البيع من الـ POS.
                              </p>
                            </div>
                          </div>

                          <div>
                            <div className={m.grid3}>
                              <div className={m.field}>
                                <label className={m.label}>تصنيف الباركود</label>
                                <div
                                  className={`${m.pill} ${unit.barcodeSource === "GS1"
                                      ? m.pillGs1
                                      : unit.barcodeSource === "INTERNAL"
                                        ? m.pillInternal
                                        : unit.barcode.trim()
                                          ? m.pillPending
                                          : ""
                                    }`}
                                >
                                  {unit.barcode.trim() && !unit.barcodeSource && <ShieldAlert size={14} aria-hidden />}
                                  <span className={m.pillText}>
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
                              <div className={m.field} style={{ gridColumn: "span 2" }}>
                                <label className={m.label}>الباركود (Barcode)</label>
                                <div className={m.inputRow}>
                                  <input
                                    type="text"
                                    placeholder="امسح أو أدخل الباركود"
                                    value={unit.barcode}
                                    onChange={(e) => handleUnitChange(idx, "barcode", e.target.value)}
                                    onBlur={(e) => requestBarcodeClassification(idx, e.target.value)}
                                    className={`${m.input} ${m.inputMono}`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveUnitForScan(idx);
                                      setScannerModalOpen(true);
                                    }}
                                    className={`${m.btn} ${m.btnSm} ${m.btnOutline}`}
                                    title="مسح الكاميرا"
                                  >
                                    <Camera size={14} className={m.titleIcon} aria-hidden />
                                    <span>كاميرا</span>
                                  </button>
                                </div>
                              </div>
                            </div>
                            {isPendingClassification && (
                              <p className={m.pendingNote}>
                                <ShieldAlert size={12} aria-hidden />
                                <span>بانتظار تأكيد مصدر الباركود في النافذة المنبثقة...</span>
                              </p>
                            )}
                          </div>

                          <div className={m.field}>
                            <label className={m.label}>صورة الوحدة/المنتج</label>
                            <div className={m.inputRow}>
                              <input
                                type="text"
                                placeholder="رابط الصورة"
                                value={unit.imageUrl}
                                onChange={(e) => handleUnitChange(idx, "imageUrl", e.target.value)}
                                className={m.input}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveUnitForCrop(idx);
                                  setCropModalOpen(true);
                                }}
                                className={`${m.btn} ${m.btnSm} ${m.btnOutline}`}
                                title="معالجة وقص الصورة"
                              >
                                <Crop size={14} color="#2563eb" aria-hidden />
                                <span>قص</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {step === 3 && (
                <div className={m.stack}>
                  <div className={m.summaryBox}>
                    <p className={m.summaryName}>{name || "—"}</p>
                    {category && <p className={m.summaryMeta}>{category}</p>}
                    <p className={m.summaryMeta}>
                      {units.length} {units.length === 1 ? "وحدة قياس" : "وحدات قياس"} مُدخلة
                      {isPublic ? " · معروض في المتجر الإلكتروني" : ""}
                    </p>
                  </div>

                  <div className={m.checkRow}>
                    <input
                      type="checkbox"
                      id="is-public-toggle"
                      checked={isPublic}
                      onChange={(e) => handleTogglePublic(e.target.checked)}
                      className={m.checkbox}
                    />
                    <div>
                      <label htmlFor="is-public-toggle" className={m.labelMd} style={{ cursor: "pointer" }}>
                        عرض المنتج في متجر العملاء الإلكتروني
                      </label>
                      <p className={m.summaryMeta} style={{ marginTop: 2 }}>
                        يتطلب صورة وسعر تجزئة أكبر من صفر لوحدة نشطة واحدة على الأقل — يمكن تفعيله لاحقًا من صفحة المنتج.
                      </p>
                    </div>
                  </div>

                  <div className={m.checkRowSimple}>
                    <input
                      type="checkbox"
                      id="has-batch"
                      checked={hasInitialBatch}
                      onChange={(e) => setHasInitialBatch(e.target.checked)}
                      className={m.checkbox}
                    />
                    <label htmlFor="has-batch" className={m.labelMd} style={{ cursor: "pointer" }}>
                      إضافة دفعة مخزونية أولية فوراً
                    </label>
                  </div>

                  {hasInitialBatch && (
                    <div className={`${m.grid2} ${m.priceBoxEmerald}`}>
                      <div className={m.field}>
                        <label className={m.label}>الوحدة المستلمة</label>
                        <select
                          value={batchUnitIndex}
                          onChange={(e) => setBatchUnitIndex(parseInt(e.target.value))}
                          className={m.select}
                          style={{ background: "#fff" }}
                        >
                          {units.map((u, i) => (
                            <option key={i} value={i}>
                              {u.unitName} (معامل {u.conversionFactor})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={m.field}>
                        <label className={m.label}>رقم الدفعة</label>
                        <input
                          type="text"
                          placeholder="مثال: BATCH-2026-001"
                          value={batchNumber}
                          onChange={(e) => setBatchNumber(e.target.value)}
                          className={m.input}
                          style={{ background: "#fff" }}
                        />
                      </div>
                      <div className={m.field}>
                        <label className={m.label}>الكمية المستلمة</label>
                        <input
                          type="number"
                          min="0"
                          value={batchQuantity}
                          onChange={(e) => setBatchQuantity(parseFloat(e.target.value) || 0)}
                          className={m.input}
                          style={{ background: "#fff" }}
                        />
                      </div>
                      <div className={m.field}>
                        <label className={m.label}>تاريخ الانتهاء</label>
                        <input
                          type="date"
                          value={expiryDate}
                          onChange={(e) => setExpiryDate(e.target.value)}
                          className={m.input}
                          style={{ background: "#fff" }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <DialogFooter>
                <div className={m.footerRow} style={{ width: "100%" }}>
                  <button
                    type="button"
                    onClick={() => handleOpenChange(false)}
                    disabled={loading}
                    className={`${m.btn} ${m.btnOutline} ${m.btnFull}`}
                  >
                    إلغاء
                  </button>
                  <div className={m.footerGroup}>
                    {step > 1 && (
                      <button
                        key="back-btn"
                        type="button"
                        onClick={goBack}
                        disabled={loading}
                        className={`${m.btn} ${m.btnOutline} ${m.btnFull}`}
                      >
                        رجوع
                      </button>
                    )}
                    {step < 3 ? (
                      <button key="next-btn" type="button" onClick={goNext} className={`${m.btn} ${m.btnSolid} ${m.btnFull}`}>
                        التالي
                      </button>
                    ) : (
                      <button key="submit-btn" type="submit" disabled={loading} className={`${m.btn} ${m.btnSolid} ${m.btnFull}`}>
                        {loading ? "جاري الحفظ..." : "حفظ المنتج"}
                      </button>
                    )}
                  </div>
                </div>
              </DialogFooter>
            </form>
          </div>
        </DialogContent>
      </Dialog>

      <BarcodeScannerModal open={scannerModalOpen} onOpenChange={setScannerModalOpen} onScan={handleBarcodeScanResult} />

      <BarcodeScannerModal open={quickScanModalOpen} onOpenChange={setQuickScanModalOpen} onScan={handleQuickScanResult} />

      <ImageCropModal open={cropModalOpen} onOpenChange={setCropModalOpen} onCropComplete={handleCropResult} />

      <BarcodeSourceModal
        key={barcodeGate.unitIndex !== null ? `${barcodeGate.unitIndex}-${barcodeGate.barcode}` : "closed"}
        open={barcodeGate.unitIndex !== null}
        barcode={barcodeGate.barcode}
        onConfirm={handleBarcodeSourceConfirm}
        onDismiss={handleBarcodeSourceDismiss}
        catalogMatch={catalogInfo && catalogInfo.barcode === barcodeGate.barcode ? { name: catalogInfo.name } : null}
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