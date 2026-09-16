/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Package,
  Layers,
  Plus,
  Trash2,
  Barcode as BarcodeIcon,
  Camera,
  Image as ImageIcon,
  AlertTriangle,
  Globe,
  Loader2,
  CheckCircle2,
  Flag,
} from "lucide-react";
import { toast } from "sonner";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ImageCropModal } from "@/components/inventory/ImageCropModal";
import { CatalogReportModal } from "@/components/inventory/CatalogReportModal";
import { BarcodeSourceModal, type BarcodeSourceChoice } from "@/components/inventory/BarcodeSourceModal";
import { validatePackagingUnits } from "@/lib/inventory/packaging-unit-validation";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
import type { ProductItem, UnitItem } from "@/components/inventory/ProductTable";

// [FIX] `[id]/route.ts`'s PATCH now validates conversionFactor/
// priceWholesale/priceRetail as decimal STRINGS (regex-checked, max 4
// decimal places), matching products/route.ts's POST — see that file's
// DECIMAL_STRING_REGEX note. This modal's internal state stays `number`
// (simplest for <input type="number"> controls), but every such value
// crossing into the PATCH payload must go through this helper rather than
// a raw `String(...)` cast: `String(0.1 + 0.2)` can produce floating-point
// noise ("0.30000000000000004") with more than 4 decimal digits, which
// would fail the backend's regex outright. `toFixed(4)` both rounds to the
// column's actual precision (Decimal(18,4)) and guarantees a plain,
// non-exponential decimal string. Non-finite input is coerced to "0"
// rather than emitting an invalid string like "NaN". Duplicated here
// (rather than shared with AddProductModal.tsx's identical helper) per
// the decision not to introduce a shared decimal-format module.
const toDecimalString = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(4);
};

export interface EditUnitForm {
  id?: string;
  unitName: string;
  conversionFactor: number;
  pricingCurrency: "SYP" | "USD";
  priceWholesale: number;
  priceRetail: number | "";
  barcode: string;
  barcodeSource: BarcodeSourceChoice | "";
  imageUrl: string;
  isActive: boolean;
}

export interface EditProductModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductItem | null;
  onSuccess: (updatedProduct: any) => void;
}

interface CatalogLookupResult {
  id: string;
  barcode: string;
  name: string;
  category: string | null;
  imageUrl: string | null;
  isOwner: boolean;
  targetUnitIndex: number;
}

