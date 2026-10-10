/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  PackagePlus,
  Camera,
  Crop,
  AlertTriangle,
  CheckCircle2,
  ScanBarcode,
  ShieldAlert,
  Search,
  Info,
  RefreshCw,
  ImagePlus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ImageCropModal } from "@/components/inventory/ImageCropModal";
import { DecimalInput } from "@/components/inventory/DecimalInput";
import { CatalogReportModal } from "@/components/inventory/CatalogReportModal";
import {
  BarcodeSourceModal,
  type BarcodeSourceChoice,
  type BarcodeSourceCandidate,
  type BarcodeSourceSelection,
} from "@/components/inventory/BarcodeSourceModal";
import { ModalShell, ModalStepper, Field, NativeSelect, Segmented } from "@/components/inventory/modal-ui";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
// validatePackagingUnits() lives in lib/inventory/units.ts (the old
// packaging-unit-validation.ts was deleted when it was merged in).
import { validatePackagingUnits } from "@/lib/inventory/units";
// [Batch cost entry — UNIFIED] The ONE shared derivation the server also runs
// (costFromTotal() underneath), so the figure shown live in this form can never
// diverge from what gets stored for the initial batch.
import { costBreakdownForDisplay } from "@/lib/inventory/units";

// [Batch cost entry] Mirrors the server's own quantity/totalCost rule
// (batches/route.ts's AMOUNT_REGEX + isPositiveAmount): strictly positive,
// max 14 integer / 4 decimal digits, validated on the raw typed string so no
// precision is lost through parseFloat().
const AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;
function isPositiveAmount(value: string): boolean {
  const v = value.trim();
  if (!AMOUNT_REGEX.test(v)) return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

// products/route.ts's POST requires conversionFactor/priceWholesale as
// validated DECIMAL STRINGS (regex-checked, max 4 decimal places) rather than
// JSON numbers. Every value crossing into the API payload must go through this
// helper rather than a raw `Number(...)`/`String(...)` cast. Non-finite input
// becomes "0".
const toDecimalString = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(4);
};

// [v4.7] The SERVER-supplied receiving defaults — { businessDate, minDate }
// from GET /api/receipts/defaults. Step 3's batchNumber date-prefix preview
// and its default purchase date come from HERE, never the device clock; if
// the request fails, saving an initial batch is disabled (no fallback).
interface ReceivingDefaults {
  businessDate: string;
  minDate: string;
}

/** One CONFIRMED barcode on a unit — `barcodeSource` is never empty here. */
interface UnitBarcodeForm {
  barcode: string;
  // Only "GS1" | "INTERNAL" exist in this list. The UNCONFIRMED state is not
  // representable here at all: an as-yet-unclassified value lives in
  // `UnitForm.barcodeDraft` / the confirmation modal, and a value that the
  // merchant abandoned is simply never added to `barcodes`.
  barcodeSource: BarcodeSourceChoice;
}

interface UnitForm {
  unitName: string;
  conversionFactor: number;
  pricingCurrency: "SYP" | "USD";
  priceWholesale: number;
  // [v4.5] Zero, one, or many barcodes per unit, each already classified.
  barcodes: UnitBarcodeForm[];
  // [v4.5] The transient text in this unit's barcode input — what the
  // merchant is typing or just scanned, before it has been classified.
  // NEVER submitted; Enter / the Add button / a delimited paste / the next
  // step all route it through the confirmation modal, and only a confirmed
  // entry is appended to `barcodes` above. A dismiss discards the draft.
  barcodeDraft: string;
  // [v4.6] imageUrl removed — the image now lives on the Product.
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
  barcodes: [],
  barcodeDraft: "",
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
  // [v4.6] The ONE product-level image (moved here from per-unit UnitForm).
  const [imageUrl, setImageUrl] = useState("");

  const [units, setUnits] = useState<UnitForm[]>([{ ...DEFAULT_BASE_UNIT }]);

  const [hasInitialBatch, setHasInitialBatch] = useState(false);
  const [batchUnitIndex, setBatchUnitIndex] = useState(0);
  // [v4.4, Spec Addendum Section 10] Only the merchant-supplied SUFFIX is
  // collected here. The stored value is always "{server-date}-{suffix}", built
  // server-side — this component never builds that concatenation itself.
  const [batchNumberSuffix, setBatchNumberSuffix] = useState("");
  // [Batch cost entry — UNIFIED] QUANTITY received in the picked unit plus the
  // TOTAL paid for it. The server derives the stored per-base-unit cost. Both
  // stay raw strings — never round-tripped through parseFloat().
  const [batchQuantity, setBatchQuantity] = useState<string>("");
  const [totalCost, setTotalCost] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState("");

  // [v4.7] Step-3 initialBatch: the PERSISTED goods-receiving date (required
  // when a batch is created) + optional supplier, and the SERVER defaults
  // that bound them — never the device clock.
  const [receivingDefaults, setReceivingDefaults] = useState<ReceivingDefaults | null>(null);
  const [purchaseDate, setPurchaseDate] = useState("");
  const [supplierName, setSupplierName] = useState("");

  const [loading, setLoading] = useState(false);

  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [scannerModalOpen, setScannerModalOpen] = useState(false);
  const [activeUnitForScan, setActiveUnitForScan] = useState<number>(0);
  // [v4.5 UX] Barcodes collected by the camera in continuous mode. They are
  // classified together, in ONE confirmation modal, when the scanner closes.
  // The ref mirrors the state so the scanner's (ref-held) onScan callback never
  // reads a stale list while scans arrive quickly.
  const [scanBuffer, setScanBuffer] = useState<string[]>([]);
  const scanBufferRef = useRef<string[]>([]);

  const [cropModalOpen, setCropModalOpen] = useState(false);

  const [catalogInfo, setCatalogInfo] = useState<CatalogEntryInfo | null>(null);
  const [reportModalOpen, setReportModalOpen] = useState(false);

