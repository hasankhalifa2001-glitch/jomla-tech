/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calculator, Layers } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils/money";
// [Batch cost entry] The ONE shared derivation the server also runs
// (costFromTotal() underneath) — so the figures shown live in this form can
// never diverge from the value the server stores. See that function's note
// in lib/inventory/units.ts.
import { costBreakdownForDisplay } from "@/lib/inventory/units";
import Decimal from "decimal.js";


const AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;
function isPositiveAmount(value: string): boolean {
  const v = value.trim();
  if (!AMOUNT_REGEX.test(v)) return false;
  try { return new Decimal(v).gt(0); } catch { return false; }
}

/** "كرتونة" → "الكرتونة"; a name that already starts with "ال" is left alone. */
const withAl = (name: string): string => (name.startsWith("ال") ? name : `ال${name}`);

interface ProductUnitItem {
  id: string;
  unitName: string;
  conversionFactor: number;
  isActive?: boolean;
  isBaseUnit?: boolean;
}

interface ProductItem {
  id: string;
  name: string;
  units: ProductUnitItem[];
}

interface AddBatchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: ProductItem[];
  preselectedProductId?: string;
  onSuccess: () => void;
}

// [v4.7] The SERVER-supplied receiving defaults — { businessDate, minDate }
// from GET /api/receipts/defaults. The default purchase date AND the
// batchNumber date-prefix preview come from HERE, never from the device
// clock: if the request fails, receivingDefaults stays null, the preview
// renders a placeholder and the submit button is disabled (there is no
// device-clock fallback, ever).
interface ReceivingDefaults {
  businessDate: string;
  minDate: string;
}

