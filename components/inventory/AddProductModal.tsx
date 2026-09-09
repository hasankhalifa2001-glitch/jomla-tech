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

  // [ADDED] A dedicated, optional pre-step scan used ONLY to look the
  // barcode up in the shared catalog (ProductCatalogEntry) and pre-fill
  // name/category before the merchant types anything — see the modal-level
  // comment further down for why this was previously unreachable dead
  // code. This is NOT a commit of any unit's barcode; it never writes into
  // `units` on its own. It is copied into the base unit's barcode field
  // (and put through the exact same mandatory classification modal as any
  // other barcode entry) only once the merchant reaches Step 2.
  const [quickScanModalOpen, setQuickScanModalOpen] = useState(false);
  const [pendingQuickScanBarcode, setPendingQuickScanBarcode] = useState<string>("");
  const [quickScanConsumed, setQuickScanConsumed] = useState(false);
  // [FIX] Explicit, user-visible state for the dedicated "تحقق" button
  // below — "idle" before any check has run (or after the barcode text
  // changes, since a stale found/not_found result no longer describes the
  // current field value), "loading" while the request is in flight,
  // "found"/"not_found" once it resolves.
  const [quickLookupState, setQuickLookupState] = useState<"idle" | "loading" | "found" | "not_found">("idle");

  // ---------------------------------------------------------------------
  // [FIX — T3a §5] Mandatory barcodeSource confirmation gate.
  //
  // This is the SINGLE choke point through which a barcode value is ever
  // allowed to land in `units[i].barcode`. Nothing in this file sets
  // `units[i].barcode` directly from a raw keystroke or scan result
  // anymore — see `requestBarcodeClassification` below. This is what
  // makes "no unconfirmed barcode ever reaches handleSubmit" a structural
  // property of the component's data flow, not just a check bolted onto
  // the end of it.
  //
  // `pendingUnitIndex: null` means the modal is closed and there is no
  // barcode currently awaiting classification.
  // ---------------------------------------------------------------------
  const [barcodeGate, setBarcodeGate] = useState<{
    unitIndex: number | null;
    barcode: string;
  }>({ unitIndex: null, barcode: "" });

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

    // If the unit being removed was mid-classification in the barcode
    // gate, close the gate — there is nothing left to classify it for.
    if (barcodeGate.unitIndex === index) {
      setBarcodeGate({ unitIndex: null, barcode: "" });
    }
  };

  const handleUnitChange = (index: number, field: keyof UnitForm, value: any) => {
    const updated = [...units];
    updated[index] = { ...updated[index], [field]: value };
    setUnits(updated);
  };

  // -----------------------------------------------------------------------
  // [FIX — T3a §5, core of this fix] The one and only entry point for a
  // barcode value reaching a unit. Called from:
  //   (a) the manual barcode <Input>'s onBlur (typing a full value and
  //       moving on — NOT on every keystroke, so the modal doesn't fire
  //       mid-type),
  //   (b) the camera scanner's onScan result (a scan is atomic — the whole
  //       value arrives at once, so there is no "still typing" state to
  //       wait out), and
  //   (c) the quick pre-Step-1 scan, once its value is carried into the
  //       base unit at the start of Step 2.
  //
  // It does NOT write `units[i].barcode` itself. It only stages the value
  // in `barcodeGate` and opens the mandatory modal. The unit's actual
  // `barcode`/`barcodeSource` fields are written ONLY from
  // `handleBarcodeSourceConfirm` below, after an explicit human choice.
  //
  // Re-editing an existing, already-classified barcode on the same unit
  // goes through this exact same path — there is no separate "edit" code
  // path that could accidentally special-case that and skip the modal.
  // Per spec, the old barcodeSource must never be carried over onto a new
  // value: since `barcodeGate` starts a fresh classification every time
  // this function runs, and the PARENT mounts `BarcodeSourceModal` with a
  // `key` derived from `${unitIndex}-${barcode}` (see the JSX below),
  // React fully remounts that component on every new request — resetting
  // its internal `selected` state to null purely through normal
  // initialization, with no useEffect involved. That "never carried over"
  // guarantee holds automatically as a result.
  // -----------------------------------------------------------------------
  const requestBarcodeClassification = (unitIndex: number, rawBarcode: string) => {
    const cleaned = rawBarcode.trim();

    if (!cleaned) {
      // Clearing the field entirely is always allowed with no gate — an
      // empty barcode has no source to classify. Also clears any stale
      // classification left on this unit from a previous value.
      const updated = [...units];
      updated[unitIndex] = { ...updated[unitIndex], barcode: "", barcodeSource: "" };
      setUnits(updated);
      setCatalogInfo(null);
      return;
    }

    // A no-op re-blur of the exact same, already-classified value must not
    // reopen the modal every time the merchant tabs through the form —
    // only a genuinely NEW or NEWLY-TYPED value triggers classification.
    const currentUnit = units[unitIndex];
    if (currentUnit && currentUnit.barcode === cleaned && currentUnit.barcodeSource) {
      return;
    }

    // Immediately strip any previous classification on this unit — the
    // instant the value changes, its old barcodeSource is stale and must
    // never survive into a submit by accident, even if the merchant closes
    // the modal without completing the new classification (in which case
    // requestBarcodeClassification's own dismiss handler additionally
    // clears the barcode value itself, per spec — see below).
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

  // [FIX — T3a §5] "barcodeSource stays null if the modal is dismissed,
  // and in that case the barcode value itself is also not saved." A
  // dismissal here means the unit's barcode field is wiped back to empty,
  // not left populated with an unclassified value.
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

  // `targetUnitIndex` is an explicit, required parameter rather than
  // implicitly reading `activeUnitForScan` from state — that state is only
  // ever updated when the camera scanner is opened, never when a barcode
  // is typed manually into a specific unit's input, so relying on it here
  // could silently apply the catalog's suggested image to the wrong unit.
  //
  // Debounced (300ms) and cancels any in-flight request before starting a
  // new one, so a fast keystroke can't have its response overwritten by a
  // slower, now-stale one that lands later.
  //
  // NOTE: this lookup is a read-only convenience against the shared
  // catalog and is intentionally decoupled from barcodeSource
  // classification — it may run against a barcode still awaiting
  // classification in `barcodeGate`, since suggesting a name/photo carries
  // none of the "is this barcode shareable" weight that GS1-vs-INTERNAL
  // does.
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
  // the merchant wrote themselves. A scan is therefore routed through the
  // exact same mandatory classification gate as manual entry — it fills
  // nothing directly, it only stages the value and opens the modal.
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

  // [FIX] A dedicated, EXPLICIT catalog check — no debounce, no silent
  // onBlur trigger. The merchant presses a button and immediately sees one
  // of three states rendered right under the field: checking..., found
  // (with the matched name), or not found (a plain, non-alarming "this
  // will be treated as a new product" note). This replaces relying on
  // `onBlur` to fire a lookup the merchant has no direct way to observe
  // happening, with no visible confirmation afterward beyond a toast (and
  // the top-of-form banner) that's easy to miss inside a scrolling modal.
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

  // [ADDED] The optional pre-Step-1 quick scan. Purely a catalog lookup +
  // convenience carrier — see the state comment above. Also routed through
  // the same mandatory classification gate once its value is committed to
  // the base unit (at the top of Step 2), never bypassing it.
  //
  // Unlike manual typing, a camera scan IS a single, deliberate,
  // discrete action — there is no "still typing, don't check yet"
  // ambiguity to wait out — so it's reasonable (and expected) for this
  // path to trigger the check immediately rather than requiring a second
  // explicit button press.
  const handleQuickScanResult = (scannedBarcode: string) => {
    const cleaned = scannedBarcode.trim();
    setPendingQuickScanBarcode(cleaned);
    setQuickScanConsumed(false);
    setQuickLookupState("idle");
    // Run the same explicit check the button triggers, just automatically
    // since the scan itself was the deliberate trigger. Passed explicitly
    // rather than relying on `pendingQuickScanBarcode` from state, which
    // is not guaranteed to have re-rendered yet at this point.
    runQuickCatalogCheck(cleaned);
  };

  // [FIX — corrected from an earlier, WRONG assumption] Publishing to the
  // storefront requires BOTH a product photo AND a retail price on at
  // least one active unit — this is a literal, word-for-word acceptance
  // criterion in the Master Technical Specification (T3a): "isPublic =
  // true is blocked without both priceRetail and imageUrl." A previous
  // version of this file relaxed this to "image only," reasoning that
  // priceRetail is merely a display hint never charged on any sale — that
  // reasoning is true on its own, but it doesn't change what the spec's
  // publishing gate itself requires as a precondition for going public;
  // "never charged" and "not required to publish" are two independent
  // questions, and only the first one is actually true here. That
  // relaxed version also silently diverged from EditProductModal.tsx,
  // which already enforced the correct (image + retail price) rule via
  // this exact same `checkProductPublishable()` call — meaning a product
  // could be published from THIS form with only a photo, then immediately
  // fail re-validation the moment an admin opened it in Edit. Both forms
  // now share one call to one function, so the rule can only ever be
  // defined in one place.
  const handleTogglePublic = (checked: boolean) => {
    if (checked) {
      const candidateUnits = units.map((u) => ({
        isActive: true, // every unit created here starts active by default
        priceRetail: u.priceRetail === "" ? null : Number(u.priceRetail),
        imageUrl: u.imageUrl || null,
      }));

      const gate = checkProductPublishable({
        isActive: true, // a product being created is always active
        units: candidateUnits,
      });

      if (!gate.publishable) {
        toast.error(`لا يمكن نشر المنتج: ${gate.reason}`);
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

      // [ADDED] Carry the quick-scan barcode (if any) into the base unit
      // exactly once, right as Step 2 becomes visible, and route it
      // through the mandatory classification gate like any other entry.
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
      const enteredBarcodes = units.map((u) => u.barcode.trim()).filter(Boolean);
      if (new Set(enteredBarcodes).size !== enteredBarcodes.length) {
        toast.error("لا يمكن استخدام نفس الباركود لأكثر من وحدة قياس ضمن المنتج نفسه.");
        return;
      }
      // [FIX] Block advancing past Step 2 while any barcode sits
      // unclassified — this catches the case where a merchant typed a
      // barcode, tabbed away (firing the modal), then dismissed it or
      // clicked "التالي" before resolving it. Since dismissal already
      // clears the barcode value (see handleBarcodeSourceDismiss), this
      // check mainly guards the in-progress state where the gate is still
      // open when "التالي" is pressed.
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

    // [FIX — final line of defense, T3a §5] This is the hard backstop:
    // even if every UI gate above were somehow bypassed, a unit reaching
    // this point with a non-empty barcode and an empty barcodeSource is
    // rejected outright, exactly like the server-side Zod `.refine()` in
    // route.ts already does. Unlike the previous version of this file,
    // there is NO fallback to "INTERNAL" anywhere in this function —
    // silently defaulting an unclassified barcode was the actual bug.
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

    // [FIX] Same shared gate as handleTogglePublic above — image AND
    // retail price together, per T3a's literal acceptance criterion. This
    // is the final backstop before submit, mirroring
    // EditProductModal.tsx's own pre-save check via the same function.
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
          // [FIX] No fallback. If `u.barcode` is non-empty here,
          // `u.barcodeSource` is GUARANTEED non-empty too — the checks
          // above (goNext's Step-2 gate and this function's own hard
          // backstop) make that combination unreachable. If the barcode
          // is empty, barcodeSource is correctly sent as null.
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
              <div className="space-y-3">
                {/*
                  [ADDED] Optional quick-scan ahead of the name field.
                  Purely additive: a merchant who prefers to just type the
                  name (the previous, only workflow) can ignore this
                  entirely and nothing below behaves any differently for
                  them. A merchant standing in front of the physical
                  product can instead scan first, letting a shared-catalog
                  match prefill name/category before they type anything.
                  This scan does NOT commit any unit's barcode by itself —
                  see handleQuickScanResult and the Step-1 -> Step-2
                  transition in goNext for where it's actually carried
                  into the base unit and put through the same mandatory
                  classification modal as any other entry.
                */}
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

                  {/*
                    [FIX] Manual typing is now a first-class entry path
                    here, matching Step 2's per-unit barcode field pattern
                    — the camera was previously the ONLY way to use this
                    quick-lookup card, which is a real problem for a
                    merchant who already knows the barcode by heart, or
                    whose camera/lighting isn't cooperating. This input
                    does NOT commit anything or open the mandatory
                    classification modal by itself — it only stages the
                    value the exact same way a scan result does (see
                    handleQuickScanResult), triggering only the read-only
                    catalog lookup. Classification still only ever happens
                    once this value is carried into the base unit at the
                    Step 1 -> Step 2 transition (goNext), same as before.
                  */}
                  <div className="flex items-center gap-1.5">
                    <Input
                      placeholder="اكتب الباركود هنا يدوياً..."
                      value={pendingQuickScanBarcode}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPendingQuickScanBarcode(val);
                        setQuickScanConsumed(false);
                        // Any edit to the barcode text invalidates a
                        // previous found/not_found result — it described
                        // a DIFFERENT value. Back to idle until the
                        // merchant explicitly re-checks.
                        setQuickLookupState("idle");
                      }}
                      className={`${FIELD_H} font-mono bg-white dark:bg-zinc-900`}
                    />
                    {/*
                      [FIX] This is now the ONLY thing that triggers a
                      catalog check for manually-typed text — no more
                      relying on `onBlur`, which the merchant has no way
                      to perceive happening and which was easy to miss
                      entirely if they clicked straight into the next
                      field. Pressing this button runs the check
                      immediately (no debounce delay) and the result is
                      shown right below, not just as a toast or a banner
                      elsewhere in a scrollable modal.
                    */}
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

                  {/*
                    [FIX] Explicit, always-visible result of the check —
                    directly under the field the merchant is looking at,
                    not a banner that renders elsewhere in the form and
                    can be scrolled out of view. This is the concrete
                    answer to "I typed a barcode and waited, nothing
                    happened": now something ALWAYS visibly happens,
                    in one of exactly three states.
                  */}
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
                        <div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                            <div>
                              <Label className="text-[11px]">تصنيف الباركود</Label>
                              {/*
                                [FIX] This is now a READ-ONLY status
                                indicator, not an editable <select>. The
                                previous dropdown let a merchant leave this
                                on "بدون تصنيف" and still submit — which is
                                exactly the silent-default bug this fix
                                closes. The only way to set or change this
                                value now is through the mandatory
                                BarcodeSourceModal, triggered from the
                                barcode field itself below.
                              */}
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
                                  // While typing, only update the visible
                                  // text — do NOT open the classification
                                  // modal on every keystroke. The modal
                                  // opens on blur (a full value was
                                  // entered) via requestBarcodeClassification.
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
                    );
                  })}
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

            {/*
              Footer: stacked, full-width buttons on mobile with the
              primary action (Next / Save) last in DOM order so it sits at
              the bottom of the sheet — closest to a thumb holding the
              phone. Reverts to a compact inline row at sm: and up.

              [FIX] Each of the "Next" and "Save" buttons is given a
              distinct, stable `key` ("next-btn" vs "submit-btn"). Without
              this, React treats them as the *same* element across a
              step 2 -> step 3 transition (same position in the tree, same
              parent) and reuses the existing <button> DOM node, merely
              flipping its `type` attribute from "button" to "submit".
              That mutation can land mid-click: the browser dispatches the
              click against a node that was type="button" when pressed but
              has become type="submit" by the time it checks what to do
              with the event, firing an unwanted form submit on the
              step 2 -> 3 transition. Distinct keys force React to unmount
              the old node and mount a fresh one instead of morphing it in
              place, so a "Next" click can never be reinterpreted as a
              "Submit" click.
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

      {/* Barcode Scanner Modal (per-unit, Step 2) */}
      <BarcodeScannerModal
        open={scannerModalOpen}
        onOpenChange={setScannerModalOpen}
        onScan={handleBarcodeScanResult}
      />

      {/* [ADDED] Quick pre-Step-1 scanner — catalog lookup convenience only,
          shares the same underlying scanner component. */}
      <BarcodeScannerModal
        open={quickScanModalOpen}
        onOpenChange={setQuickScanModalOpen}
        onScan={handleQuickScanResult}
      />

      {/* Image Crop Modal */}
      <ImageCropModal
        open={cropModalOpen}
        onOpenChange={setCropModalOpen}
        onCropComplete={handleCropResult}
      />

      {/*
        [FIX — T3a §5] The mandatory barcodeSource confirmation gate.
        Rendered unconditionally (open is controlled by barcodeGate) so it
        can appear regardless of which step is currently visible — in
        practice this only happens while Step 2 is showing, since that is
        the only place `requestBarcodeClassification` is ever called from
        (manual entry's onBlur and the scanner's onScan both live there),
        but the gate's own open state deliberately doesn't depend on
        `step` to stay correct even if a future change adds another
        barcode entry point elsewhere in the wizard.
      */}
      <BarcodeSourceModal
        // [FIX] `key` forces a full unmount/remount whenever a DIFFERENT
        // barcode-classification request starts — a different unit, or a
        // new value on the same unit (re-editing an existing barcode).
        // This is what makes BarcodeSourceModal's own internal `selected`
        // state reset to `null` correctly, WITHOUT that component needing
        // a useEffect to do it (see the [FIX] comment on that component
        // for why the effect-based version triggered React's
        // setState-in-effect warning). When the gate is closed
        // (unitIndex === null), the key stays stable at "closed" so the
        // dialog's own closing animation isn't interrupted by an
        // unrelated remount.
        key={barcodeGate.unitIndex !== null ? `${barcodeGate.unitIndex}-${barcodeGate.barcode}` : "closed"}
        open={barcodeGate.unitIndex !== null}
        barcode={barcodeGate.barcode}
        onConfirm={handleBarcodeSourceConfirm}
        onDismiss={handleBarcodeSourceDismiss}
        // [FIX] Only pass a match when `catalogInfo` actually describes
        // THIS specific barcode currently awaiting classification.
        // `catalogInfo` is a single shared piece of state also used by
        // the top-of-form banner and the quick-scan card — without this
        // guard, a stale match left over from a PREVIOUSLY typed barcode
        // (e.g. the merchant tried one barcode, got a match, then edited
        // the field to a completely different number that has no match
        // of its own) could incorrectly suggest GS1 for a barcode that
        // was never actually found in the catalog.
        catalogMatch={
          catalogInfo && catalogInfo.barcode === barcodeGate.barcode
            ? { name: catalogInfo.name }
            : null
        }
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