  const [quickScanModalOpen, setQuickScanModalOpen] = useState(false);
  const [pendingQuickScanBarcode, setPendingQuickScanBarcode] = useState<string>("");
  const [quickScanConsumed, setQuickScanConsumed] = useState(false);
  const [quickLookupState, setQuickLookupState] = useState<"idle" | "loading" | "found" | "not_found">("idle");

  const [barcodeGate, setBarcodeGate] = useState<{
    unitIndex: number | null;
    // [v4.5] The NEW barcodes awaiting classification in this one action —
    // exactly the set the modal shows, one row each. Empty while closed.
    candidates: BarcodeSourceCandidate[];
  }>({ unitIndex: null, candidates: [] });

  const lookupAbortRef = useRef<AbortController | null>(null);
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // [v4.5 UX] Per-unit barcode inputs, so focus can return to the field after
  // a confirmation (back-to-back hardware scanning without re-clicking).
  const barcodeInputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    return () => {
      if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);
      lookupAbortRef.current?.abort();
    };
  }, []);

  // [v4.7] Fetch the server's receiving defaults whenever the modal is open
  // (the purchase date only matters once step 3's initial batch is checked,
  // but fetching early means the picker is ready by the time it is shown).
  // On failure: null defaults → initial-batch saving is disabled; there is
  // deliberately NO device-clock fallback.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/receipts/defaults");
        if (!res.ok) throw new Error("defaults unavailable");
        const data: ReceivingDefaults = await res.json();
        if (cancelled) return;
        setReceivingDefaults(data);
        setPurchaseDate((prev) => prev || data.businessDate);
      } catch {
        if (cancelled) return;
        setReceivingDefaults(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const resetForm = () => {
    setName("");
    setCategory("");
    setIsPublic(false);
    setImageUrl(""); // [v4.6]
    setUnits([{ ...DEFAULT_BASE_UNIT }]);
    setHasInitialBatch(false);
    setBatchUnitIndex(0);
    setBatchNumberSuffix("");
    setBatchQuantity("");
    setTotalCost("");
    setExpiryDate("");
    // [v4.7] Drop server defaults + receipt fields so a reopen refetches them.
    setReceivingDefaults(null);
    setPurchaseDate("");
    setSupplierName("");
    setCatalogInfo(null);
    setStep(1);
    setPendingQuickScanBarcode("");
    setQuickScanConsumed(false);
    setBarcodeGate({ unitIndex: null, candidates: [] });
    scanBufferRef.current = [];
    setScanBuffer([]);
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
        barcodes: [],
        barcodeDraft: "",
        // [v4.6] No imageUrl on units anymore — image is on the product.
      },
    ]);
  };

  const handleRemoveUnit = (index: number) => {
    // Unit 0 is always the product's base unit (T3a §0: the first unit
    // entered at creation automatically becomes Product.baseUnitId, with
    // conversionFactor locked to 1). Removing it would leave the NEW index 0
    // displayed as the base unit while its state still held its real factor,
    // and the field is locked so the user could never fix it. Defense in depth
    // alongside hiding the delete button for idx === 0 in the JSX.
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

    // Shift the gate's unit index down when an EARLIER unit was removed, and
    // clear it only on an exact match.
    setBarcodeGate((prev) => {
      if (prev.unitIndex === null) return prev;
      if (prev.unitIndex === index) return { unitIndex: null, candidates: [] };
      if (prev.unitIndex > index) return { ...prev, unitIndex: prev.unitIndex - 1 };
      return prev;
    });
  };

  const handleUnitChange = (index: number, field: keyof UnitForm, value: any) => {
    const updated = [...units];
    updated[index] = { ...updated[index], [field]: value };
    setUnits(updated);
  };

  /** Every barcode already CONFIRMED on any unit of this form. */
  const confirmedBarcodes = (source: UnitForm[]) =>
    source.flatMap((u) => u.barcodes.map((b) => b.barcode));

  /**
   * [v4.5] Splits one input/paste into individual barcode values. `;`, tab and
   * newline are the separators, mirroring the CSV import's rule; a single
   * value (the overwhelmingly common case) behaves exactly as before.
   */
  const splitBarcodeInput = (raw: string): string[] =>
    raw
      .split(/[;\n\t]+/)
      .map((v) => v.trim())
      .filter(Boolean);

  const clearUnitBarcodeDraft = (unitIndex: number) => {
    setUnits((prev) => {
      const updated = [...prev];
      if (updated[unitIndex]) {
        updated[unitIndex] = { ...updated[unitIndex], barcodeDraft: "" };
      }
      return updated;
    });
    // A still-open gate for this unit would be pointing at a draft that no
    // longer exists — close it.
    setBarcodeGate((prev) =>
      prev.unitIndex === unitIndex ? { unitIndex: null, candidates: [] } : prev
    );
  };

  const focusBarcodeInput = (unitIndex: number) => {
    // Next tick: the confirmation dialog has to finish closing (and release
    // its focus trap) before focus can land back on the input.
    setTimeout(() => barcodeInputRefs.current[unitIndex]?.focus(), 60);
  };

  /**
   * Opens the mandatory confirmation gate for EVERY new barcode found in what
   * the merchant entered (one row per barcode), and loads the shared-catalog
   * match for each so a known GS1 barcode can use the simplified confirmation
   * view. The gate is always (re)opened from scratch, so no previous
   * classification can carry over.
   */
  const requestBarcodeClassification = (unitIndex: number, rawValue: string) => {
    // [UX] A classification session is already open — never re-open or replace
    // it (Enter followed by a stray second event would otherwise remount the
    // modal and wipe the merchant's clicks).
    if (barcodeGate.unitIndex !== null) return;

    // De-duplicate WITHIN this single input/paste itself, before comparing
    // against what's already confirmed elsewhere ("123;123" must never produce
    // two rows for one physical barcode).
    const parsed = Array.from(new Set(splitBarcodeInput(rawValue)));

    if (parsed.length === 0) {
      // [UX] Deliberately does NOT clear catalogInfo: an empty field firing
      // this (e.g. tabbing through it) used to wipe the shared-catalog banner
      // the merchant had just earned from the step-1 scan.
      clearUnitBarcodeDraft(unitIndex);
      return;
    }

    // A barcode resolves to exactly one unit tenant-wide, so it can never
    // belong to two units of the same product. Caught here with a friendly
    // message instead of a 400 after the whole form has been filled in; the
    // backend re-checks independently.
    const used = new Set(confirmedBarcodes(units));
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
      const updated = [...prev];
      const unit = updated[unitIndex];
      if (!unit) return prev;
      const existing = new Set(unit.barcodes.map((b) => b.barcode));
      const added = selections.filter((s) => !existing.has(s.barcode));
      updated[unitIndex] = {
        ...unit,
        barcodes: [
          ...unit.barcodes,
          ...added.map((s) => ({ barcode: s.barcode, barcodeSource: s.barcodeSource })),
        ],
        // The draft has been consumed — it is a confirmed chip now.
        barcodeDraft: "",
      };
      return updated;
    });

    setBarcodeGate({ unitIndex: null, candidates: [] });
    // [UX] Ready for the next scan/typed barcode with no extra click.
    focusBarcodeInput(unitIndex);
  };

  const handleBarcodeSourceDismiss = () => {
    const { unitIndex } = barcodeGate;
    if (unitIndex !== null) {
      // Spec: dismissing the gate means the barcode VALUE is not saved either —
      // which is exactly why the draft (not just a "source" field) is cleared.
      clearUnitBarcodeDraft(unitIndex);
    }
    setBarcodeGate({ unitIndex: null, candidates: [] });
  };

  /** Removes a barcode chip that has not been saved yet (create screen). */
  const handleRemoveUnitBarcode = (unitIndex: number, barcode: string) => {
    setUnits((prev) => {
      const updated = [...prev];
      const unit = updated[unitIndex];
      if (!unit) return prev;
      updated[unitIndex] = {
        ...unit,
        barcodes: unit.barcodes.filter((b) => b.barcode !== barcode),
      };
      return updated;
    });
  };

  /**
   * [v4.5] Looks up EVERY freshly entered barcode in the shared catalog in one
   * pass. Two things come out of it:
   *   1. per-barcode matches, folded back into the open confirmation gate, so a
   *      barcode the platform already knows gets the simplified one-click GS1
   *      view while every other row gets the full GS1/INTERNAL choice;
   *   2. the FIRST match also drives the one-time name/category/image
   *      suggestion banner.
   * A miss is NOT an error and never blocks classification.
   */
  const lookupCatalogMatches = (barcodesList: string[], targetUnitIndex: number) => {
    if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);

    lookupTimerRef.current = setTimeout(async () => {
      lookupAbortRef.current?.abort();
      const controller = new AbortController();
      lookupAbortRef.current = controller;

      const matches: Record<string, { name: string } | null> = {};
      const foundEntries: CatalogEntryInfo[] = [];

      await Promise.all(
        barcodesList.map(async (value) => {
          try {
            const res = await fetch(`/api/catalog/lookup?barcode=${encodeURIComponent(value)}`, {
              signal: controller.signal,
            });
            const data = await res.json();
            if (res.ok && data.success && data.entry) {
              matches[value] = { name: data.entry.name };
              foundEntries.push(data.entry as CatalogEntryInfo);
            } else {
              matches[value] = null;
            }
          } catch (err: any) {
            if (err?.name === "AbortError") return;
          }
        })
      );

      // Fold the matches into the gate — only rows still present there are
      // updated (the merchant may have confirmed or dismissed meanwhile).
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

      const firstEntry = foundEntries[0];
      if (!firstEntry) {
        setCatalogInfo(null);
        return;
      }

      setCatalogInfo(firstEntry);
      if (firstEntry.name) setName((prev) => prev || firstEntry.name);

      const suggestedCategory = firstEntry.category;
      if (suggestedCategory) setCategory((prev) => prev || suggestedCategory);

      const suggestedImage = firstEntry.imageUrl;
      // [v4.6] Catalog image is now suggested at the product level.
      if (suggestedImage && !imageUrl) {
        setImageUrl(suggestedImage);
      }

      toast.success(`تم العثور على المنتج في الكتالوج المشترك: "${firstEntry.name}"`);
    }, 300);
  };

  // [v4.5 UX] The unit scanner runs in CONTINUOUS mode: each accepted scan only
  // lands in the buffer (a barcode still sitting in front of the camera is
  // ignored); the whole batch is classified once, when the scanner closes.
  const handleBarcodeScanResult = (scannedBarcode: string) => {
    const value = scannedBarcode.trim();
    if (!value || scanBufferRef.current.includes(value)) return;
    scanBufferRef.current = [...scanBufferRef.current, value];
    setScanBuffer(scanBufferRef.current);
  };

  const handleScannerOpenChange = (isOpen: boolean) => {
    setScannerModalOpen(isOpen);
    if (isOpen) return;

    const collected = scanBufferRef.current;
    scanBufferRef.current = [];
    setScanBuffer([]);

    if (collected.length > 0) {
      requestBarcodeClassification(activeUnitForScan, collected.join(";"));
    }
  };

  const openUnitScanner = (unitIndex: number) => {
    scanBufferRef.current = [];
    setScanBuffer([]);
    setActiveUnitForScan(unitIndex);
    setScannerModalOpen(true);
  };

  const handleCropResult = (croppedDataUrl: string) => {
    // [v4.6] Crop result now goes to the product-level imageUrl, not a unit.
    setImageUrl(croppedDataUrl);
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
        if (data.entry.imageUrl) setImageUrl((prev) => prev || data.entry.imageUrl);
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
      // [v4.6] Image lives on the product, not on individual units.
      const gate = checkProductPublishable({
        isActive: true,
        imageUrl: imageUrl.trim() || null,
        units: units.map(() => ({ isActive: true })),
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

      // [v4.5 UX] The barcode from the quick scan is handed to the BASE unit's
      // draft field instead of popping the confirmation modal mid-navigation.
      // The merchant sees it sitting in the barcode field on the next step (and
      // can move it/remove it, e.g. when it actually belongs to a carton), and
      // the step-2 "next" check refuses to continue until it is classified —
      // so nothing is silently lost if the modal is later dismissed.
      const quick = pendingQuickScanBarcode.trim();
      if (quick && !quickScanConsumed) {
        setQuickScanConsumed(true);
        setUnits((prev) => {
          const updated = [...prev];
          const current = updated[0].barcodeDraft.trim();
          updated[0] = {
            ...updated[0],
            barcodeDraft: current ? `${current};${quick}` : quick,
          };
          return updated;
        });
      }
    }

    if (step === 2) {
      if (units.some((u) => !u.unitName.trim() || u.conversionFactor <= 0 || u.priceWholesale <= 0)) {
        toast.error("يرجى التأكد من ملء جميع الوحدات بمعامل تحويل وسعر جملة أكبر من الصفر.");
        return;
      }

      const packagingCheck = validatePackagingUnits(units);
      if (!packagingCheck.valid) {
        toast.error(packagingCheck.error);
        return;
      }

      // [v4.5] Barcodes. The two real failure modes are a gate left open
      // mid-classification, and a value typed/scanned but never classified.
      if (barcodeGate.unitIndex !== null) {
        toast.error("يرجى إكمال تصنيف مصدر الباركود المعلّق قبل المتابعة.");
        return;
      }
      const pendingDraftIndex = units.findIndex((u) => u.barcodeDraft.trim().length > 0);
      if (pendingDraftIndex !== -1) {
        toast.error("يوجد باركود لم يكتمل تصنيفه — يرجى تأكيد مصدره قبل المتابعة.");
        requestBarcodeClassification(pendingDraftIndex, units[pendingDraftIndex].barcodeDraft);
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

    const packagingCheck = validatePackagingUnits(units);
    if (!packagingCheck.valid) {
      toast.error(packagingCheck.error);
      setStep(2);
      return;
    }

    // [v4.5] Submitting with a draft still present would silently discard what
    // the merchant typed, so the gate is opened for that unit and this submit
    // is aborted — press submit again once resolved.
    if (barcodeGate.unitIndex !== null) {
      toast.error("يرجى إكمال تصنيف مصدر الباركود المعلّق قبل الحفظ.");
      setStep(2);
      return;
    }

    const pendingDraftIndex = units.findIndex((u) => u.barcodeDraft.trim().length > 0);
    if (pendingDraftIndex !== -1) {
      toast.error("يوجد باركود لم يكتمل تصنيفه — يرجى تأكيد مصدره قبل الحفظ.");
      setStep(2);
      requestBarcodeClassification(pendingDraftIndex, units[pendingDraftIndex].barcodeDraft);
      return;
    }

    if (hasInitialBatch && !isPositiveAmount(batchQuantity)) {
      toast.error("يرجى إدخال كمية أكبر من الصفر للدفعة المخزونية الأولية، أو إلغاء تفعيلها.");
      return;
    }

    if (hasInitialBatch && !batchNumberSuffix.trim()) {
      // [v4.4, Section 10] An empty merchant part would collapse every batch
      // created on the same day down to an identical batchNumber. Rejected here
      // for a friendly message; the backend rejects it independently.
      toast.error("يرجى إدخال رقم الدفعة (الجزء الخاص بك) — لا يمكن تركه فارغاً.");
      return;
    }

    if (hasInitialBatch && !isPositiveAmount(totalCost)) {
      // [Batch cost entry] Same positive-decimal rule the backend applies to
      // initialBatch.totalCost.
      toast.error("يرجى إدخال إجمالي التكلفة المدفوعة (رقم أكبر من صفر، بالليرة السورية).");
      return;
    }

    // [v4.7] The purchase date must exist and be within the SERVER-provided
    // window (minDate..businessDate). Bounds are plain string comparisons
    // against the server's own values — the device clock is never consulted.
    // If the defaults request failed, saving an initial batch is blocked:
    // there is deliberately no device-clock fallback (products WITHOUT an
    // initial batch can still be saved).
    if (hasInitialBatch && (!receivingDefaults || !purchaseDate)) {
      toast.error(
        "تعذّر تحميل تاريخ الاستلام من الخادم — لا يمكن حفظ دفعة بدونه (لا يُستخدم تاريخ الجهاز أبداً)."
      );
      return;
    }
    if (hasInitialBatch && purchaseDate > receivingDefaults!.businessDate) {
      toast.error("لا يمكن تسجيل استلام بتاريخ في المستقبل.");
      return;
    }
    if (hasInitialBatch && purchaseDate < receivingDefaults!.minDate) {
      toast.error("لا يمكن تسجيل استلام بتاريخ أقدم من سنتين (730 يوماً).");
      return;
    }

    if (isPublic) {
      // [v4.6] Image is at the product level.
      const gate = checkProductPublishable({
        isActive: true,
        imageUrl: imageUrl.trim() || null,
        units: units.map(() => ({ isActive: true })),
      });
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
        // [v4.6] Product-level image — sent at top level, not per unit.
        imageUrl: imageUrl.trim() || null,
        isPublic,
        // Every Decimal-backed field goes through `toDecimalString`.
        // [v4.5] `barcodes` is the unit's FULL confirmed list, each entry
        // carrying its own human-confirmed source; the route issues one
        // createUnitBarcode() per element inside its own transaction (T1's
        // nested-write rule).
        units: units.map((u) => ({
          unitName: u.unitName.trim(),
          conversionFactor: toDecimalString(Number(u.conversionFactor)),
          pricingCurrency: u.pricingCurrency,
          priceWholesale: toDecimalString(Number(u.priceWholesale)),
          barcodes: u.barcodes.map((b) => ({
            barcode: b.barcode,
            barcodeSource: b.barcodeSource,
          })),
        })),
        initialBatch: hasInitialBatch
          ? {
            unitIndex: batchUnitIndex,
            // [v4.4, Section 10] The merchant-supplied SUFFIX only — the
            // date prefix is added server-side at creation time.
            batchNumberSuffix: batchNumberSuffix.trim(),
            // [Batch cost entry — UNIFIED] Both sent exactly as typed:
            // `quantity` is in the SELECTED unit and `totalCost` is what was
            // paid for that whole quantity; the server derives the stored
            // per-base-unit cost.
            quantity: batchQuantity.trim(),
            totalCost: totalCost.trim(),
            expiryDate: expiryDate || null,
            // [v4.7] PERSISTED receiving date + optional supplier, both from
            // the SERVER defaults above — never the device clock.
            purchaseDate,
            ...(supplierName.trim() ? { supplierName: supplierName.trim() } : {}),
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

  // [Batch cost entry] Live derivation for the initial-batch section — built on
  // the SAME function the server runs, so the figure shown here is exactly what
  // gets stored. Null until both values are derivable.
  const selectedBatchUnit = units[batchUnitIndex];
  const initialBatchCostBreakdown = costBreakdownForDisplay(
    totalCost.trim(),
    batchQuantity.trim(),
    selectedBatchUnit?.conversionFactor ?? 0
  );

  const baseUnitName = units[0]?.unitName.trim() || "الوحدة الأساسية";
  const imageIsUploaded = imageUrl.startsWith("data:");

  return (
    <>
      <ModalShell
        open={open}
        onOpenChange={handleOpenChange}
        title="إضافة منتج جديد"
        icon={PackagePlus}
        description="بيانات المنتج، ووحداته وأسعاره، وباركوداته."
        header={<ModalStepper steps={STEP_LABELS} current={step} />}
        onSubmit={handleSubmit}
        onKeyDown={handleFormKeyDown}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
              className="text-slate-600"
            >
              إلغاء
            </Button>
            <div className="flex flex-1 items-center justify-end gap-2 sm:flex-none">
              {step > 1 && (
                <Button
                  key="back-btn"
                  type="button"
                  variant="outline"
                  onClick={goBack}
                  disabled={loading}
                  className="flex-1 sm:flex-none"
                >
                  رجوع
                </Button>
              )}
              {/* Distinct keys keep React from reusing ONE <button> element when
                  it flips from type="button" to type="submit" — which used to
                  fire a submit from the very click that advanced the step. */}
              {step < 3 ? (
                <Button
                  key="next-btn"
                  type="button"
                  onClick={goNext}
                  className="flex-2 bg-emerald-600 hover:bg-emerald-700 sm:min-w-28 sm:flex-none"
                >
                  التالي
                </Button>
              ) : (
                <Button
                  key="submit-btn"
                  type="submit"
                  disabled={loading}
                  className="flex-2 bg-emerald-600 hover:bg-emerald-700 sm:min-w-28 sm:flex-none"
                >
                  {loading ? "جاري الحفظ..." : "حفظ المنتج"}
                </Button>
              )}
            </div>
          </>
        }
      >
        {catalogInfo && (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-sky-600" aria-hidden />
              <div>
                <p className="text-sm font-bold text-sky-900">تم جلب البيانات من الكتالوج المشترك (GS1)</p>
                <p className="text-xs text-sky-700">
                  {catalogInfo.name}
                  {catalogInfo.category ? ` (${catalogInfo.category})` : ""}
                </p>
              </div>
            </div>
            {!catalogInfo.isOwner && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReportModalOpen(true)}
                className="h-8 gap-1 border-sky-200 bg-white text-xs"
              >
                <AlertTriangle className="size-3.5 text-amber-500" aria-hidden />
                اقتراح تصحيح
              </Button>
            )}
          </div>
        )}

        {/* ------------------------------------------------------------ step 1 */}
        {step === 1 && (
          <>
            <section className="space-y-3 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50 p-4">
              <div className="flex items-start gap-3">
                <ScanBarcode className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
                <div>
                  <p className="text-sm font-bold text-emerald-900">عندك المنتج قدّامك؟ امسح الباركود أولاً</p>
                  <p className="text-xs text-emerald-800/80">
                    إذا كان مسجّلاً بالكتالوج المشترك، منعبّي الاسم والتصنيف تلقائياً.
                  </p>
                </div>
              </div>

              <div className="flex gap-2">
                <Input
                  type="text"
                  dir="ltr"
                  inputMode="numeric"
                  placeholder="الباركود"
                  aria-label="الباركود للبحث في الكتالوج"
                  value={pendingQuickScanBarcode}
                  onChange={(e) => {
                    setPendingQuickScanBarcode(e.target.value);
                    setQuickScanConsumed(false);
                    setQuickLookupState("idle");
                  }}
                  onKeyDown={(e) => {
                    // A keyboard-wedge scanner ends every scan with Enter: run
                    // the lookup right away instead of swallowing it.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (pendingQuickScanBarcode.trim()) runQuickCatalogCheck();
                    }
                  }}
                  className="h-10 flex-1 bg-white font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => runQuickCatalogCheck()}
                  disabled={!pendingQuickScanBarcode.trim() || quickLookupState === "loading"}
                  className="h-10 shrink-0 gap-1.5 bg-white"
                >
                  <Search className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{quickLookupState === "loading" ? "جارِ التحقق..." : "تحقق"}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setQuickScanModalOpen(true)}
                  aria-label="مسح بالكاميرا"
                  className="size-10 shrink-0 bg-white text-emerald-600"
                >
                  <Camera className="size-5" aria-hidden />
                </Button>
              </div>

              {quickLookupState === "loading" && (
                <p className="flex items-center gap-1.5 text-xs text-slate-600">
                  <RefreshCw className="size-3.5 animate-spin" aria-hidden />
                  جارِ البحث في الكتالوج المشترك...
                </p>
              )}
              {quickLookupState === "found" && catalogInfo && (
                <p className="flex items-start gap-1.5 text-xs text-emerald-700">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    لقينا هالباركود بالكتالوج المشترك: &quot;{catalogInfo.name}&quot; — تعبّى الاسم والتصنيف تلقائياً.
                  </span>
                </p>
              )}
              {quickLookupState === "not_found" && (
                <p className="flex items-start gap-1.5 text-xs text-slate-600">
                  <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>هالباركود غير مسجّل بالكتالوج المشترك — بيُعتبر منتج جديد، كمّل الإدخال يدوياً.</span>
                </p>
              )}
              {pendingQuickScanBarcode.trim() && (
                <p className="flex items-start gap-1.5 text-xs text-slate-500">
                  <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>رح يُضاف هالباركود للوحدة الأساسية بالخطوة الجاية، وبتقدر تنقله أو تحذفه هناك.</span>
                </p>
              )}
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="اسم المنتج الرئيسي" htmlFor="product-name" required>
                <Input
                  id="product-name"
                  type="text"
                  placeholder="مثال: زيت زيتون ممتاز 1 ليتر"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-11 text-base font-semibold"
                  autoFocus
                  required
                />
              </Field>

              <Field label="التصنيف / الفئة" htmlFor="product-category">
                <Input
                  id="product-category"
                  type="text"
                  placeholder="مثال: زيوت ومواد غذائية"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
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
                    // A cropped upload is a multi-kilobyte data URL — printing
                    // it into a text field made the input unreadable.
                    <p className="flex h-10 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600">
                      صورة مرفوعة من الجهاز
                    </p>
                  ) : (
                    <Input
                      type="text"
                      dir="ltr"
                      placeholder="رابط الصورة (اختياري)"
                      aria-label="رابط صورة المنتج"
                      value={imageUrl}
                      onChange={(e) => {
                        const newVal = e.target.value;
                        if (isPublic && !newVal.trim() && imageUrl.trim()) {
                          toast.error("ألغِ النشر أولاً");
                          return;
                        }
                        setImageUrl(newVal);
                      }}
                      className="h-10"
                    />
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCropModalOpen(true)}
                      className="h-9 gap-1.5"
                    >
                      <Crop className="size-4 text-sky-600" aria-hidden />
                      {imageUrl ? "تغيير الصورة" : "رفع وقص"}
                    </Button>
                    {imageUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (isPublic) {
                            toast.error("ألغِ النشر أولاً");
                            return;
                          }
                          setImageUrl("");
                        }}
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
          </>
        )}

        {/* ------------------------------------------------------------ step 2 */}
        {step === 2 && (
          <>
            {units.map((unit, idx) => {
              const isPendingClassification = barcodeGate.unitIndex === idx;
              const unitLabel = unit.unitName.trim() || "الوحدة";
              // "كرتونة" → "الكرتونة"; a name already starting with "ال" is
              // left alone, so the label never doubles the article.
              const unitLabelDefinite = unitLabel.startsWith("ال") ? unitLabel : `ال${unitLabel}`;
              return (
                <section key={idx} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">
                        {idx === 0 ? "الوحدة الأساسية" : `وحدة تجميعية #${idx + 1}`}
                      </h3>
                      {idx === 0 && (
                        <p className="mt-0.5 text-xs text-slate-500">
                          هي الوحدة اللي بينحسب فيها المخزون، وكل الوحدات التانية بتُقاس عليها.
                        </p>
                      )}
                    </div>
                    {/* The base unit (idx 0) can never be removed (T3a §0) —
                        see handleRemoveUnit()'s matching guard above. */}
                    {idx !== 0 && units.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveUnit(idx)}
                        aria-label="حذف الوحدة"
                        className="size-9 shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    )}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="اسم الوحدة" htmlFor={`unit-name-${idx}`} required>
                      <Input
                        id={`unit-name-${idx}`}
                        type="text"
                        placeholder="مثال: قطعة / كرتونة / طرد"
                        value={unit.unitName}
                        onChange={(e) => handleUnitChange(idx, "unitName", e.target.value)}
                        required
                      />
                    </Field>

                    {/* T3a §0: the base unit's factor is locked to 1 and is not
                        even shown. Every other unit states its factor
                        RELATIVE to the base unit, in words. */}
                    {idx !== 0 && (
                      <Field
                        label={`${unitLabel} الواحدة تساوي كم ${baseUnitName}؟`}
                        htmlFor={`unit-factor-${idx}`}
                        required
                        hint={`مثال: ${unitLabelDefinite} = 24 ${baseUnitName}`}
                      >
                        <DecimalInput
                          id={`unit-factor-${idx}`}
                          placeholder="مثال: 24"
                          // Typed text lives inside DecimalInput, so the field can
                          // be cleared and retyped freely (80, 0.5, 0.25 ...).
                          // validatePackagingUnits() and the step-2 check reject a
                          // submitted value <= 0.
                          value={unit.conversionFactor}
                          onValueChange={(v) => handleUnitChange(idx, "conversionFactor", v)}
                          required
                        />
                      </Field>
                    )}

                    <Field label="العملة" className={idx === 0 ? "" : undefined}>
                      <Segmented
                        ariaLabel="عملة التسعير"
                        value={unit.pricingCurrency}
                        onChange={(v) => handleUnitChange(idx, "pricingCurrency", v)}
                        options={[
                          { value: "SYP", label: "ليرة سورية" },
                          { value: "USD", label: "دولار" },
                        ]}
                      />
                    </Field>

                    <Field
                      label={idx === 0 ? `سعر بيع ${unitLabelDefinite} (POS)` : `سعر ${unitLabelDefinite} (POS)`}
                      htmlFor={`unit-price-${idx}`}
                      required
                    >
                      <div className="relative">
                        <DecimalInput
                          id={`unit-price-${idx}`}
                          placeholder="0"
                          value={unit.priceWholesale}
                          onValueChange={(v) => handleUnitChange(idx, "priceWholesale", v)}
                          className="pe-12 font-semibold tabular-nums"
                          required
                        />
                        <span className="pointer-events-none absolute inset-e-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-500">
                          {unit.pricingCurrency === "USD" ? "$" : "ل.س"}
                        </span>
                      </div>
                    </Field>
                  </div>

                  {/* [v4.5 UX] ONE full-width barcode field per unit. Enter
                      (what a keyboard-wedge scanner sends after each scan), the
                      add button, or a pasted delimited list all start
                      classification. There is no blur trigger: tabbing away used
                      to pop the modal unexpectedly, and an unclassified value is
                      caught by the next-step / submit checks anyway. */}
                  <Field
                    label={`الباركودات${unit.barcodes.length > 0 ? ` (${unit.barcodes.length})` : ""}`}
                    htmlFor={`unit-barcode-${idx}`}
                  >
                    <div className="flex gap-2">
                      <Input
                        id={`unit-barcode-${idx}`}
                        ref={(el) => {
                          barcodeInputRefs.current[idx] = el;
                        }}
                        type="text"
                        dir="ltr"
                        inputMode="numeric"
                        placeholder="امسح أو اكتب الباركود ثم Enter"
                        value={unit.barcodeDraft}
                        onChange={(e) => handleUnitChange(idx, "barcodeDraft", e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            requestBarcodeClassification(idx, unit.barcodeDraft);
                          }
                        }}
                        onPaste={(e) => {
                          // A pasted LIST (one barcode per line, or `;`/tab
                          // separated) is classified together in one modal.
                          const text = e.clipboardData.getData("text");
                          if (/[;\n\t]/.test(text.trim())) {
                            e.preventDefault();
                            requestBarcodeClassification(
                              idx,
                              unit.barcodeDraft ? `${unit.barcodeDraft};${text}` : text
                            );
                          }
                        }}
                        className="h-10 flex-1 font-mono"
                      />
                      {/* Icon-only buttons: with text labels they ate most of
                          the row on a phone and cut the placeholder off. */}
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={!unit.barcodeDraft.trim()}
                        onClick={() => requestBarcodeClassification(idx, unit.barcodeDraft)}
                        aria-label="إضافة الباركود"
                        className="size-10 shrink-0"
                      >
                        <Plus className="size-5" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => openUnitScanner(idx)}
                        aria-label="مسح بالكاميرا"
                        className="size-10 shrink-0 text-emerald-600"
                      >
                        <Camera className="size-5" aria-hidden />
                      </Button>
                    </div>

                    {/* The unit's CONFIRMED barcodes (already classified).
                        Removing one here only edits local state — nothing has
                        been saved yet; once the product exists, removal goes
                        through the ADMIN-only DELETE barcode route instead. */}
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
                            <button
                              type="button"
                              onClick={() => handleRemoveUnitBarcode(idx, b.barcode)}
                              aria-label={`إزالة الباركود ${b.barcode}`}
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
                          كل هالباركودات بتنباع كنفس الصنف: مخزون وسعر واحد، والفاتورة ما بتسجّل أي باركود انمسح. إذا
                          كل نكهة إلها مخزون منفصل، أضفها كمنتج مستقل.
                        </span>
                      </p>
                    )}

                    {isPendingClassification && (
                      <p className="flex items-center gap-1.5 text-xs text-amber-700">
                        <ShieldAlert className="size-4 shrink-0" aria-hidden />
                        بانتظار تأكيد مصدر الباركود بالنافذة المنبثقة...
                      </p>
                    )}
                  </Field>
                </section>
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
          </>
        )}

        {/* ------------------------------------------------------------ step 3 */}
        {step === 3 && (
          <>
            <div className="space-y-1 rounded-lg bg-slate-50 p-4">
              <p className="text-base font-bold text-slate-900">{name || "—"}</p>
              {category && <p className="text-xs text-slate-500">{category}</p>}
              <p className="text-xs text-slate-500">
                {units.length} {units.length === 1 ? "وحدة قياس" : "وحدات قياس"}
                {isPublic ? " · معروض بالمتجر الإلكتروني" : ""}
              </p>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-3">
              <div>
                <label htmlFor="is-public-toggle" className="text-sm font-semibold text-slate-900">
                  عرض المنتج بمتجر العملاء الإلكتروني
                </label>
                <p className="mt-0.5 text-xs text-slate-500">
                  بحتاج صورة للمنتج — وبتقدر تفعّله لاحقاً من صفحة المنتج.
                </p>
              </div>
              {/* dir="ltr": the stock shadcn Switch slides its thumb to the
                  physical right when checked, wrong inside an RTL track. */}
              <Switch
                id="is-public-toggle"
                dir="ltr"
                checked={isPublic}
                onCheckedChange={handleTogglePublic}
                className="mt-0.5 data-[state=checked]:bg-emerald-600"
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-3">
              <label htmlFor="has-batch" className="text-sm font-semibold text-slate-900">
                إضافة دفعة مخزونية أولية فوراً
              </label>
              <Switch
                id="has-batch"
                dir="ltr"
                checked={hasInitialBatch}
                onCheckedChange={setHasInitialBatch}
                className="data-[state=checked]:bg-emerald-600"
              />
            </div>

            {hasInitialBatch && (
              <div className="grid gap-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 sm:grid-cols-2">
                <Field label="الوحدة المستلمة" htmlFor="batch-unit">
                  <NativeSelect
                    id="batch-unit"
                    value={batchUnitIndex}
                    onChange={(e) => setBatchUnitIndex(parseInt(e.target.value))}
                  >
                    {units.map((u, i) => (
                      <option key={i} value={i}>
                        {u.unitName || `وحدة ${i + 1}`}
                        {i === 0 ? " (أساسية)" : ` (= ${u.conversionFactor} ${baseUnitName})`}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>

                <Field
                  label={`الكمية المستلمة${selectedBatchUnit?.unitName ? ` (بوحدة ${selectedBatchUnit.unitName})` : ""}`}
                  htmlFor="batch-quantity"
                  required
                >
                  <Input
                    id="batch-quantity"
                    type="text"
                    inputMode="decimal"
                    dir="ltr"
                    placeholder="مثال: 6"
                    value={batchQuantity}
                    onChange={(e) => setBatchQuantity(e.target.value)}
                    className="bg-white"
                    required
                  />
                </Field>

                {/* [Batch cost entry — UNIFIED] The TOTAL the merchant actually
                    paid for the whole received quantity — never a per-base-unit
                    figure. */}
                <Field
                  label="إجمالي التكلفة المدفوعة (ل.س)"
                  htmlFor="batch-total-cost"
                  required
                  hint={
                    initialBatchCostBreakdown ? (
                      <span className="font-semibold text-emerald-700">
                        لكل {baseUnitName}: {initialBatchCostBreakdown.pricePerBaseUnit} ل.س
                      </span>
                    ) : undefined
                  }
                >
                  <Input
                    id="batch-total-cost"
                    type="text"
                    inputMode="decimal"
                    dir="ltr"
                    placeholder="مثال: 54000"
                    value={totalCost}
                    onChange={(e) => setTotalCost(e.target.value)}
                    className="bg-white"
                    required
                  />
                </Field>

                <Field label="تاريخ الانتهاء" htmlFor="batch-expiry">
                  <Input
                    id="batch-expiry"
                    type="date"
                    dir="ltr"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                    className="bg-white"
                  />
                </Field>

                {/* [v4.7] The PERSISTED goods-receiving date + optional
                    supplier (ProductReceipt.purchaseDate / supplierName).
                    Defaults and bounds come from GET /api/receipts/defaults —
                    the device clock is never consulted; while defaults are
                    unavailable the picker stays disabled and saving an initial
                    batch is blocked (no device-date fallback). */}
                <Field
                  label="تاريخ الشراء (يوم الاستلام)"
                  htmlFor="batch-purchase-date"
                  required
                >
                  <Input
                    id="batch-purchase-date"
                    type="date"
                    dir="ltr"
                    value={purchaseDate}
                    min={receivingDefaults?.minDate}
                    max={receivingDefaults?.businessDate}
                    onChange={(e) => setPurchaseDate(e.target.value)}
                    className="bg-white"
                    disabled={!receivingDefaults}
                    required
                  />
                </Field>

                <Field
                  label="المورّد (اختياري)"
                  htmlFor="batch-supplier"
                >
                  <Input
                    id="batch-supplier"
                    type="text"
                    maxLength={120}
                    placeholder="مثال: مورد الشام"
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                    className="bg-white"
                  />
                </Field>

                {!receivingDefaults && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 sm:col-span-2">
                    تعذّر تحميل تاريخ الاستلام من الخادم — أعد فتح النموذج للمحاولة مجدداً (لا يُستخدم تاريخ الجهاز أبداً).
                  </p>
                )}

                {/* [v4.4, Section 10] The date prefix is generated server-side
                    at save time and shown here read-only — the ADMIN types only
                    the merchant-supplied suffix. The prefix preview is the
                    SERVER business date (GET /api/receipts/defaults), NEVER the
                    browser clock; while defaults are unavailable a "—"
                    placeholder is shown. The group is LTR so it reads in
                    the same order as the stored value: 2026-10-05-1. */}
                <Field
                  label="رقم الدفعة الخاص بك"
                  htmlFor="batch-suffix"
                  required
                  className="sm:col-span-2"
                  hint="بينضاف تاريخ اليوم تلقائياً قبل الرقم اللي بتكتبه — لا تكتبه إنت."
                >
                  <div dir="ltr" className="flex items-center gap-2">
                    <span
                      aria-label="بادئة التاريخ التي يضيفها النظام"
                      className="shrink-0 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 font-mono text-sm font-semibold text-emerald-700"
                    >
                      {receivingDefaults ? `${receivingDefaults.businessDate}-` : "—-"}
                    </span>
                    <span className="text-slate-400" aria-hidden>
                      -
                    </span>
                    <Input
                      id="batch-suffix"
                      type="text"
                      placeholder="1 أو INV4471"
                      value={batchNumberSuffix}
                      onChange={(e) => setBatchNumberSuffix(e.target.value)}
                      className="flex-1 bg-white font-mono"
                      required
                    />
                  </div>
                </Field>
              </div>
            )}
          </>
        )}
      </ModalShell>

      {/* [v4.5 UX] Per-unit scanner: CONTINUOUS, so several barcodes can be
          scanned in one go; they are collected below the video and classified
          together in one confirmation modal when the merchant finishes.
          Requires the optional title / description / children props on
          BarcodeScannerModal. */}
      <BarcodeScannerModal
        open={scannerModalOpen}
        onOpenChange={handleScannerOpenChange}
        onScan={handleBarcodeScanResult}
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

      {/* The step-1 quick lookup stays single-shot. */}
      <BarcodeScannerModal open={quickScanModalOpen} onOpenChange={setQuickScanModalOpen} onScan={handleQuickScanResult} />

      <ImageCropModal open={cropModalOpen} onOpenChange={setCropModalOpen} onCropComplete={handleCropResult} />

      {/* [v4.5] ONE modal for this action's NEW barcodes, one radio group per
          barcode. The `key` is derived from the barcode set itself, so every
          new classification action mounts a brand-new instance and a
          previously-chosen source can never carry over onto a new value.
          (It deliberately does NOT include the catalog-match results, which
          arrive one network round-trip later — that would remount the modal
          and wipe the merchant's clicks mid-session.) */}
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