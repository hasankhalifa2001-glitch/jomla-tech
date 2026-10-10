/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, useRef } from "react";
import {
  Package,
  Plus,
  Trash2,
  Camera,
  Globe,
  Loader2,
  CheckCircle2,
  Flag,
  ImagePlus,
  Crop,
  Info,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ImageCropModal } from "@/components/inventory/ImageCropModal";
import { CatalogReportModal } from "@/components/inventory/CatalogReportModal";
import { DecimalInput } from "@/components/inventory/DecimalInput";
import {
  BarcodeSourceModal,
  type BarcodeSourceChoice,
  type BarcodeSourceCandidate,
  type BarcodeSourceSelection,
} from "@/components/inventory/BarcodeSourceModal";
import { ModalShell, Field, Segmented } from "@/components/inventory/modal-ui";
import { StatusBadge } from "@/components/inventory/status-badge";
// validatePackagingUnits() lives in lib/inventory/units.ts (the old
// packaging-unit-validation.ts was deleted when it was merged in).
import { validatePackagingUnits } from "@/lib/inventory/units";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
import type { ProductItem } from "@/components/inventory/ProductTable";

// `[id]/route.ts`'s PATCH validates conversionFactor/priceWholesale as decimal
// STRINGS (regex-checked, max 4 decimal places). This modal's internal state
// stays `number`, but every such value crossing into the PATCH payload goes
// through this helper rather than a raw `String(...)` cast — see
// AddProductModal.tsx's identical helper for the reasoning (floating-point
// noise, regex compliance).
const toDecimalString = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(4);
};

/** "كرتونة" → "الكرتونة"; a name that already starts with "ال" is left alone. */
const withAl = (name: string): string => (name.startsWith("ال") ? name : `ال${name}`);

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
  // [v4.6] imageUrl removed — the image lives on the Product, not on units.
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

