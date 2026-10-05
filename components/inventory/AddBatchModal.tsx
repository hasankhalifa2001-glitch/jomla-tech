/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Layers } from "lucide-react";
import { toast } from "sonner";
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

// [v4.4, Spec Addendum Section 10] Today's date, DISPLAY ONLY — a
// cosmetic preview of the date prefix the server will generate at save
// time, read from the browser's own clock. This is NEVER sent to the
// server and never influences the actual stored batchNumber: the real
// date prefix is always generated server-side, at the moment of
// creation, via lib/inventory/batch-number.ts's constructBatchNumber().
// If the user's device clock is off (e.g. just before/after midnight
// relative to the server), this preview may read one day off from what
// actually gets stored — purely cosmetic, not a correctness issue.
function todaysDatePreview(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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
  // [FIX] Quantity is now a plain decimal-STRING typed directly by the
  // user — never a `number` state round-tripped through parseFloat().
  // ProductBatch.quantity is a Decimal(18,4) column; parseFloat() +
  // String() risks silent precision loss for large/fractional values
  // (IEEE-754 double, then a re-stringification that can even produce
  // scientific notation for very small/large numbers, which fails the
  // backend's own DECIMAL_STRING_REGEX outright). Every other decimal-
  // string field in this codebase (see AddProductModal's toDecimalString
  // pattern) is handled this same way — a raw text input, validated
  // client-side with the same regex the backend enforces, sent as-is.
  const [quantity, setQuantity] = useState<string>("0");
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
      setQuantity("0");
      setTotalCost("");
      setExpiryDate("");
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

  // [Batch cost entry] The live "6 طرد = 36 قطعة / 9,000 / 1,500" block.
  // Null whenever the pair is not yet derivable (either field empty,
  // malformed or zero, or no unit resolved yet) — the block then renders
  // nothing rather than a misleading 0.00. Built on the SAME function the
  // server runs, so what the merchant reads here is what gets stored.
  const costBreakdown = costBreakdownForDisplay(
    totalCost.trim(),
    quantity.trim(),
    selectedUnit?.conversionFactor ?? 0
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Layers className="w-5 h-5 text-emerald-600" />
            <span>إضافة دفعة مخزونية جديدة (Batch)</span>
          </DialogTitle>
          <DialogDescription>
            سجل رقم الدفعة الجديدة والكمية المستلمة وإجمالي تكلفتها وتاريخ صلاحيتها لتتبع FIFO.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
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
            {/* [FIX] Options are now built from `activeUnits` (isActive !==
                false) rather than `selectedProduct.units` directly — a
                deactivated unit must never be offered as a receiving unit
                for a new batch; the server would reject it anyway
                (InactiveEntryUnitError), but that check belongs here too. */}
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
              {activeUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.unitName} (معامل تحويل: {u.conversionFactor})
                </option>
              ))}
            </select>
            {selectedProduct && activeUnits.length === 0 && (
              <p className="text-xs text-red-600">
                هذا المنتج لا يملك وحدات قياس فعّالة — فعّل وحدة أو أضف واحدة من شاشة تعديل المنتج.
              </p>
            )}
          </div>

          {/* [v4.4, Spec Addendum Section 10.1] The old single free-text
              batchNumber input is replaced with a read-only date preview
              + one editable suffix field — the ADMIN no longer types a
              full batch number, only the part after the date. */}
          <div className="space-y-2">
            <Label>رقم الدفعة (Batch Number) *</Label>
            <div className="flex items-center gap-2">
              <span
                className="h-9 shrink-0 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800 px-3 text-sm text-zinc-500 flex items-center"
                dir="ltr"
                title="التاريخ الفعلي المخزَّن يُولَّد من خادم النظام وقت الحفظ — هذا عرض تقريبي فقط."
              >
                {todaysDatePreview()}-
              </span>
              <Input
                placeholder="مثال: 1 أو INV4471"
                value={batchNumberSuffix}
                onChange={(e) => setBatchNumberSuffix(e.target.value)}
                required
                className="flex-1"
              />
            </div>
            <p className="text-xs text-zinc-500">
              يُضاف تاريخ اليوم تلقائياً من الخادم — أدخل فقط الجزء الذي تريده (رقم تسلسلي، رقم فاتورة المورّد...).
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>
                الكمية المستلمة *{selectedUnit ? ` (بوحدة ${selectedUnit.unitName})` : ""}
              </Label>
              {/* [FIX] type="text" + inputMode="decimal" instead of
                  type="number" — a native number input silently coerces
                  through the browser's own float parsing (and step="any"
                  still allows scientific-notation entry in some
                  browsers), which is exactly the precision risk this fix
                  removes. The value here is the raw string the user
                  typed, validated against AMOUNT_REGEX above at submit
                  time — never parsed through parseFloat(). */}
              <Input
                type="text"
                inputMode="decimal"
                placeholder="مثال: 6"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>إجمالي التكلفة المدفوعة * (ل.س)</Label>
              {/* [Batch cost entry] The TOTAL the merchant actually paid for
                  the whole quantity above — never a per-unit figure. The
                  per-base-unit cost the system stores is derived from this
                  pair (see the live block below), so the two can never drift
                  apart. Same decimal-string discipline as quantity:
                  type="text" + inputMode="decimal", never parseFloat(). */}
              <Input
                type="text"
                inputMode="decimal"
                placeholder="مثال: 54000"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>تاريخ الانتهاء</Label>
            <Input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </div>

          {/* [Batch cost entry] LIVE derivation — built on the exact same
              function the server runs (lib/inventory/units.ts's
              costBreakdownForDisplay -> costFromTotal), so what the merchant
              reads here is what gets stored. Rendered only when both the
              quantity and the total are actually derivable; a
              partially-typed form shows nothing rather than a misleading
              0.00. */}
          {costBreakdown && selectedUnit && (
            <div
              aria-live="polite"
              className="space-y-1 rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2 text-xs dark:border-emerald-900 dark:bg-emerald-950/20"
            >
              {!selectedUnitIsBaseUnit && (
                <p className="font-medium text-emerald-800 dark:text-emerald-300">
                  {quantity.trim()} {selectedUnit.unitName} ={" "}
                  {costBreakdown.quantityInBaseUnits} {productBaseUnitName || "وحدة أساسية"}
                </p>
              )}
              {/* Redundant when the unit received in IS the base unit —
                  that line would repeat the per-base-unit figure verbatim. */}
              {!selectedUnitIsBaseUnit && (
                <p className="text-emerald-700 dark:text-emerald-400">
                  سعر وحدة الشراء ({selectedUnit.unitName}):{" "}
                  {formatMoney(costBreakdown.pricePerPurchaseUnit, "SYP", 2)} ل.س
                </p>
              )}
              <p className="text-emerald-700 dark:text-emerald-400">
                سعر الوحدة الأساسية{productBaseUnitName ? ` (${productBaseUnitName})` : ""}:{" "}
                {formatMoney(costBreakdown.pricePerBaseUnit, "SYP", 2)} ل.س
              </p>
            </div>
          )}

          <p className="text-xs text-zinc-500">
            إجمالي التكلفة يُستخدم لحساب الأرباح فقط ولا يظهر للزبائن — أما سعر البيع فيُعدَّل من
            شاشة المنتج.
          </p>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              إلغاء
            </Button>
            <Button
              type="submit"
              disabled={loading || !selectedUnitId}
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