/** One line of the green cost-summary card: label on the right, value on the left. */
function SummaryRow({
  label,
  hint,
  value,
  strong,
}: {
  label: string;
  hint?: string;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-2.5",
        strong && "bg-emerald-100/70 dark:bg-emerald-900/30"
      )}
    >
      <dt className="min-w-0">
        <span className="block text-xs font-medium text-emerald-900 dark:text-emerald-200">{label}</span>
        {hint && <span className="block text-[11px] text-emerald-700/80 dark:text-emerald-400/80">{hint}</span>}
      </dt>
      <dd
        className={cn(
          "shrink-0 tabular-nums text-emerald-900 dark:text-emerald-100",
          strong ? "text-base font-bold" : "text-sm font-semibold"
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** A money figure whose digits keep their order inside the RTL dialog. */
const Money = ({ value }: { value: any }) => (
  <>
    <span dir="ltr">{formatMoney(value, "SYP", 2)}</span> ل.س
  </>
);

export function AddBatchModal({ open, onOpenChange, products, preselectedProductId, onSuccess }: AddBatchModalProps) {
  // FIX: initial value is computed directly here (not left as "" and fixed
  // up later by an effect/render-adjustment block) — this is what was
  // actually broken before. The previous version initialized
  // `prevPreselectedProductId` to the SAME value as `preselectedProductId`,
  // so the "did it change?" check below was always false on first render,
  // and the field silently stayed empty even when a product was passed in.
  const [selectedProductId, setSelectedProductId] = useState<string>(
    () => preselectedProductId || products[0]?.id || ""
  );
  const activeUnitsOf = (p?: ProductItem) => p?.units.filter((u) => u.isActive !== false) ?? [];


  const selectedProduct = products.find((p) => p.id === selectedProductId);
  // [FIX] The single source of truth for "which units can this batch be
  // received in" — a deactivated ProductUnit must never be selectable as
  // the purchase unit for a NEW batch (the server rejects it via
  // InactiveEntryUnitError, but the UI must not offer it in the first
  // place). Used consistently below for both the initial/derived selection
  // state and the rendered <select> options.
  const activeUnits = activeUnitsOf(selectedProduct);

  const [selectedUnitId, setSelectedUnitId] = useState<string>(
    () => activeUnitsOf(selectedProduct)[0]?.id || ""
  );

  // [v4.4, Section 10] Replaces the old free-text `batchNumber` state —
  // only the merchant-supplied suffix is collected here. The server
  // constructs the full stored value as "{server-date}-{suffix}"; this
  // component never builds that concatenation itself.
  const [batchNumberSuffix, setBatchNumberSuffix] = useState<string>("");
  // [FIX] Quantity is a plain decimal-STRING typed directly by the user —
  // never a `number` state round-tripped through parseFloat().
  // ProductBatch.quantity is a Decimal(18,4) column; parseFloat() +
  // String() risks silent precision loss for large/fractional values
  // (IEEE-754 double, then a re-stringification that can even produce
  // scientific notation for very small/large numbers, which fails the
  // backend's own DECIMAL_STRING_REGEX outright). Every other decimal-
  // string field in this codebase (see AddProductModal's toDecimalString
  // pattern) is handled this same way — a raw text input, validated
  // client-side with the same regex the backend enforces, sent as-is.
  //
  // [UX] Starts EMPTY (with a placeholder), not "0": a pre-filled "0" had to
  // be deleted by hand before typing. Submit still rejects an empty/zero value.
  const [quantity, setQuantity] = useState<string>("");
  // [Batch cost entry] What the merchant ACTUALLY paid for the whole
  // received quantity of the purchase unit selected above — e.g. 54,000 SYP
  // for "6 طرد". Same decimal-string discipline as quantity: a plain string
  // typed by the user, validated client-side, never parsed through a native
  // number. REQUIRED — the server derives the stored per-base-unit cost from
  // it (ProductBatch.costPricePerBaseUnit, via lib/inventory/units.ts's
  // costFromTotal()) and rejects any client that tries to send the derived
  // figure itself (batch-creation.ts's CLIENT_COMPUTED_BATCH_FIELDS).
  const [totalCost, setTotalCost] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  // [v4.7] Persisted goods-receiving date + optional supplier — both stored
  // on the ProductReceipt the gateway creates. The defaults (and the only
  // permitted source of "today") come from the SERVER when the modal opens.
  const [receivingDefaults, setReceivingDefaults] = useState<ReceivingDefaults | null>(null);
  const [purchaseDate, setPurchaseDate] = useState<string>("");
  const [supplierName, setSupplierName] = useState<string>("");

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
        // Default the picker to the server's business date — the device
        // clock is never consulted (not even as a fallback).
        setPurchaseDate((prev) => prev || data.businessDate);
      } catch {
        if (cancelled) return;
        // No fallback: null defaults disable the preview and the submit
        // button until a successful refetch (reopening the modal).
        setReceivingDefaults(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Adjust-state-during-render pattern (React's documented alternative to
  // an effect that only exists to keep one piece of state in sync with a
  // prop/other state — see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  // Calling setState here, mid-render, is intentional and cheap: React
  // discards this render and immediately re-renders with the new value
  // before anything is painted — there is no extra committed/visible
  // render, unlike the effect-based version these three blocks replace.

  // #1: selectedProductId follows preselectedProductId when it changes
  // (e.g. the modal is reopened from a different product's row).
  const [prevPreselectedProductId, setPrevPreselectedProductId] = useState(preselectedProductId);
  if (preselectedProductId !== prevPreselectedProductId) {
    setPrevPreselectedProductId(preselectedProductId);
    setSelectedProductId(preselectedProductId || products[0]?.id || "");
  }

  // #2: selectedUnitId follows selectedProductId — reset to the new
  // product's first ACTIVE unit, or explicitly cleared (not left stale) if
  // the newly selected product has no active units at all.
  const [prevSelectedProductId, setPrevSelectedProductId] = useState(selectedProductId);
  if (selectedProductId !== prevSelectedProductId) {
    setPrevSelectedProductId(selectedProductId);
    setSelectedUnitId(activeUnitsOf(selectedProduct)[0]?.id || "");
  }

  // #3: form fields reset whenever the modal transitions to closed (for
  // any reason, including Cancel), so stale values don't linger the next
  // time it's reopened.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setBatchNumberSuffix("");
      setQuantity("");
      setTotalCost("");
      setExpiryDate("");
      // [v4.7] Drop the server defaults + receipt fields so a reopen
      // refetches them (a stale business date must never survive a reopen).
      setReceivingDefaults(null);
      setPurchaseDate("");
      setSupplierName("");
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId || !selectedUnitId) {
      toast.error("يرجى اختيار المنتج ووحدة القياس.");
      return;
    }

    // [v4.4, Section 10] Validates the SUFFIX only — the date prefix is
    // never typed by the user, so there is nothing to validate about it
    // here; the server rejects a missing/empty suffix independently.
    if (!batchNumberSuffix.trim()) {
      toast.error("يرجى إدخال الجزء الخاص برقم الدفعة.");
      return;
    }

    // [v4.7] The purchase date must exist and be within the SERVER-provided
    // window (minDate..businessDate). Bounds are plain string comparisons
    // against the server's own values — the device clock is never consulted.
    // If the defaults request failed, saving is disabled entirely: there is
    // deliberately no device-clock fallback.
    if (!receivingDefaults || !purchaseDate) {
      toast.error(
        "تعذّر تحميل تاريخ الاستلام من الخادم — لا يمكن الحفظ بدونه (لا يُستخدم تاريخ الجهاز أبداً)."
      );
      return;
    }
    if (purchaseDate > receivingDefaults.businessDate) {
      toast.error("لا يمكن تسجيل استلام بتاريخ في المستقبل.");
      return;
    }
    if (purchaseDate < receivingDefaults.minDate) {
      toast.error("لا يمكن تسجيل استلام بتاريخ أقدم من سنتين (730 يوماً).");
      return;
    }

    // Client-side decimal-string validation, mirroring the backend's own
    // AMOUNT_REGEX + "strictly positive" rules exactly (see
    // batches/route.ts's createBatchSchema) — a malformed, empty or
    // non-positive quantity/total is caught here with a clear Arabic
    // message, instead of relying solely on the server's 400 response.
    // AMOUNT_REGEX below is the same regex literal the server applies to
    // BOTH of these fields.
    const trimmedQuantity = quantity.trim();
    if (!isPositiveAmount(trimmedQuantity)) {
      toast.error("صيغة الكمية غير صالحة (مثال: 10 أو 10.5).");
      return;
    }

    // [Batch cost entry] The TOTAL paid for the received quantity, in SYP.
    // Strictly positive: the server derives cost per base unit from it, so a
    // zero/absent total leaves nothing to derive from.
    const trimmedTotalCost = totalCost.trim();
    if (!isPositiveAmount(trimmedTotalCost)) {
      toast.error("يرجى إدخال إجمالي تكلفة صحيح أكبر من صفر (مثال: 54000 أو 54000.5).");
      return;
    }

    setLoading(true);

    try {
      const payload = {
        productId: selectedProductId,
        unitId: selectedUnitId,
        // [v4.4, Section 10] Only the suffix is sent — the server
        // constructs the full "{date}-{suffix}" batchNumber itself. A
        // direct `batchNumber` field is explicitly rejected server-side
        // (see the route's raw-body guard), so this component must never
        // send one.
        batchNumberSuffix: batchNumberSuffix.trim(),
        // [FIX] Both sent exactly as typed — never round-tripped through
        // parseFloat()/String(), so no precision is ever lost between
        // what the user typed and what reaches the server.
        //
        // [Batch cost entry] quantity is expressed in the SELECTED
        // (purchase) unit, and totalCost is what was paid for that whole
        // quantity. The server converts the quantity using the selected
        // unit's own conversionFactor and then divides the total by the
        // RESULT to obtain the stored
        // ProductBatch.costPricePerBaseUnit. This component deliberately
        // computes neither figure for the wire: the derived value is listed
        // server-side in lib/inventory/batch-creation.ts's
        // CLIENT_COMPUTED_BATCH_FIELDS and a payload carrying it would be
        // rejected with 400 CLIENT_COMPUTED_FIELD_NOT_ALLOWED.
        quantity: trimmedQuantity,
        totalCost: trimmedTotalCost,
        expiryDate: expiryDate || null,
        // [v4.7] The persisted goods-receiving date + optional supplier,
        // stored on the ProductReceipt this batch rides. The date is a
        // business date validated above against the SERVER's window.
        purchaseDate,
        ...(supplierName.trim() ? { supplierName: supplierName.trim() } : {}),
      };

      const res = await fetch("/api/inventory/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "حدث خطأ أثناء إضافة الدفعة.");
      }

      toast.success("تمت إضافة الدفعة المخزونية الجديدة بنجاح!");
      onSuccess();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "فشلت عملية حفظ الدفعة.");
    } finally {
      setLoading(false);
    }
  };

  const productIsLocked = !!preselectedProductId;
  const selectedUnit = activeUnits.find((u) => u.id === selectedUnitId);
  // The product's base unit — `isBaseUnit` is precomputed by the backend
  // (base-unit.ts's toSafeProductWithUnits(), threaded through the products
  // GET), with `conversionFactor === 1` only as a fallback for a payload
  // that predates that field. Looked up across ALL of the product's units
  // (not just active ones) — the base unit's own NAME is still meaningful
  // for display even in the unlikely case it were deactivated.
  const productBaseUnit =
    selectedProduct?.units.find((u) => u.isBaseUnit === true) ??
    selectedProduct?.units.find((u) => u.conversionFactor === 1);
  const productBaseUnitName = productBaseUnit?.unitName ?? null;
  // "Did the merchant choose to RECEIVE in the base unit itself?" When they
  // did, the per-purchase-unit price line is the same number as the
  // per-base-unit line, so it is hidden rather than repeated.
  const selectedUnitIsBaseUnit =
    !!selectedUnit &&
    (selectedUnit.isBaseUnit === true || selectedUnit.conversionFactor === 1);

  // [Batch cost entry] The live cost-summary card. Null whenever the pair is
  // not yet derivable (either field empty, malformed or zero, or no unit
  // resolved yet) — the card then renders nothing rather than a misleading
  // 0.00. Built on the SAME function the server runs, so what the merchant
  // reads here is what gets stored.
  const costBreakdown = costBreakdownForDisplay(
    totalCost.trim(),
    quantity.trim(),
    selectedUnit?.conversionFactor ?? 0
  );

  const baseUnitLabel = productBaseUnitName || "الوحدة الأساسية";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* [UX] The dialog is capped at 90% of the (dynamic) viewport height and
          laid out as header / scrollable body / pinned footer, so on a short
          screen or a phone the title and the save button never get cut off —
          only the fields in the middle scroll. */}
      <DialogContent
        className="flex max-h-[90dvh] max-w-md flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        dir="rtl"
      >
        <DialogHeader className="shrink-0 space-y-1.5 border-b px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Layers className="w-5 h-5 text-emerald-600" />
            <span>إضافة دفعة مخزونية جديدة</span>
          </DialogTitle>
          <DialogDescription>
            سجّل رقم الدفعة والكمية المستلمة وإجمالي تكلفتها وتاريخ صلاحيتها لتتبع FIFO.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div className="space-y-2">
              <Label>المنتج *</Label>
              <select
                value={selectedProductId}
                onChange={(e) => setSelectedProductId(e.target.value)}
                className="w-full h-9 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                required
                disabled={productIsLocked}
              >
                <option value="">اختر المنتج...</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {productIsLocked && (
                <p className="text-xs text-zinc-500">
                  تم تحديد المنتج مسبقاً من الشاشة السابقة.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>الوحدة المستلمة *</Label>
              {/* [FIX] Options are built from `activeUnits` (isActive !==
                  false) rather than `selectedProduct.units` directly — a
                  deactivated unit must never be offered as a receiving unit
                  for a new batch; the server would reject it anyway
                  (InactiveEntryUnitError), but that check belongs here too.
                  [UX] Each option reads "كرتونة (= 80 قطعة)" instead of the
                  abstract "معامل تحويل: 80". */}
              <select
                value={selectedUnitId}
                onChange={(e) => setSelectedUnitId(e.target.value)}
                className="w-full h-9 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-sm"
                required
                disabled={!selectedProduct || activeUnits.length === 0}
              >
                {activeUnits.length === 0 && (
                  <option value="">لا توجد وحدات قياس فعّالة لهذا المنتج</option>
                )}
                {activeUnits.map((u) => {
                  const isBase = u.isBaseUnit === true || u.conversionFactor === 1;
                  return (
                    <option key={u.id} value={u.id}>
                      {u.unitName}
                      {isBase ? " (الوحدة الأساسية)" : ` (= ${u.conversionFactor} ${baseUnitLabel})`}
                    </option>
                  );
                })}
              </select>
              {selectedProduct && activeUnits.length === 0 && (
                <p className="text-xs text-red-600">
                  هذا المنتج لا يملك وحدات قياس فعّالة — فعّل وحدة أو أضف واحدة من شاشة تعديل المنتج.
                </p>
              )}
            </div>

            {/* [v4.4, Spec Addendum Section 10.1] A read-only date preview +
                one editable suffix field — the ADMIN no longer types a full
                batch number, only the part after the date.
                [UX] The group is LTR so it reads in the same order as the
                stored value: 2026-10-08-323 (date first, then the suffix). */}
            <div className="space-y-2">
              <Label htmlFor="batch-suffix">رقم الدفعة (Batch Number) *</Label>
              <div dir="ltr" className="flex items-center gap-2">
                <span
                  className="h-9 shrink-0 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800 px-3 font-mono text-sm text-zinc-500 flex items-center"
                  title={
                    receivingDefaults
                      ? "تاريخ الخادم (يوم العمل الحالي) — التاريخ الفعلي يُولَّد من الخادم وقت الحفظ."
                      : "تعذّر تحميل تاريخ الخادم — الحفظ معطّل حتى يعود التحميل."
                  }
                >
                  {/* [v4.7] Server business date (GET /api/receipts/defaults),
                      NEVER the device clock; placeholder while unavailable. */}
                  {receivingDefaults ? `${receivingDefaults.businessDate}-` : "—-"}
                </span>
                <Input
                  id="batch-suffix"
                  dir="ltr"
                  placeholder="1 أو INV4471"
                  value={batchNumberSuffix}
                  onChange={(e) => setBatchNumberSuffix(e.target.value)}
                  required
                  className="flex-1 font-mono"
                />
              </div>
              <p className="text-xs text-zinc-500">
                يُضاف تاريخ اليوم تلقائياً من الخادم — أدخل فقط الجزء الذي تريده (رقم تسلسلي، رقم فاتورة المورّد...).
              </p>
            </div>

            {/* [UX] Labels are one short line each so the two fields line up;
                the unit / currency now sits INSIDE the input as a suffix. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="batch-quantity">الكمية المستلمة *</Label>
                {/* [FIX] type="text" + inputMode="decimal" instead of
                    type="number" — a native number input silently coerces
                    through the browser's own float parsing (and step="any"
                    still allows scientific-notation entry in some
                    browsers), which is exactly the precision risk this fix
                    removes. The value here is the raw string the user
                    typed, validated against AMOUNT_REGEX above at submit
                    time — never parsed through parseFloat(). */}
                <div className="relative">
                  <Input
                    id="batch-quantity"
                    type="text"
                    inputMode="decimal"
                    placeholder="مثال: 6"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="pe-16 tabular-nums"
                    required
                  />
                  {selectedUnit && (
                    <span className="pointer-events-none absolute end-3 top-1/2 max-w-14 -translate-y-1/2 truncate text-xs font-semibold text-zinc-500">
                      {selectedUnit.unitName}
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="batch-total-cost">إجمالي التكلفة *</Label>
                {/* [Batch cost entry] The TOTAL the merchant actually paid for
                    the whole quantity beside it — never a per-unit figure. The
                    per-base-unit cost the system stores is derived from this
                    pair (see the summary card below), so the two can never
                    drift apart. Same decimal-string discipline as quantity:
                    type="text" + inputMode="decimal", never parseFloat(). */}
                <div className="relative">
                  <Input
                    id="batch-total-cost"
                    type="text"
                    inputMode="decimal"
                    placeholder="مثال: 54000"
                    value={totalCost}
                    onChange={(e) => setTotalCost(e.target.value)}
                    className="pe-12 tabular-nums"
                    required
                  />
                  <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-zinc-500">
                    ل.س
                  </span>
                </div>
              </div>
            </div>
            <p className="-mt-2 text-xs text-zinc-500">
              الإجمالي هو المبلغ الذي دفعته مقابل <strong>كل</strong> الكمية المستلمة، وليس سعر الوحدة الواحدة.
            </p>

            {/* [Batch cost entry] LIVE derivation — built on the exact same
                function the server runs (lib/inventory/units.ts's
                costBreakdownForDisplay -> costFromTotal), so what the
                merchant reads here is what gets stored. Rendered only when
                both the quantity and the total are actually derivable; a
                partially-typed form shows nothing rather than a misleading
                0.00. */}
            {costBreakdown && selectedUnit && (
              <div
                aria-live="polite"
                className="overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20"
              >
                <div className="flex items-center gap-1.5 border-b border-emerald-200/70 px-3 py-2 text-xs font-bold text-emerald-900 dark:border-emerald-900/60 dark:text-emerald-200">
                  <Calculator className="size-3.5" aria-hidden />
                  ملخص التكلفة — راجعه قبل الحفظ
                </div>
                <dl className="divide-y divide-emerald-200/60 dark:divide-emerald-900/50">
                  {/* Redundant when the unit received in IS the base unit —
                      those two lines would repeat the per-base-unit figure. */}
                  {!selectedUnitIsBaseUnit && (
                    <SummaryRow
                      label="الكمية التي ستُضاف للمخزون"
                      value={
                        <>
                          {quantity.trim()} {selectedUnit.unitName} = {costBreakdown.quantityInBaseUnits}{" "}
                          {baseUnitLabel}
                        </>
                      }
                    />
                  )}
                  {!selectedUnitIsBaseUnit && (
                    <SummaryRow
                      label={`سعر ${withAl(selectedUnit.unitName)}`}
                      hint="كم كلّفتك الوحدة المستلمة"
                      value={<Money value={costBreakdown.pricePerPurchaseUnit} />}
                    />
                  )}
                  <SummaryRow
                    strong
                    label={`سعر ${withAl(baseUnitLabel)}`}
                    hint="التكلفة المعتمدة في المخزون"
                    value={<Money value={costBreakdown.pricePerBaseUnit} />}
                  />
                </dl>
              </div>
            )}

            {/* [v4.7] The PERSISTED goods-receiving date + optional supplier
                (ProductReceipt.purchaseDate / supplierName). Defaults and
                bounds come from GET /api/receipts/defaults — the device clock
                is never consulted; while defaults are unavailable the picker
                stays empty and saving stays disabled. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="batch-purchase-date">تاريخ الشراء (يوم الاستلام) *</Label>
                <Input
                  id="batch-purchase-date"
                  type="date"
                  value={purchaseDate}
                  min={receivingDefaults?.minDate}
                  max={receivingDefaults?.businessDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  required
                  disabled={!receivingDefaults}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="batch-expiry">تاريخ الانتهاء</Label>
                <Input
                  id="batch-expiry"
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                />
              </div>
            </div>
            {!receivingDefaults && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                تعذّر تحميل تاريخ الاستلام من الخادم — أعد فتح النافذة للمحاولة مجدداً.
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="batch-supplier">المورّد (اختياري)</Label>
              <Input
                id="batch-supplier"
                type="text"
                maxLength={120}
                placeholder="مثال: مورد الشام"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
              />
            </div>

            <p className="text-xs text-zinc-500">
              إجمالي التكلفة يُستخدم لحساب الأرباح فقط ولا يظهر للزبائن — أما سعر البيع فيُعدَّل من
              شاشة المنتج.
            </p>
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t px-5 py-3 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              إلغاء
            </Button>
            <Button
              type="submit"
              disabled={loading || !selectedUnitId || !receivingDefaults || !purchaseDate}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {loading ? "جاري الحفظ..." : "حفظ الدفعة"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}