export function EditProductModal({ open, onOpenChange, product, onSuccess }: EditProductModalProps) {
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

      // Explicit numeric coercion. The API consistently returns
      // conversionFactor/priceWholesale as strings (Decimal precision fields);
      // `Number(...)` makes the local state genuinely match its declared type.
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
    // forced/locked to 1 and can never be changed via this screen (a base-unit
    // correction is a dedicated, separate flow on the backend — see
    // resetProductUnits()). This modal never exposes it.
    if (index === 0) {
      toast.error("لا يمكن حذف الوحدة الأساسية.");
      return;
    }

    // Defensive guard mirroring AddProductModal.tsx — index 0 is already
    // protected above, kept for the same defense-in-depth reasoning.
    if (units.length <= 1) {
      toast.error("يجب الإبقاء على وحدة قياس واحدة على الأقل.");
      return;
    }

    setUnits((prev) => prev.filter((_, i) => i !== index));

    // Removing a unit shifts every later index down by one: shift an open
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

    // priceWholesale is the ONLY figure ever used to bill a sale (POS or B2B
    // alike) — a unit reaching submit with priceWholesale <= 0 must be
    // rejected here, matching AddProductModal.tsx's identical check.
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

  const baseUnitName = units[0]?.unitName.trim() || "الوحدة الأساسية";
  const imageIsUploaded = imageUrl.startsWith("data:");

  return (
    <>
      <ModalShell
        open={open}
        onOpenChange={onOpenChange}
        title="تعديل المنتج"
        icon={Package}
        description={product.name}
        // This screen saves through the footer button; the form wrapper only
        // exists for layout, so a stray Enter in a field must never submit.
        onSubmit={(e) => e.preventDefault()}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="text-slate-600"
            >
              إلغاء
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex-1 gap-1.5 bg-emerald-600 hover:bg-emerald-700 sm:min-w-40 sm:flex-none"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  جاري الحفظ...
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-4" aria-hidden />
                  حفظ التعديلات
                </>
              )}
            </Button>
          </>
        }
      >
        {catalogInfo && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-sky-900">متوفر بالكتالوج المشترك</p>
              <p className="text-xs text-sky-700">
                {catalogInfo.name}
                {catalogInfo.category ? ` (${catalogInfo.category})` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={applyCatalogSuggestion}
                className="h-8 border-sky-200 bg-white text-xs"
              >
                نسخ البيانات
              </Button>
              {!catalogInfo.isOwner && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setCatalogReportOpen(true)}
                  className="h-8 gap-1 text-xs text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                >
                  <Flag className="size-3.5" aria-hidden />
                  إبلاغ عن خطأ
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ---------------------------------------------------- product data */}
        <section className="space-y-4">
          <h3 className="text-sm font-bold text-slate-900">بيانات المنتج</h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="اسم المنتج" htmlFor="edit-name" required>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثال: شاي سيلاني فاخر"
                className="h-11 text-base font-semibold"
              />
            </Field>

            <Field label="التصنيف" htmlFor="edit-category">
              <Input
                id="edit-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="مثال: مشروبات ساخنة"
                className="h-11 text-base"
              />
            </Field>
          </div>

          <Field label="صورة المنتج">
            <div className="flex items-start gap-3">
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 text-slate-300">
                {imageUrl ? (
                  <img src={imageUrl} alt="معاينة الصورة" className="size-full object-cover" />
                ) : (
                  <ImagePlus className="size-6" aria-hidden />
                )}
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                {imageIsUploaded ? (
                  <p className="flex h-10 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600">
                    صورة مرفوعة من الجهاز
                  </p>
                ) : (
                  <Input
                    id="edit-image"
                    dir="ltr"
                    value={imageUrl}
                    onChange={(e) => {
                      const newVal = e.target.value;
                      if (isPublic && !newVal.trim() && imageUrl.trim()) {
                        toast.error("ألغِ النشر أولاً");
                        return;
                      }
                      setImageUrl(newVal);
                    }}
                    placeholder="رابط الصورة (اختياري)"
                    aria-label="رابط صورة المنتج"
                    className="h-10 text-sm"
                  />
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setCropModalOpen(true)}
                    className="h-9 gap-1.5"
                  >
                    <Crop className="size-4 text-sky-600" aria-hidden />
                    {imageUrl ? "تغيير الصورة" : "رفع وقص"}
                  </Button>
                  {imageUrl && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={handleClearImage}
                      className="h-9 gap-1.5 text-red-600 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="size-4" aria-hidden />
                      إزالة
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Field>
        </section>

        {/* ------------------------------------------------ status & publish */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold text-slate-900">الحالة والنشر</h3>

          {/* dir="ltr" on each Switch: the stock shadcn Switch slides its thumb
              to the physical right when checked, wrong inside an RTL track. */}
          <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-3">
            <div>
              <label htmlFor="edit-is-active" className="text-sm font-semibold text-slate-900">
                المنتج فعّال
              </label>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                تعطيل المنتج بيخفيه من نقاط البيع والمتجر، من دون ما يمس الكميات أو حالات الوحدات.
              </p>
            </div>
            <Switch
              id="edit-is-active"
              dir="ltr"
              checked={isActive}
              onCheckedChange={setIsActive}
              className="mt-0.5 shrink-0 data-[state=checked]:bg-emerald-600"
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-3">
            <div>
              <label
                htmlFor="edit-is-public"
                className="flex items-center gap-1.5 text-sm font-semibold text-slate-900"
              >
                <Globe className="size-4 text-sky-600" aria-hidden />
                النشر بالمتجر العام
              </label>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                بيحتاج صورة للمنتج ووحدة قياس فعّالة وحدة على الأقل.
              </p>
            </div>
            <Switch
              id="edit-is-public"
              dir="ltr"
              checked={isPublic}
              onCheckedChange={handleToggleIsPublic}
              className="mt-0.5 shrink-0 data-[state=checked]:bg-emerald-600"
            />
          </div>
        </section>

        {/* ----------------------------------------------------------- units */}
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">وحدات التعبئة والأسعار</h3>
            <p className="mt-0.5 flex items-start gap-1.5 text-xs leading-relaxed text-slate-500">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                الوحدة الأساسية (معاملها 1) مقفلة هون — تصحيحها بيتم من شاشة مخصصة. عدّل باقي الوحدات وأسعارها بحرية.
              </span>
            </p>
          </div>

          {units.map((unit, index) => {
            const isBase = index === 0;
            const unitLabel = unit.unitName.trim() || "الوحدة";
            // "كرتونة" → "الكرتونة" — used in the price label and the factor hint.
            const unitLabelDefinite = withAl(unitLabel);
            return (
              <div
                key={unit.id || index}
                className={cn(
                  "space-y-4 rounded-xl border p-4 transition-colors",
                  unit.isActive ? "border-slate-200 bg-white shadow-sm" : "border-slate-200 bg-slate-50"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-bold text-slate-900">
                        {isBase ? "الوحدة الأساسية" : `وحدة تجميعية #${index + 1}`}
                      </h4>
                      {!unit.isActive && <StatusBadge tone="red">معطلة</StatusBadge>}
                    </div>
                    {!isBase && (
                      <p className="text-xs text-slate-500">
                        {unitLabel} = {unit.conversionFactor} {baseUnitName}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <label
                      htmlFor={`unit-active-${index}`}
                      className="text-xs font-semibold text-slate-600"
                    >
                      {unit.isActive ? "فعّالة" : "معطلة"}
                    </label>
                    <Switch
                      id={`unit-active-${index}`}
                      dir="ltr"
                      checked={unit.isActive}
                      onCheckedChange={() => handleToggleUnitActive(index)}
                      className="data-[state=checked]:bg-emerald-600"
                    />
                    {!isBase && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => handleRemoveUnit(index)}
                        aria-label="حذف الوحدة"
                        className="size-9 text-red-600 hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                </div>

                {isBase && unit.isActive === false && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-800">
                    تنبيه: هي الوحدة الأساسية — تعطيلها بيخفيها من كل الشاشات مع إنها الوحدة اللي بتنحسب فيها كل الدفعات.
                  </p>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="اسم الوحدة" htmlFor={`unit-name-${index}`} required>
                    <Input
                      id={`unit-name-${index}`}
                      value={unit.unitName}
                      onChange={(e) => {
                        // Immutable update — never mutate `units[index]` in place.
                        const value = e.target.value;
                        setUnits((prev) => {
                          const next = [...prev];
                          next[index] = { ...next[index], unitName: value };
                          return next;
                        });
                      }}
                      placeholder={isBase ? "مثال: قطعة" : "مثال: طرد"}
                    />
                  </Field>

                  {/* The base unit's factor is locked to 1 and not shown at all
                      (T3a §0). Every other unit states its factor RELATIVE to the
                      base unit, in words. */}
                  {!isBase && (
                    <Field
                      label={`${unitLabel} الواحدة تساوي كم ${baseUnitName}؟`}
                      htmlFor={`unit-factor-${index}`}
                      required
                      hint={`مثال: ${unitLabelDefinite} = 24 ${baseUnitName}`}
                    >
                      {/* DecimalInput keeps the typed text locally, so the field
                          can be cleared and retyped freely (80, 0.5, 0.25 ...)
                          without a stuck "0". Fractional factors stay allowed;
                          validatePackagingUnits() rejects <= 0 at submit. */}
                      <DecimalInput
                        id={`unit-factor-${index}`}
                        placeholder="مثال: 24"
                        value={unit.conversionFactor}
                        onValueChange={(value) =>
                          setUnits((prev) => {
                            const next = [...prev];
                            next[index] = { ...next[index], conversionFactor: value };
                            return next;
                          })
                        }
                      />
                    </Field>
                  )}

                  <Field label="عملة التسعير">
                    <Segmented
                      ariaLabel="عملة التسعير"
                      value={unit.pricingCurrency}
                      onChange={(value) =>
                        setUnits((prev) => {
                          const next = [...prev];
                          next[index] = { ...next[index], pricingCurrency: value };
                          return next;
                        })
                      }
                      options={[
                        { value: "SYP", label: "ليرة سورية" },
                        { value: "USD", label: "دولار" },
                      ]}
                    />
                  </Field>

                  <Field
                    label={isBase ? `سعر بيع ${unitLabelDefinite} (POS)` : `سعر ${unitLabelDefinite} (POS)`}
                    htmlFor={`unit-price-${index}`}
                    required
                  >
                    <div className="relative">
                      <DecimalInput
                        id={`unit-price-${index}`}
                        placeholder="0"
                        value={unit.priceWholesale}
                        onValueChange={(value) =>
                          setUnits((prev) => {
                            const next = [...prev];
                            next[index] = { ...next[index], priceWholesale: value };
                            return next;
                          })
                        }
                        className="pe-12 font-semibold tabular-nums"
                      />
                      <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-500">
                        {unit.pricingCurrency === "USD" ? "$" : "ل.س"}
                      </span>
                    </div>
                  </Field>
                </div>

                {/* [v4.5 UX] ONE full-width barcode field per unit. Enter (what a
                    keyboard-wedge scanner sends after each scan), the add button,
                    or a pasted delimited list all start classification. There is
                    no blur trigger: tabbing away used to pop the modal
                    unexpectedly, and an unclassified value is caught by the save
                    check anyway. */}
                <Field
                  label={`الباركودات${unit.barcodes.length > 0 ? ` (${unit.barcodes.length})` : ""}`}
                  htmlFor={`unit-barcode-${index}`}
                >
                  <div className="flex gap-2">
                    <Input
                      id={`unit-barcode-${index}`}
                      ref={(el) => {
                        barcodeInputRefs.current[index] = el;
                      }}
                      dir="ltr"
                      inputMode="numeric"
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
                      className="h-10 flex-1 font-mono"
                    />
                    {/* Icon-only: text labels ate most of the row on a phone and
                        cut the placeholder off. */}
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      disabled={!unit.barcodeDraft.trim()}
                      onClick={() => requestBarcodeClassification(index, unit.barcodeDraft)}
                      aria-label="إضافة الباركود"
                      className="size-10 shrink-0"
                    >
                      <Plus className="size-5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={() => openUnitScanner(index)}
                      aria-label="مسح بالكاميرا"
                      className="size-10 shrink-0 text-emerald-600"
                    >
                      <Camera className="size-5" aria-hidden />
                    </Button>
                  </div>

                  {/* [v4.5] The unit's CONFIRMED barcodes. A SAVED one is removed
                      through the ADMIN-only DELETE route — that is the ONLY
                      removal path, since the product PATCH is additive-only; one
                      added in this session has no id yet and is removed from
                      local state. */}
                  {unit.barcodes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {unit.barcodes.map((b) => (
                        <span
                          key={b.barcode}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border py-0.5 ps-3 pe-1 text-xs font-semibold",
                            b.barcodeSource === "GS1"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : "border-slate-200 bg-slate-50 text-slate-700"
                          )}
                        >
                          <span dir="ltr" className="font-mono">
                            {b.barcode}
                          </span>
                          <span className="text-[10px] font-medium opacity-70">
                            {b.barcodeSource === "GS1" ? "GS1" : "داخلي"}
                          </span>
                          {!b.id && <span className="text-[10px] font-bold text-amber-600">جديد</span>}
                          <button
                            type="button"
                            onClick={() => handleRemoveBarcode(index, b.barcode)}
                            aria-label={`حذف الباركود ${b.barcode}`}
                            title={b.id ? "حذف هذا الباركود نهائياً" : "إزالة هذا الباركود"}
                            className="flex size-7 items-center justify-center rounded-full hover:bg-black/5"
                          >
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {unit.barcodes.length > 1 && (
                    <p className="flex items-start gap-1.5 rounded-md border border-sky-100 bg-sky-50 p-2.5 text-xs leading-relaxed text-sky-800">
                      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span>
                        كل هالباركودات بتنباع كنفس الصنف: مخزون وسعر واحد، والفاتورة ما بتسجّل أي باركود انمسح. إذا كل
                        نكهة إلها مخزون منفصل، أضفها كمنتج مستقل.
                      </span>
                    </p>
                  )}
                  {unit.barcodes.some((b) => !b.id) && (
                    <p className="text-xs text-amber-700">
                      الباركودات المعلّمة «جديد» بتنحفظ لما تضغط «حفظ التعديلات».
                    </p>
                  )}
                </Field>
              </div>
            );
          })}

          <Button
            type="button"
            variant="outline"
            onClick={handleAddUnit}
            className="h-11 w-full gap-1.5 border-dashed border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
          >
            <Plus className="size-4" aria-hidden />
            إضافة وحدة تجميعية (كرتونة، طرد...)
          </Button>
        </section>
      </ModalShell>

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
          <div className="mb-2 flex flex-wrap gap-1.5">
            {scanBuffer.map((b) => (
              <span
                key={b}
                dir="ltr"
                className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-700"
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </BarcodeScannerModal>

      <ImageCropModal open={cropModalOpen} onOpenChange={setCropModalOpen} onCropComplete={handleCropComplete} />

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