export function EditProductModal({
  open,
  onOpenChange,
  product,
  onSuccess,
}: EditProductModalProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [units, setUnits] = useState<EditUnitForm[]>([]);
  const [saving, setSaving] = useState(false);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [catalogReportOpen, setCatalogReportOpen] = useState(false);
  const [activeUnitIndex, setActiveUnitIndex] = useState<number>(0);

  const [barcodeGate, setBarcodeGate] = useState<{
    unitIndex: number | null;
    barcode: string;
  }>({ unitIndex: null, barcode: "" });

  const [catalogInfo, setCatalogInfo] = useState<CatalogLookupResult | null>(null);

  const lookupAbortRef = useRef<AbortController | null>(null);

  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  const currentInitKey = open && product ? product.id : null;

  if (currentInitKey !== initializedFor) {
    setInitializedFor(currentInitKey);

    if (product) {
      setName(product.name || "");
      setCategory(product.category || "");
      setIsPublic(product.isPublic ?? false);
      setIsActive(product.isActive ?? true);

      const sortedUnits = [...(product.units || [])].sort(
        (a, b) => a.conversionFactor - b.conversionFactor
      );

      setUnits(
        sortedUnits.map((u) => ({
          id: u.id,
          unitName: u.unitName || "",
          conversionFactor: u.conversionFactor || 1,
          pricingCurrency: u.pricingCurrency || "SYP",
          priceWholesale: u.priceWholesale || 0,
          priceRetail: u.priceRetail !== null && u.priceRetail !== undefined ? u.priceRetail : "",
          barcode: u.barcode || "",
          barcodeSource: (u.barcodeSource as BarcodeSourceChoice) || "",
          imageUrl: u.imageUrl || "",
          isActive: u.isActive !== false,
        }))
      );
      setCatalogInfo(null);
      setBarcodeGate({ unitIndex: null, barcode: "" });
    }
  }

  const requestBarcodeClassification = (unitIndex: number, rawBarcode: string) => {
    const cleaned = rawBarcode.trim();

    if (!cleaned) {
      setUnits((prev) => {
        const next = [...prev];
        next[unitIndex] = { ...next[unitIndex], barcode: "", barcodeSource: "" };
        return next;
      });
      setCatalogInfo(null);
      return;
    }

    const currentUnit = units[unitIndex];
    if (currentUnit && currentUnit.barcode === cleaned && currentUnit.barcodeSource) {
      return;
    }

    setUnits((prev) => {
      const next = [...prev];
      next[unitIndex] = { ...next[unitIndex], barcodeSource: "" };
      return next;
    });

    setBarcodeGate({ unitIndex, barcode: cleaned });
    lookupBarcodeInCatalog(cleaned, unitIndex);
  };

  const handleBarcodeSourceConfirm = (source: BarcodeSourceChoice) => {
    const { unitIndex, barcode } = barcodeGate;
    if (unitIndex === null) return;

    setUnits((prev) => {
      const next = [...prev];
      next[unitIndex] = { ...next[unitIndex], barcode, barcodeSource: source };
      return next;
    });

    setBarcodeGate({ unitIndex: null, barcode: "" });
  };

  const handleBarcodeSourceDismiss = () => {
    const { unitIndex } = barcodeGate;
    if (unitIndex !== null) {
      setUnits((prev) => {
        const next = [...prev];
        next[unitIndex] = { ...next[unitIndex], barcode: "", barcodeSource: "" };
        return next;
      });
    }
    setBarcodeGate({ unitIndex: null, barcode: "" });
  };

  const lookupBarcodeInCatalog = async (barcode: string, targetUnitIndex: number) => {
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;

    try {
      const res = await fetch(`/api/catalog/lookup?barcode=${encodeURIComponent(barcode)}`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.entry) {
        setCatalogInfo({ ...data.entry, targetUnitIndex });
        toast.info(
          `تم العثور على هذا المنتج في الكتالوج المشترك (${data.entry.name}). يمكنك نسخ بياناته بنقرة واحدة.`
        );
      } else {
        setCatalogInfo(null);
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Error querying shared catalog:", err);
      }
    }
  };

  const applyCatalogSuggestion = () => {
    if (!catalogInfo) return;
    if (catalogInfo.name && !name) setName(catalogInfo.name);
    if (catalogInfo.category && !category) setCategory(catalogInfo.category);
    if (catalogInfo.imageUrl) {
      setUnits((prev) => {
        const next = [...prev];
        const idx = catalogInfo.targetUnitIndex;
        if (next[idx] && !next[idx].imageUrl) {
          next[idx] = { ...next[idx], imageUrl: catalogInfo.imageUrl! };
        }
        return next;
      });
    }
    toast.success("تم تطبيق بيانات الكتالوج المشترك بنجاح.");
  };

  const handleScanSuccess = (scannedCode: string) => {
    requestBarcodeClassification(activeUnitIndex, scannedCode);
    setScannerOpen(false);
  };

  const handleCropComplete = (uploadedUrl: string) => {
    setUnits((prev) => {
      const next = [...prev];
      if (next[activeUnitIndex]) {
        next[activeUnitIndex] = { ...next[activeUnitIndex], imageUrl: uploadedUrl };
      }
      return next;
    });
    setCropModalOpen(false);
    toast.success("تم تحديث صورة الوحدة بنجاح.");
  };

  const handleAddUnit = () => {
    if (units.length >= 5) {
      toast.error("الحد الأقصى لوحدات التعبئة هو 5 وحدات.");
      return;
    }
    const highestFactor = Math.max(...units.map((u) => u.conversionFactor || 1), 1);
    setUnits((prev) => [
      ...prev,
      {
        unitName: "",
        conversionFactor: highestFactor * 6,
        pricingCurrency: prev[0]?.pricingCurrency || "SYP",
        priceWholesale: 0,
        priceRetail: "",
        barcode: "",
        barcodeSource: "",
        imageUrl: "",
        isActive: true,
      },
    ]);
  };

  const handleRemoveUnit = (index: number) => {
    if (index === 0) {
      toast.error("لا يمكن حذف الوحدة الأساسية.");
      return;
    }
    setUnits((prev) => prev.filter((_, i) => i !== index));
  };

  const handleToggleUnitActive = (index: number) => {
    setUnits((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], isActive: !next[index].isActive };
      return next;
    });
  };

  const handleToggleIsPublic = (checked: boolean) => {
    if (checked) {
      const candidateUnits = units.map((u) => ({
        isActive: u.isActive,
        priceRetail: u.priceRetail === "" ? null : Number(u.priceRetail),
        imageUrl: u.imageUrl || null,
      }));

      const gate = checkProductPublishable({
        isActive,
        units: candidateUnits,
      });

      if (!gate.publishable) {
        toast.error(`لا يمكن نشر المنتج: ${gate.reason}`);
        return;
      }
    }
    setIsPublic(checked);
  };

  const handleSave = async () => {
    if (!product) return;

    if (!name.trim()) {
      toast.error("اسم المنتج مطلوب.");
      return;
    }

    // [FIX — GAP CLOSED] AddProductModal.tsx already enforces this exact
    // check (in both goNext's step-2 gate and handleSubmit) — priceWholesale
    // is the ONLY figure ever used to bill a sale (POS or B2B alike, per
    // T1), so a unit reaching submit with priceWholesale <= 0 must be
    // rejected here too. This modal previously had NO such check: the
    // backend's own validator (nonNegativeDecimalString, [id]/route.ts)
    // accepts priceWholesale === 0, and validatePackagingUnits()
    // deliberately does not check priceWholesale at all (see that file's
    // own VALIDATION SCOPE NOTE — it is intentionally out of that
    // function's scope, left to each call site). Without this check, an
    // ADMIN editing an existing unit through this screen could save a
    // priceWholesale of 0 with nothing anywhere rejecting it, producing a
    // unit sellable at zero cost on the POS.
    if (units.some((u) => !u.unitName.trim() || u.conversionFactor <= 0 || u.priceWholesale <= 0)) {
      toast.error("يرجى التأكد من ملء جميع الوحدات بمعامل تحويل وسعر جملة أكبر من الصفر.");
      return;
    }

    const packagingValidation = validatePackagingUnits(
      units.map((u) => ({
        ...u,
        priceRetail: u.priceRetail === "" ? null : u.priceRetail,
      }))
    );
    if (!packagingValidation.valid) {
      toast.error(packagingValidation.error);
      return;
    }

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.barcode.trim() && !u.barcodeSource) {
        toast.error(`الوحدة "${u.unitName || i + 1}": يجب تحديد مصدر الباركود (GS1 أو INTERNAL).`);
        requestBarcodeClassification(i, u.barcode);
        return;
      }
    }

    if (isPublic) {
      const candidateUnits = units.map((u) => ({
        isActive: u.isActive,
        priceRetail: u.priceRetail === "" ? null : Number(u.priceRetail),
        imageUrl: u.imageUrl || null,
      }));
      const gate = checkProductPublishable({
        isActive,
        units: candidateUnits,
      });
      if (!gate.publishable) {
        toast.error(`لا يمكن تفعيل النشر: ${gate.reason}`);
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        category: category.trim() || null,
        isPublic,
        isActive,
        // [FIX] conversionFactor/priceWholesale/priceRetail now sent as
        // decimal strings via toDecimalString — matches [id]/route.ts's
        // PATCH schema. Was previously sending raw numbers
        // (`u.conversionFactor`, `Number(u.priceWholesale) || 0`, etc.).
        units: units.map((u) => ({
          ...(u.id ? { id: u.id } : {}),
          unitName: u.unitName.trim(),
          conversionFactor: toDecimalString(Number(u.conversionFactor)),
          pricingCurrency: u.pricingCurrency,
          priceWholesale: toDecimalString(Number(u.priceWholesale) || 0),
          priceRetail:
            u.priceRetail === "" || u.priceRetail === null
              ? null
              : toDecimalString(Number(u.priceRetail)),
          barcode: u.barcode.trim() || null,
          barcodeSource: u.barcode.trim() ? u.barcodeSource : null,
          imageUrl: u.imageUrl.trim() || null,
          isActive: u.isActive,
        })),
      };

      const res = await fetch(`/api/inventory/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "فشل حفظ التعديلات.");
      }

      toast.success("تم تحديث بيانات المنتج ووحداته بنجاح.");
      onSuccess(data.product);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء حفظ التعديلات.");
    } finally {
      setSaving(false);
    }
  };

  if (!product) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          dir="rtl"
          className="max-w-3xl max-h-[90vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-bold">
              <Package className="w-5 h-5 text-emerald-600" />
              <span>تعديل المنتج ووحدات التعبئة</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              تعديل بيانات المنتج، أسعار ووحدات التعبئة، وحالة النشر بالمتجر العام وفق بوابة النشر.
            </DialogDescription>
          </DialogHeader>

          {catalogInfo && (
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg flex items-center justify-between gap-2 text-xs">
              <div className="space-y-0.5">
                <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                  متوفر في الكتالوج المشترك:
                </span>{" "}
                <span className="text-emerald-700 dark:text-emerald-400">
                  {catalogInfo.name} {catalogInfo.category ? `(${catalogInfo.category})` : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={applyCatalogSuggestion}
                  className="h-7 text-xs border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                >
                  نسخ البيانات
                </Button>
                {!catalogInfo.isOwner && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCatalogReportOpen(true)}
                    className="h-7 text-xs text-amber-700 hover:bg-amber-100 gap-1"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>إبلاغ عن خطأ</span>
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className="space-y-6 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-name" className="text-xs font-semibold">
                  اسم المنتج <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: شاي سيلاني فاخر"
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-category" className="text-xs font-semibold">
                  التصنيف
                </Label>
                <Input
                  id="edit-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="مثال: مشروبات ساخنة"
                  className="text-xs"
                />
              </div>
            </div>

            <div className="p-4 bg-zinc-50 dark:bg-zinc-800/40 rounded-xl border border-zinc-200 dark:border-zinc-800 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Switch
                    id="edit-is-active"
                    checked={isActive}
                    onCheckedChange={setIsActive}
                  />
                  <div>
                    <Label htmlFor="edit-is-active" className="text-xs font-semibold cursor-pointer">
                      حالة تفعيل المنتج
                    </Label>
                    <p className="text-[11px] text-zinc-500">
                      تعطيل المنتج يخفيه من نقاط البيع والمتجر دون المساس بالكميات أو بحالات الوحدات السابقة.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 border-t sm:border-t-0 sm:border-r border-zinc-200 dark:border-zinc-700 pt-2 sm:pt-0 sm:pr-4">
                  <Switch
                    id="edit-is-public"
                    checked={isPublic}
                    onCheckedChange={handleToggleIsPublic}
                  />
                  <div>
                    <Label htmlFor="edit-is-public" className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer">
                      <Globe className="w-3.5 h-3.5 text-blue-600" />
                      <span>النشر بالمتجر العام</span>
                    </Label>
                    <p className="text-[11px] text-zinc-500">
                      يتطلب وجود سعر تجزئة وصورة لوحدة قياس نشطة واحدة على الأقل.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold flex items-center gap-2">
                    <Layers className="w-4 h-4 text-emerald-600" />
                    <span>محرك وحدات التعبئة والتغليف</span>
                  </h3>
                  <p className="text-[11px] text-zinc-500">
                    حدد الوحدة الأساسية (معامل = 1) والوحدات الثانوية/الثلاثية مع أسعار الجملة والتجزئة.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddUnit}
                  className="h-8 text-xs gap-1 border-emerald-300 text-emerald-800 hover:bg-emerald-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>إضافة وحدة</span>
                </Button>
              </div>

              <div className="space-y-3">
                {units.map((unit, index) => {
                  const isBase = index === 0;
                  return (
                    <div
                      key={unit.id || index}
                      className={`p-3.5 rounded-xl border transition-all ${!unit.isActive
                        ? "bg-zinc-100/60 dark:bg-zinc-900/60 border-zinc-300 opacity-75"
                        : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm"
                        }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-zinc-100 dark:border-zinc-800 mb-3">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={isBase ? "default" : "secondary"}
                            className="text-[10px]"
                          >
                            {isBase ? "الوحدة الأساسية" : `وحدة فرعية (${index + 1})`}
                          </Badge>
                          {!unit.isActive && (
                            <Badge variant="destructive" className="text-[10px]">
                              معطلة
                            </Badge>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => handleToggleUnitActive(index)}
                            className="h-6 text-[10px] px-2 text-zinc-600 hover:text-zinc-900"
                          >
                            {unit.isActive ? "تعطيل الوحدة" : "تفعيل الوحدة"}
                          </Button>
                          {!isBase && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => handleRemoveUnit(index)}
                              className="h-6 w-6 p-0 text-red-500 hover:bg-red-50"
                              title="حذف الوحدة"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                        <div>
                          <Label className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                            اسم الوحدة <span className="text-red-500">*</span>
                          </Label>
                          <Input
                            value={unit.unitName}
                            onChange={(e) => {
                              const next = [...units];
                              next[index].unitName = e.target.value;
                              setUnits(next);
                            }}
                            placeholder={isBase ? "مثال: قطعة" : "مثال: طرد"}
                            className="h-8 text-xs mt-1"
                          />
                        </div>

                        <div>
                          <Label className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                            معامل التحويل (إلى الأساسية)
                          </Label>
                          <Input
                            type="number"
                            step="any"
                            min="0.0001"
                            disabled={isBase}
                            value={unit.conversionFactor}
                            onChange={(e) => {
                              const val = Math.max(0.0001, parseFloat(e.target.value) || 1);
                              const next = [...units];
                              next[index].conversionFactor = val;
                              setUnits(next);
                            }}
                            className="h-8 text-xs mt-1"
                          />
                        </div>

                        <div>
                          <Label className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                            عملة التسعير
                          </Label>
                          <select
                            value={unit.pricingCurrency}
                            onChange={(e) => {
                              const next = [...units];
                              next[index].pricingCurrency = e.target.value as "SYP" | "USD";
                              setUnits(next);
                            }}
                            className="h-8 w-full border border-zinc-200 dark:border-zinc-700 rounded-md px-2 text-xs bg-white dark:bg-zinc-900 mt-1"
                          >
                            <option value="SYP">ل.س (SYP)</option>
                            <option value="USD">دولار ($ USD)</option>
                          </select>
                        </div>

                        <div>
                          <Label className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                            سعر الجملة <span className="text-red-500">*</span>
                          </Label>
                          <Input
                            type="number"
                            min="0"
                            value={unit.priceWholesale}
                            onChange={(e) => {
                              const next = [...units];
                              next[index].priceWholesale = Number(e.target.value) || 0;
                              setUnits(next);
                            }}
                            className="h-8 text-xs mt-1"
                          />
                        </div>

                        <div>
                          <Label className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                            سعر التجزئة (مطلوب للنشر)
                          </Label>
                          <Input
                            type="number"
                            min="0"
                            value={unit.priceRetail}
                            onChange={(e) => {
                              const next = [...units];
                              next[index].priceRetail = e.target.value === "" ? "" : Number(e.target.value);
                              setUnits(next);
                            }}
                            placeholder="اختياري"
                            className="h-8 text-xs mt-1"
                          />
                        </div>

                        <div>
                          <Label className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                            الباركود ومصدره
                          </Label>
                          <div className="flex items-center gap-1.5 mt-1">
                            <div className="relative flex-1">
                              <Input
                                value={unit.barcode}
                                onBlur={(e) => requestBarcodeClassification(index, e.target.value)}
                                onChange={(e) => {
                                  const next = [...units];
                                  next[index].barcode = e.target.value;
                                  setUnits(next);
                                }}
                                placeholder="امسح أو اكتب الباركود..."
                                className="h-8 text-xs pl-7"
                              />
                              <BarcodeIcon className="w-3.5 h-3.5 absolute left-2 top-2.5 text-zinc-400" />
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setActiveUnitIndex(index);
                                setScannerOpen(true);
                              }}
                              className="h-8 px-2 border-zinc-300"
                              title="مسح بالكاميرا"
                            >
                              <Camera className="w-3.5 h-3.5 text-zinc-600" />
                            </Button>
                          </div>
                          {unit.barcode && unit.barcodeSource && (
                            <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
                              <span>المصدر:</span>
                              <Badge variant="outline" className="text-[9px] px-1 py-0">
                                {unit.barcodeSource}
                              </Badge>
                            </div>
                          )}
                          {unit.barcode && !unit.barcodeSource && (
                            <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-600">
                              <AlertTriangle className="w-3 h-3" />
                              <button
                                type="button"
                                onClick={() => requestBarcodeClassification(index, unit.barcode)}
                                className="underline hover:text-amber-700 font-medium"
                              >
                                اضغط لتصنيف مصدر الباركود
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <Label className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                            صورة الوحدة:
                          </Label>
                          {unit.imageUrl ? (
                            <div className="flex items-center gap-2">
                              <Image
                                src={unit.imageUrl}
                                alt="معاينة"
                                width={28}
                                height={28}
                                unoptimized
                                className="w-7 h-7 object-cover rounded border"
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  const next = [...units];
                                  next[index].imageUrl = "";
                                  setUnits(next);
                                }}
                                className="h-6 text-[10px] text-red-500 hover:bg-red-50"
                              >
                                إزالة
                              </Button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-zinc-400">لا توجد صورة</span>
                          )}
                        </div>

                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setActiveUnitIndex(index);
                            setCropModalOpen(true);
                          }}
                          className="h-7 text-xs gap-1 border-zinc-300"
                        >
                          <ImageIcon className="w-3.5 h-3.5" />
                          <span>{unit.imageUrl ? "تغيير الصورة" : "رفع وقص صورة"}</span>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-3 border-t border-zinc-100 dark:border-zinc-800">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="text-xs"
            >
              إلغاء
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs gap-1.5"
            >
              {saving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>جاري الحفظ...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>حفظ التعديلات</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {barcodeGate.unitIndex !== null && (
        <BarcodeSourceModal
          key={`${barcodeGate.unitIndex}-${barcodeGate.barcode}`}
          open={barcodeGate.unitIndex !== null}
          barcode={barcodeGate.barcode}
          onConfirm={handleBarcodeSourceConfirm}
          onDismiss={handleBarcodeSourceDismiss}
          catalogMatch={
            catalogInfo && catalogInfo.targetUnitIndex === barcodeGate.unitIndex && catalogInfo.barcode === barcodeGate.barcode
              ? { name: catalogInfo.name }
              : null
          }
        />
      )}

      <BarcodeScannerModal
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onScan={handleScanSuccess}
      />

      <ImageCropModal
        open={cropModalOpen}
        onOpenChange={setCropModalOpen}
        onCropComplete={handleCropComplete}
      />

      {catalogInfo && (
        <CatalogReportModal
          key={catalogInfo.id}
          open={catalogReportOpen}
          onOpenChange={setCatalogReportOpen}
          catalogEntryId={catalogInfo.id}
          currentName={catalogInfo.name}
          currentCategory={catalogInfo.category ?? undefined}
        />
      )}
    </>
  );
}