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
  Globe,
  Loader2,
  CheckCircle2,
  Flag,
} from "lucide-react";
import { toast } from "sonner";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ImageCropModal } from "@/components/inventory/ImageCropModal";
import { CatalogReportModal } from "@/components/inventory/CatalogReportModal";
import {
  BarcodeSourceModal,
  type BarcodeSourceChoice,
  type BarcodeSourceCandidate,
  type BarcodeSourceSelection,
} from "@/components/inventory/BarcodeSourceModal";
// [FIX] lib/inventory/packaging-unit-validation.ts was deleted when
// validatePackagingUnits() was merged into lib/inventory/units.ts. This
// file was still importing from the deleted path — same fix already
// applied to AddProductModal.tsx.
import { validatePackagingUnits } from "@/lib/inventory/units";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
import type { ProductItem } from "@/components/inventory/ProductTable";

// [FIX] `[id]/route.ts`'s PATCH validates conversionFactor/priceWholesale
// as decimal STRINGS (regex-checked, max 4 decimal places).
// This modal's internal state stays `number`, but every such value
// crossing into the PATCH payload must go through this helper rather than
// a raw `String(...)` cast — see AddProductModal.tsx's identical helper
// for the full reasoning (floating-point noise, regex compliance).
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
  // [v4.5] `id` is present for an ALREADY-SAVED barcode row (which is what the
  // ADMIN-only DELETE route needs to remove it) and absent for one the
  // merchant just added in this session (which the PATCH creates on save).
  barcodes: Array<{ id?: string; barcode: string; barcodeSource: BarcodeSourceChoice }>;
  // [v4.5] Transient text in this unit's barcode input — never submitted; a
  // confirmed value moves into `barcodes` above, and a dismissed one is
  // discarded entirely (spec: "the barcode value itself is also not saved").
  barcodeDraft: string;
  // [v4.6] imageUrl removed — the image lives on the Product, not on individual units.
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
  const [imageUrl, setImageUrl] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [units, setUnits] = useState<EditUnitForm[]>([]);
  const [saving, setSaving] = useState(false);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [catalogReportOpen, setCatalogReportOpen] = useState(false);
  const [activeUnitIndex, setActiveUnitIndex] = useState<number>(0);

  // [v4.5 UX] Barcodes collected by the camera in continuous mode; classified
  // together, in ONE confirmation modal, when the scanner closes. The ref
  // mirrors the state so the scanner's (ref-held) onScan callback never reads a
  // stale list while scans arrive quickly.
  const [scanBuffer, setScanBuffer] = useState<string[]>([]);
  const scanBufferRef = useRef<string[]>([]);

  const [barcodeGate, setBarcodeGate] = useState<{
    unitIndex: number | null;
    // [v4.5] The NEW barcodes awaiting classification in this one action.
    candidates: BarcodeSourceCandidate[];
  }>({ unitIndex: null, candidates: [] });

  const [catalogInfo, setCatalogInfo] = useState<CatalogLookupResult | null>(null);

  const lookupAbortRef = useRef<AbortController | null>(null);
  // [v4.5 UX] Per-unit barcode inputs, so focus can return to the field after a
  // confirmation (back-to-back hardware scanning without re-clicking).
  const barcodeInputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  const currentInitKey = open && product ? product.id : null;

  if (currentInitKey !== initializedFor) {
    setInitializedFor(currentInitKey);

    if (product) {
      setName(product.name || "");
      setCategory(product.category || "");
      setImageUrl(product.imageUrl || "");
      setIsPublic(product.isPublic ?? false);
      setIsActive(product.isActive ?? true);

      // [FIX] Explicit numeric coercion. The API consistently returns
      // conversionFactor/priceWholesale as strings (Decimal
      // precision fields); `Number(...)` here makes the local state genuinely
      // match its declared type regardless of whether the API sends a string
      // or a number.
      //
      // [FIX — base unit ordering] The BASE unit must be index 0 (the rest of
      // this screen treats `index === 0` as "the base unit": locked factor, no
      // delete). Sorting by conversionFactor alone put a fractional non-base
      // unit (e.g. a half-carton, factor 0.5) BEFORE the base unit (factor 1),
      // so the wrong unit was locked. The server's own `isBaseUnit` flag now
      // decides (falling back to factor === 1 for a response that lacks it),
      // and the remaining units follow in ascending factor order.
      const isBaseRow = (u: any) =>
        u.isBaseUnit !== undefined ? !!u.isBaseUnit : Number(u.conversionFactor) === 1;
      const sortedUnits = [...(product.units || [])].sort((a: any, b: any) => {
        const aBase = isBaseRow(a);
        const bBase = isBaseRow(b);
        if (aBase !== bBase) return aBase ? -1 : 1;
        return Number(a.conversionFactor) - Number(b.conversionFactor);
      });

      setUnits(
        sortedUnits.map((u) => ({
          id: u.id,
          unitName: u.unitName || "",
          conversionFactor: Number(u.conversionFactor) || 1,
          pricingCurrency: u.pricingCurrency || "SYP",
          priceWholesale: Number(u.priceWholesale) || 0,
          // [v4.5] The unit's saved barcodes (each with its row id, so the
          // ADMIN-only DELETE route can remove one) — the scalar
          // `barcode`/`barcodeSource` pair is only a fallback for a response
          // cached by an older client build.
          barcodes:
            u.barcodes && u.barcodes.length > 0
              ? u.barcodes.map((b) => ({
                id: b.id,
                barcode: b.barcode,
                barcodeSource: (b.barcodeSource as BarcodeSourceChoice) || "INTERNAL",
              }))
              : u.barcode
                ? [
                  {
                    barcode: u.barcode,
                    barcodeSource: (u.barcodeSource as BarcodeSourceChoice) || "INTERNAL",
                  },
                ]
                : [],
          barcodeDraft: "",
          isActive: u.isActive !== false,
        }))
      );
      setCatalogInfo(null);
      setBarcodeGate({ unitIndex: null, candidates: [] });
    }
  }

  /** Every barcode already on this form's units (persisted or just added). */
  const allBarcodesOnForm = (source: EditUnitForm[]) =>
    source.flatMap((u) => u.barcodes.map((b) => b.barcode));

  /**
   * [v4.5] Splits one input/paste into individual barcode values — `;`, tab and
   * newline are the separators, mirroring the CSV import and AddProductModal.
   */
  const splitBarcodeInput = (raw: string): string[] =>
    raw
      .split(/[;\n\t]+/)
      .map((v) => v.trim())
      .filter(Boolean);

  const clearUnitBarcodeDraft = (unitIndex: number) => {
    setUnits((prev) => {
      const next = [...prev];
      if (next[unitIndex]) {
        next[unitIndex] = { ...next[unitIndex], barcodeDraft: "" };
      }
      return next;
    });
    setBarcodeGate((prev) =>
      prev.unitIndex === unitIndex ? { unitIndex: null, candidates: [] } : prev
    );
  };

  const focusBarcodeInput = (unitIndex: number) => {
    // Next tick: the confirmation dialog has to finish closing (and release its
    // focus trap) before focus can land back on the input.
    setTimeout(() => barcodeInputRefs.current[unitIndex]?.focus(), 60);
  };

  const requestBarcodeClassification = (unitIndex: number, rawValue: string) => {
    // [UX] A classification session is already open — never re-open or replace
    // it (an Enter followed by a stray second event would otherwise remount the
    // modal and wipe the merchant's clicks).
    if (barcodeGate.unitIndex !== null) return;

    // [v4.5 — FIX, mirrors AddProductModal.tsx] Deduplicate at parse time so a
    // paste/scan of "123;123" can never produce two identical candidates.
    const parsed = Array.from(new Set(splitBarcodeInput(rawValue)));

    if (parsed.length === 0) {
      // [UX] Deliberately does NOT clear catalogInfo: an empty field firing this
      // used to wipe the shared-catalog suggestion the merchant had just earned.
      clearUnitBarcodeDraft(unitIndex);
      return;
    }

    // Never propose a value already attached to any unit of this product (the
    // backend rejects a barcode shared across units; catching it here gives a
    // friendly message instead of a 400 after the whole form is filled in).
    const used = new Set(allBarcodesOnForm(units));
    const fresh = parsed.filter((b) => !used.has(b));
    const clashes = parsed.filter((b) => used.has(b));
    if (clashes.length > 0) {
      toast.error(
        clashes.length === 1
          ? `الباركود ${clashes[0]} مضاف مسبقاً لهذا المنتج.`
          : `${clashes.length} باركودات مضافة مسبقاً لهذا المنتج وتم تجاهلها.`
      );
    }
    if (fresh.length === 0) {
      clearUnitBarcodeDraft(unitIndex);
      return;
    }

    setBarcodeGate({ unitIndex, candidates: fresh.map((barcode) => ({ barcode })) });
    lookupCatalogMatches(fresh, unitIndex);
  };

  const handleBarcodeSourceConfirm = (selections: BarcodeSourceSelection[]) => {
    const { unitIndex } = barcodeGate;
    if (unitIndex === null) return;

    setUnits((prev) => {
      const next = [...prev];
      const unit = next[unitIndex];
      if (!unit) return prev;
      const existing = new Set(unit.barcodes.map((b) => b.barcode));
      const added = selections
        .filter((s) => !existing.has(s.barcode))
        .map((s) => ({ barcode: s.barcode, barcodeSource: s.barcodeSource }));
      next[unitIndex] = {
        ...unit,
        barcodes: [...unit.barcodes, ...added],
        barcodeDraft: "",
      };
      return next;
    });

    setBarcodeGate({ unitIndex: null, candidates: [] });
    // [UX] Ready for the next scan/typed barcode with no extra click.
    focusBarcodeInput(unitIndex);
  };

  const handleBarcodeSourceDismiss = () => {
    const { unitIndex } = barcodeGate;
    if (unitIndex !== null) {
      // Spec: dismissing the gate means the barcode VALUE is not saved either.
      clearUnitBarcodeDraft(unitIndex);
    }
    setBarcodeGate({ unitIndex: null, candidates: [] });
  };

  /**
   * [v4.5] Removes ONE barcode from ONE unit.
   *
   * A barcode that is not saved yet is purely local state. A SAVED barcode can
   * only be removed through the dedicated, ADMIN-only DELETE route — the
   * product PATCH is deliberately additive-only, so that every real deletion
   * travels through this single auditable path (see that route's header).
   * Because that deletion is immediate and permanent (it does not wait for the
   * "save" button), it asks for confirmation first.
   *
   * Deleting a barcode never touches a sale: InvoiceItem references the UNIT,
   * not a barcode row (schema.prisma's [v4.5] note).
   */
  const handleRemoveBarcode = async (unitIndex: number, barcode: string) => {
    const unit = units[unitIndex];
    const entry = unit?.barcodes.find((b) => b.barcode === barcode);
    if (!unit || !entry) return;

    const removeLocally = () => {
      setUnits((prev) => {
        const next = [...prev];
        const current = next[unitIndex];
        if (!current) return prev;
        next[unitIndex] = {
          ...current,
          barcodes: current.barcodes.filter((b) => b.barcode !== barcode),
        };
        return next;
      });
    };

    if (!entry.id || !unit.id || !product) {
      removeLocally();
      return;
    }

    if (!window.confirm(`حذف الباركود ${barcode} نهائياً؟ لن ينتظر هذا الحذف زر «حفظ التعديلات».`)) {
      return;
    }

    try {
      const res = await fetch(
        `/api/inventory/products/${product.id}/units/${unit.id}/barcodes/${entry.id}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || "تعذّر حذف الباركود.");
      }
      removeLocally();
      toast.success("تم حذف الباركود.");
    } catch (err: any) {
      toast.error(err?.message || "تعذّر حذف الباركود.");
    }
  };

  /**
   * [v4.5] Looks up EVERY freshly entered barcode in the shared catalog in one
   * pass: per-barcode matches feed the confirmation gate (so a barcode the
   * platform already knows gets the simplified one-click GS1 view), and the
   * FIRST match also populates the one-click "copy catalog data" suggestion
   * this screen already offered.
   */
  const lookupCatalogMatches = async (barcodesList: string[], targetUnitIndex: number) => {
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;

    const matches: Record<string, { name: string } | null> = {};
    const found: CatalogLookupResult[] = [];

    await Promise.all(
      barcodesList.map(async (value) => {
        try {
          const res = await fetch(`/api/catalog/lookup?barcode=${encodeURIComponent(value)}`, {
            signal: controller.signal,
          });
          if (!res.ok) {
            matches[value] = null;
            return;
          }
          const data = await res.json();
          if (data.success && data.entry) {
            matches[value] = { name: data.entry.name };
            found.push({ ...(data.entry as Omit<CatalogLookupResult, "targetUnitIndex">), targetUnitIndex });
          } else {
            matches[value] = null;
          }
        } catch (err: any) {
          if (err?.name !== "AbortError") {
            console.error("Error querying shared catalog:", err);
          }
        }
      })
    );

    // Fold the matches into the open gate — only rows still present are updated.
    setBarcodeGate((prev) =>
      prev.unitIndex === null
        ? prev
        : {
          ...prev,
          candidates: prev.candidates.map((c) => ({
            ...c,
            catalogMatch: matches[c.barcode] ?? c.catalogMatch ?? null,
          })),
        }
    );

    const firstEntry = found[0];
    if (!firstEntry) {
      setCatalogInfo(null);
      return;
    }

    setCatalogInfo(firstEntry);
    toast.info(
      `تم العثور على هذا المنتج في الكتالوج المشترك (${firstEntry.name}). يمكنك نسخ بياناته بنقرة واحدة.`
    );
  };

  const applyCatalogSuggestion = () => {
    if (!catalogInfo) return;
    if (catalogInfo.name && !name) setName(catalogInfo.name);
    if (catalogInfo.category && !category) setCategory(catalogInfo.category);
    if (catalogInfo.imageUrl && !imageUrl) {
      setImageUrl(catalogInfo.imageUrl);
    }
    toast.success("تم تطبيق بيانات الكتالوج المشترك بنجاح.");
  };

  // [v4.5 UX] The unit scanner runs in CONTINUOUS mode: each accepted scan only
  // lands in the buffer (a barcode still sitting in front of the camera is
  // ignored); the whole batch is classified once, when the scanner closes.
  const handleScanSuccess = (scannedCode: string) => {
    const value = scannedCode.trim();
    if (!value || scanBufferRef.current.includes(value)) return;
    scanBufferRef.current = [...scanBufferRef.current, value];
    setScanBuffer(scanBufferRef.current);
  };

  const handleScannerOpenChange = (isOpen: boolean) => {
    setScannerOpen(isOpen);
    if (isOpen) return;

    const collected = scanBufferRef.current;
    scanBufferRef.current = [];
    setScanBuffer([]);

    if (collected.length > 0) {
      requestBarcodeClassification(activeUnitIndex, collected.join(";"));
    }
  };

  const openUnitScanner = (unitIndex: number) => {
    scanBufferRef.current = [];
    setScanBuffer([]);
    setActiveUnitIndex(unitIndex);
    setScannerOpen(true);
  };

  const handleCropComplete = (uploadedUrl: string) => {
    setImageUrl(uploadedUrl);
    setCropModalOpen(false);
    toast.success("تم تحديث صورة المنتج بنجاح.");
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
        barcodes: [],
        barcodeDraft: "",
        isActive: true,
      },
    ]);
  };

  const handleRemoveUnit = (index: number) => {
    // Unit 0 is always the product's base unit — its conversionFactor is
    // forced/locked to 1 and can never be changed via this screen (a
    // base-unit correction is a dedicated, separate flow on the backend —
    // see resetProductUnits()). This modal never exposes it.
    if (index === 0) {
      toast.error("لا يمكن حذف الوحدة الأساسية.");
      return;
    }

    // [FIX] Defensive guard mirroring AddProductModal.tsx — index 0 is
    // already protected above so this can't currently be reached with
    // units.length going to 0, but kept for the same defense-in-depth
    // reasoning.
    if (units.length <= 1) {
      toast.error("يجب الإبقاء على وحدة قياس واحدة على الأقل.");
      return;
    }

    setUnits((prev) => prev.filter((_, i) => i !== index));

    // [FIX] Removing a unit shifts every later index down by one: shift an open
    // gate's stored unitIndex accordingly, and clear it only on an exact match.
    setBarcodeGate((prev) => {
      if (prev.unitIndex === null) return prev;
      if (prev.unitIndex === index) return { unitIndex: null, candidates: [] };
      if (prev.unitIndex > index) return { ...prev, unitIndex: prev.unitIndex - 1 };
      return prev;
    });
  };

  const handleClearImage = () => {
    if (isPublic) {
      toast.error("ألغِ النشر أولاً");
      return;
    }
    setImageUrl("");
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
      const gate = checkProductPublishable({
        isActive,
        imageUrl: imageUrl.trim() || null,
        units: units.map((u) => ({
          isActive: u.isActive,
        })),
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

    // priceWholesale is the ONLY figure ever used to bill a sale (POS or
    // B2B alike) — a unit reaching submit with priceWholesale <= 0 must
    // be rejected here, matching AddProductModal.tsx's identical check.
    if (units.some((u) => !u.unitName.trim() || u.conversionFactor <= 0 || u.priceWholesale <= 0)) {
      toast.error("يرجى التأكد من ملء جميع الوحدات بمعامل تحويل وسعر جملة أكبر من الصفر.");
      return;
    }

    const packagingValidation = validatePackagingUnits(units);
    if (!packagingValidation.valid) {
      toast.error(packagingValidation.error);
      return;
    }

    // [v4.5] The only unfinished barcode state left is a DRAFT that never got
    // classified (duplicates cannot exist among confirmed barcodes). Saving
    // with a draft present would silently discard what the merchant typed, so
    // the gate is opened for that unit and this save is aborted; press save
    // again once it is resolved.
    if (barcodeGate.unitIndex !== null) {
      toast.error("يرجى إكمال تصنيف مصدر الباركود المعلّق قبل الحفظ.");
      return;
    }
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.barcodeDraft.trim()) {
        toast.error(`الوحدة "${u.unitName || i + 1}": يجب تأكيد مصدر الباركود قبل الحفظ.`);
        requestBarcodeClassification(i, u.barcodeDraft);
        return;
      }
    }

    if (isPublic) {
      if (!imageUrl.trim()) {
        toast.error("ألغِ النشر أولاً");
        return;
      }
      const gate = checkProductPublishable({
        isActive,
        imageUrl: imageUrl.trim() || null,
        units: units.map((u) => ({
          isActive: u.isActive,
        })),
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
        imageUrl: imageUrl.trim() || null,
        isPublic,
        isActive,
        units: units.map((u) => ({
          ...(u.id ? { id: u.id } : {}),
          unitName: u.unitName.trim(),
          conversionFactor: toDecimalString(Number(u.conversionFactor)),
          pricingCurrency: u.pricingCurrency,
          priceWholesale: toDecimalString(Number(u.priceWholesale) || 0),
          // [v4.5] The unit's full confirmed barcode list. The PATCH is
          // ADDITIVE-ONLY: the route skips any value already stored on the
          // unit and creates the rest — removal is exclusively the dedicated
          // ADMIN-only DELETE route's job (see handleRemoveBarcode above).
          barcodes: u.barcodes.map((b) => ({
            barcode: b.barcode,
            barcodeSource: b.barcodeSource,
          })),
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

            <div className="space-y-1.5">
              <Label htmlFor="edit-image" className="text-xs font-semibold">
                صورة المنتج
              </Label>
              <div className="flex items-center gap-2">
                {imageUrl && (
                  <Image
                    src={imageUrl}
                    alt="معاينة"
                    width={36}
                    height={36}
                    unoptimized
                    className="w-9 h-9 object-cover rounded border border-zinc-200 dark:border-zinc-700 shrink-0"
                  />
                )}
                <Input
                  id="edit-image"
                  value={imageUrl}
                  onChange={(e) => {
                    const newVal = e.target.value;
                    if (isPublic && !newVal.trim() && imageUrl.trim()) {
                      toast.error("ألغِ النشر أولاً");
                      return;
                    }
                    setImageUrl(newVal);
                  }}
                  placeholder="رابط الصورة أو ارفع وقص صورة..."
                  className="text-xs flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCropModalOpen(true)}
                  className="h-9 text-xs gap-1 border-zinc-300 shrink-0"
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span>{imageUrl ? "تغيير الصورة" : "رفع وقص"}</span>
                </Button>
                {imageUrl && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleClearImage}
                    className="h-9 text-xs text-red-500 hover:bg-red-50 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5 ml-1" />
                    <span>إزالة</span>
                  </Button>
                )}
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
                      يتطلب وجود صورة للمنتج ووحدة قياس نشطة واحدة على الأقل.
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
                    الوحدة الأساسية (معامل = 1) مقفلة هنا — تصحيحها يتم من شاشة مخصصة منفصلة. عدّل الوحدات
                    الثانوية/الثلاثية وأسعارها بحرية.
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
                              // Immutable update — never mutate `units[index]` in
                              // place (see AddProductModal.tsx's same pattern).
                              const value = e.target.value;
                              setUnits((prev) => {
                                const next = [...prev];
                                next[index] = { ...next[index], unitName: value };
                                return next;
                              });
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
                              // Fractional conversionFactor values are explicitly
                              // allowed (a quarter- or half-carton) — only fall
                              // back when the parse isn't a real number at all;
                              // validatePackagingUnits() rejects <= 0 at submit.
                              const parsed = parseFloat(e.target.value);
                              const value = Number.isFinite(parsed) ? parsed : 0;
                              setUnits((prev) => {
                                const next = [...prev];
                                next[index] = { ...next[index], conversionFactor: value };
                                return next;
                              });
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
                              const value = e.target.value as "SYP" | "USD";
                              setUnits((prev) => {
                                const next = [...prev];
                                next[index] = { ...next[index], pricingCurrency: value };
                                return next;
                              });
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
                              const value = Number(e.target.value) || 0;
                              setUnits((prev) => {
                                const next = [...prev];
                                next[index] = { ...next[index], priceWholesale: value };
                                return next;
                              });
                            }}
                            className="h-8 text-xs mt-1"
                          />
                        </div>

                        <div className="sm:col-span-3">
                          <Label className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                            الباركودات
                            {unit.barcodes.length > 0 ? ` (${unit.barcodes.length})` : ""}
                          </Label>

                          {/* [v4.5 UX] ONE full-width barcode field per unit.
                              Enter (what a keyboard-wedge scanner sends after each
                              scan), the Add button, or a pasted delimited list all
                              start classification. There is no blur trigger:
                              tabbing/clicking away used to pop the modal
                              unexpectedly, and an unclassified value is caught by
                              the save check anyway. */}
                          <div className="flex items-center gap-1.5 mt-1">
                            <div className="relative flex-1">
                              <Input
                                ref={(el) => {
                                  barcodeInputRefs.current[index] = el;
                                }}
                                dir="ltr"
                                value={unit.barcodeDraft}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    requestBarcodeClassification(index, unit.barcodeDraft);
                                  }
                                }}
                                onPaste={(e) => {
                                  // A pasted LIST (one barcode per line, or `;`/tab
                                  // separated) is classified together in one modal.
                                  const text = e.clipboardData.getData("text");
                                  if (/[;\n\t]/.test(text.trim())) {
                                    e.preventDefault();
                                    requestBarcodeClassification(
                                      index,
                                      unit.barcodeDraft ? `${unit.barcodeDraft};${text}` : text
                                    );
                                  }
                                }}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setUnits((prev) => {
                                    const next = [...prev];
                                    next[index] = { ...next[index], barcodeDraft: value };
                                    return next;
                                  });
                                }}
                                placeholder="امسح أو اكتب الباركود ثم Enter"
                                className="h-8 text-xs pl-7"
                              />
                              <BarcodeIcon className="w-3.5 h-3.5 absolute left-2 top-2.5 text-zinc-400" />
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!unit.barcodeDraft.trim()}
                              onClick={() => requestBarcodeClassification(index, unit.barcodeDraft)}
                              className="h-8 px-2 gap-1 text-xs border-zinc-300"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>إضافة</span>
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => openUnitScanner(index)}
                              className="h-8 px-2 border-zinc-300"
                              title="مسح بالكاميرا"
                            >
                              <Camera className="w-3.5 h-3.5 text-zinc-600" />
                            </Button>
                          </div>

                          {/* [v4.5] The unit's CONFIRMED barcodes. A SAVED one is
                              removed through the ADMIN-only DELETE route — that is
                              the ONLY removal path, since the product PATCH is
                              additive-only; one added in this session has no id yet
                              and is removed from local state. */}
                          {unit.barcodes.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                              {unit.barcodes.map((b) => (
                                <span
                                  key={b.barcode}
                                  className="inline-flex items-center gap-1 rounded border border-zinc-200 px-1.5 py-0.5 dark:border-zinc-700"
                                >
                                  <span className="font-mono" dir="ltr">
                                    {b.barcode}
                                  </span>
                                  <Badge variant="outline" className="text-[9px] px-1 py-0">
                                    {b.barcodeSource}
                                  </Badge>
                                  {!b.id && (
                                    <span className="text-[9px] text-amber-600">جديد</span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveBarcode(index, b.barcode)}
                                    className="text-red-500 hover:text-red-600 p-1.5 -m-1.5"
                                    aria-label={`حذف الباركود ${b.barcode}`}
                                    title={b.id ? "حذف هذا الباركود نهائياً" : "إزالة هذا الباركود"}
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}

                          {unit.barcodes.length > 1 && (
                            <p className="mt-1 text-[10px] text-blue-700">
                              كل هذه الباركودات تُباع كنفس الصنف: مخزون وسعر واحد، والفاتورة لا تسجّل أي باركود انمسح.
                              إذا كان لكل نكهة مخزون منفصل، أضف كل نكهة كمنتج مستقل.
                            </p>
                          )}
                          {unit.barcodes.some((b) => !b.id) && (
                            <p className="mt-1 text-[10px] text-amber-700">
                              الباركودات المعلّمة «جديد» تُحفظ عند الضغط على «حفظ التعديلات».
                            </p>
                          )}
                        </div>
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

      {/* [v4.5] ONE modal for this action's NEW barcodes, one radio group per
          barcode; the `key` is derived from the barcode set itself so a brand
          new instance is mounted per action and a previously-chosen source can
          never carry over. It deliberately excludes the catalog-match results
          (they arrive a round-trip later and would wipe clicks). */}
      <BarcodeSourceModal
        key={`barcode-gate-${barcodeGate.unitIndex !== null
          ? `${barcodeGate.unitIndex}-${barcodeGate.candidates.map((c) => c.barcode).join("|")}`
          : "closed"
          }`}
        open={barcodeGate.unitIndex !== null && barcodeGate.candidates.length > 0}
        candidates={barcodeGate.candidates}
        onConfirm={handleBarcodeSourceConfirm}
        onDismiss={handleBarcodeSourceDismiss}
      />

      {/* [v4.5 UX] Per-unit scanner: CONTINUOUS, so several barcodes can be
          scanned in one go; they are collected below the video and classified
          together in one confirmation modal when the merchant finishes.
          Requires the optional title / description / children props on
          BarcodeScannerModal. */}
      <BarcodeScannerModal
        open={scannerOpen}
        onOpenChange={handleScannerOpenChange}
        onScan={handleScanSuccess}
        mode="continuous"
        feedback="silent"
        continuousCooldownMs={1500}
        title="مسح باركودات الوحدة"
        description="امسح باركودات هذه الوحدة بالتتابع، ثم اضغط «إنهاء المسح» لتصنيفها دفعة واحدة."
      >
        {scanBuffer.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {scanBuffer.map((b) => (
              <span
                key={b}
                dir="ltr"
                className="font-mono text-[11px] rounded border border-zinc-200 px-1.5 py-0.5"
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </BarcodeScannerModal>

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