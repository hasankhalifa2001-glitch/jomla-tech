"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Layers, Plus, Trash2 } from "lucide-react";
import Decimal from "decimal.js";
import { toast } from "sonner";
import { formatMoney } from "@/lib/utils/money";
// [Batch cost entry] The ONE shared derivation the server also runs
// (costFromTotal() underneath) — so the per-base-unit cost shown live on
// every row is exactly what the server stores. See units.ts's own note.
import { costBreakdownForDisplay } from "@/lib/inventory/units";
import type { ProductItem } from "@/components/inventory/ProductTable";

// [v4.4, Spec Addendum Sections 10–11] Multi-Product Batch Receipt
// ("استلام بضاعة جديدة"), ADMIN-only.
//
// Records ONE real-world purchase covering several different products
// (e.g. sugar, rice and oil bought together from the same supplier on the
// same day) under ONE shared batchNumber, instead of repeating the
// single-product "add batch" flow once per item.
//
// The three steps the spec defines:
//   1. Shared batch info — the merchant-supplied part of the batchNumber
//      (Section 10) plus an OPTIONAL purchase-date note.
//   2. A repeatable line-item table — one row per product.
//   3. Review & save — a short summary, then one "Save batch" action.
//
// The server owns both the date prefix and the transaction:
//   - batchNumber is built ONCE, server-side, as
//     "{server-date}-{merchant-supplied part}" (lib/inventory/batch-number.ts).
//     The date preview rendered in Step 1 below is COSMETIC ONLY — it is
//     never sent to the server and never influences the stored value.
//   - Every line item becomes its own ProductBatch row inside ONE
//     $transaction (app/api/inventory/batches/receipt/route.ts), so a
//     failure partway through leaves no partial batches.
//
// [Batch cost entry] Cost is captured exactly as on the single-batch screen,
// for the same reason: the merchant types the QUANTITY received in the
// purchase unit they picked, plus the TOTAL they paid for that whole
// quantity, and the server derives the row's stored
// ProductBatch.costPricePerBaseUnit from that pair (lib/inventory/units.ts's
// costFromTotal(), called inside lib/inventory/batch-creation.ts). Each row
// below therefore renders the same live derivation the server is about to
// perform — the per-purchase-unit price and the per-base-unit price — and the
// per-purchase-unit line is hidden whenever the row's unit already IS the base
// unit, where it would otherwise just repeat the per-base-unit figure.

// Same decimal-string discipline the backend applies (the receipt route's
// AMOUNT_REGEX + isPositiveAmount, used for the quantity AND the total cost
// of every row) — mirrored here so an invalid quantity or total is caught
// with a clear Arabic message before the request is even sent, rather than
// surfacing as a generic VALIDATION_ERROR from the server after a round trip.
//
// [Batch cost entry] Quantity and total cost now share ONE rule (strictly
// positive, max 14 integer / 4 decimal digits). There is no per-row "cost
// price" field any more: the merchant types what they paid for the quantity
// they received, and the server derives each row's stored per-base-unit cost
// from that pair — see lib/inventory/batch-creation.ts's
// CLIENT_COMPUTED_BATCH_FIELDS, which rejects a client that tries to send the
// derived figure itself.
const AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;
const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Safe against a malformed string — decimal.js throws on "" / "abc". */
function isPositiveAmount(value: string): boolean {
  const v = value.trim();
  if (!AMOUNT_REGEX.test(v)) return false;
  try { return new Decimal(v).gt(0); } catch { return false; }
}

// `InstanceType<typeof Decimal>` is this codebase's established way to name
// a decimal.js VALUE as a type (decimal.js exports a class, not a type —
// see lib/inventory/units.ts's identical alias).
type DecimalInstance = InstanceType<typeof Decimal>;

/**
 * Today's date, DISPLAY ONLY — a cosmetic preview of the date prefix the
 * server will generate at save time, read from the browser's own clock.
 * Never sent to the server; the real prefix always comes from the server's
 * clock at the moment of creation (batch/inventory entry is online-only and
 * admin-facing, so there is no offline-clock-drift concern here — see
 * lib/inventory/batch-number.ts's header).
 */
function todaysDatePreview(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface ReceiptItemRow {
  /** Local-only identity for React keys — never sent to the server. */
  rowId: string;
  productId: string;
  unitId: string;
  /** Quantity received, in `unitId` (the purchase unit the ADMIN picked). */
  quantity: string;
  /**
   * [Batch cost entry] The TOTAL the merchant paid for this row's whole
   * quantity, always SYP — never a per-unit figure. The server derives the
   * row's stored ProductBatch.costPricePerBaseUnit from this quantity and
   * this total, so the two can never drift apart.
   */
  totalCost: string;
  expiryDate: string;
}

// Monotonic local row id. A module-level counter (rather than
// crypto.randomUUID()) keeps the ids deterministic for tests and avoids any
// environment-dependent API availability.
let rowSequence = 0;
function nextRowId(): string {
  rowSequence += 1;
  return `receipt-row-${rowSequence}`;
}

function emptyRow(): ReceiptItemRow {
  return {
    rowId: nextRowId(),
    productId: "",
    unitId: "",
    quantity: "",
    totalCost: "",
    expiryDate: "",
  };
}

interface MultiProductReceiptModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: ProductItem[];
  onSuccess: () => void;
}

export function MultiProductReceiptModal({
  open,
  onOpenChange,
  products,
  onSuccess,
}: MultiProductReceiptModalProps) {
  // 1 = shared batch info, 2 = line items, 3 = review & save.
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // [v4.4, Section 10] Only the merchant-supplied SUFFIX is collected — the
  // server builds "{server-date}-{suffix}" once for the whole submission.
  const [batchNumberSuffix, setBatchNumberSuffix] = useState<string>("");
  // [v4.4, Section 11] TRANSIENT, DISPLAY-ONLY. Shown back to the ADMIN on
  // the review step as a memory aid. It is never persisted to any database
  // column and never influences the stored batchNumber's date prefix — the
  // wording below the field says so explicitly, so the UI cannot imply that
  // this note is "saved" or "recorded" in a persistent sense.
  const [purchaseDateNote, setPurchaseDateNote] = useState<string>("");
  const [items, setItems] = useState<ReceiptItemRow[]>(() => [emptyRow()]);
  const [loading, setLoading] = useState<boolean>(false);

  const resetForm = () => {
    setStep(1);
    setBatchNumberSuffix("");
    setPurchaseDateNote("");
    setItems([emptyRow()]);
  };

  const updateItem = (rowId: string, patch: Partial<ReceiptItemRow>) => {
    setItems((prev) => prev.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));
  };

  const addItem = () => setItems((prev) => [...prev, emptyRow()]);

  const removeItem = (rowId: string) =>
    setItems((prev) => prev.filter((row) => row.rowId !== rowId));

  /**
   * Every line item is validated INDEPENDENTLY and in full — the same rule
   * the API layer enforces, surfaced here as a row-numbered Arabic message
   * so the ADMIN knows exactly which line to fix.
   */
  const validateItems = (): string | null => {
    if (items.length === 0) {
      return "أضف صنفاً واحداً على الأقل إلى الاستلام.";
    }
    for (let index = 0; index < items.length; index += 1) {
      const row = items[index];
      const label = `السطر ${index + 1}`;
      if (!row.productId) return `${label}: يرجى اختيار المنتج.`;
      if (!row.unitId) return `${label}: يرجى اختيار وحدة القياس.`;
      // [FIX] The chosen unit must belong to the chosen product AND be
      // active — mirrors the same guard the AddBatchModal now applies, and
      // the server's own InactiveEntryUnitError check.
      const product = products.find((p) => p.id === row.productId);
      const unit = product?.units.find((u) => u.id === row.unitId);
      if (!unit || unit.isActive === false) {
        return `${label}: الوحدة المحددة غير متاحة — اختر وحدة فعّالة.`;
      }
      // Missing, malformed or zero/negative — all rejected here with the same
      // intent as the server's own rule, since none of them can produce a
      // per-base-unit cost.
      if (!isPositiveAmount(row.quantity)) {
        return `${label}: الكمية يجب أن تكون أكبر من صفر (مثال: 10 أو 10.5).`;
      }
      if (!isPositiveAmount(row.totalCost)) {
        return `${label}: إجمالي التكلفة مطلوب ويجب أن يكون رقماً أكبر من صفر.`;
      }
      if (row.expiryDate && !STRICT_DATE_REGEX.test(row.expiryDate)) {
        return `${label}: تاريخ الانتهاء يجب أن يكون بالصيغة YYYY-MM-DD.`;
      }
    }
    return null;
  };

  const goToItemsStep = () => {
    if (batchNumberSuffix.trim().length === 0) {
      toast.error("يرجى إدخال الجزء الخاص برقم الدفعة — لا يمكن أن يكون فارغاً.");
      return;
    }
    setStep(2);
  };

  const goToReviewStep = () => {
    const error = validateItems();
    if (error) {
      toast.error(error);
      return;
    }
    setStep(3);
  };

  /**
   * [Batch cost entry] What this receipt actually costs: the sum of the
   * TOTALS typed on each row, in Decimal (never a native JS double).
   * Nothing needs deriving here — the entered totals ARE the money paid, so
   * the review step simply reads them back and adds them up.
   */
  const estimatedTotalCost = (): DecimalInstance => {
    return items.reduce((sum, row) => {
      if (!isPositiveAmount(row.totalCost)) return sum;
      return sum.plus(new Decimal(row.totalCost.trim()));
    }, new Decimal(0));
  };

  const handleSubmit = async () => {
    const error = validateItems();
    if (error) {
      toast.error(error);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/inventory/batches/receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchNumberSuffix: batchNumberSuffix.trim(),
          items: items.map((row) => ({
            productId: row.productId,
            unitId: row.unitId,
            quantity: row.quantity.trim(),
            // [Batch cost entry] The TOTAL paid for this row's quantity. The
            // row's stored per-base-unit cost is derived server-side from this
            // pair — sending a derived figure here would be rejected with 400
            // CLIENT_COMPUTED_FIELD_NOT_ALLOWED.
            totalCost: row.totalCost.trim(),
            // Omitted entirely when blank rather than sent as "", so the
            // server never receives an empty-string date.
            ...(row.expiryDate ? { expiryDate: row.expiryDate } : {}),
          })),
          // Sent when present, and deliberately IGNORED server-side (never
          // persisted to any column) — see the field's note in the route.
          ...(purchaseDateNote.trim() ? { purchaseDateNote: purchaseDateNote.trim() } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "تعذّر تسجيل استلام البضاعة.");
      }

      toast.success(data.message || "تم تسجيل استلام البضاعة بنجاح.");
      resetForm();
      onOpenChange(false);
      onSuccess();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "تعذّر تسجيل استلام البضاعة.";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-submit is blocked; closing otherwise clears the
        // multi-step form so a reopened modal never shows stale rows.
        if (loading) return;
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Layers className="w-5 h-5 text-emerald-600" />
            <span>استلام بضاعة جديدة (دفعة متعددة المنتجات)</span>
          </DialogTitle>
          <DialogDescription>
            سجّل عملية شراء واحدة تغطي عدة منتجات تحت رقم دفعة مشترك — كل صنف يُنشئ دفعة مخزونية خاصة بمنتجه.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator — one shared batchNumber spans all three steps. */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {[
            { n: 1 as const, label: "بيانات الدفعة" },
            { n: 2 as const, label: "الأصناف" },
            { n: 3 as const, label: "المراجعة والحفظ" },
          ].map(({ n, label }) => (
            <span
              key={n}
              className={
                step === n
                  ? "rounded-full bg-emerald-600 px-3 py-1 text-white"
                  : step > n
                    ? "rounded-full bg-emerald-50 px-3 py-1 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                    : "rounded-full bg-zinc-100 px-3 py-1 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              }
            >
              {n}. {label}
            </span>
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4 py-2">
            {/* [v4.4, Spec Addendum Section 10] Only the merchant-supplied
                SUFFIX is typed here — one shared value for the whole
                submission. The read-only date chip is a cosmetic preview of
                the server-generated prefix, never sent to the server. */}
            <div className="space-y-2">
              <Label>رقم الدفعة (Batch Number) — يُدخل مرة واحدة لكل الأصناف *</Label>
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
                  className="flex-1"
                />
              </div>
              <p className="text-xs text-zinc-500">
                يُضاف تاريخ اليوم تلقائياً من الخادم — أدخل فقط الجزء الذي تريده (رقم تسلسلي، رقم فاتورة المورّد...).
              </p>
            </div>

            <div className="space-y-2">
              <Label>ملاحظة تاريخ الشراء (اختياري)</Label>
              <Input
                type="date"
                value={purchaseDateNote}
                onChange={(e) => setPurchaseDateNote(e.target.value)}
              />
              {/* The note must never read as something the system stores. */}
              <p className="text-xs text-zinc-500">
                للتنبيه فقط — لا يُحفظ في النظام ولا يؤثر على تاريخ الدفعة المسجَّل. يُستخدم لتذكيرك أثناء المراجعة،
                ورقم الدفعة يحمل دائماً تاريخ الحفظ الفعلي من الخادم.
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                أضف صنفاً لكل منتج داخل هذه الفاتورة — الكمية وإجمالي التكلفة المدفوعة مطلوبان في كل سطر.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={addItem}
                className="gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-400"
              >
                <Plus size={14} aria-hidden />
                <span>إضافة صنف</span>
              </Button>
            </div>

            {items.length === 0 && (
              <p className="rounded-md border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                لا توجد أصناف — اضغط «إضافة صنف» للبدء.
              </p>
            )}

            {items.map((row, index) => {
              const product = products.find((p) => p.id === row.productId);
              // [FIX] The set of units this row's <select> may offer — a
              // deactivated ProductUnit must never be selectable for a new
              // batch. The server rejects it (InactiveEntryUnitError), but
              // the UI must not offer it in the first place.
              const activeUnits = product?.units.filter((u) => u.isActive !== false) ?? [];
              const selectedUnit = activeUnits.find((u) => u.id === row.unitId);
              // The product's base unit — `isBaseUnit` is precomputed by the
              // backend (base-unit.ts's toSafeProductWithUnits()); the
              // factor-1 lookup only covers a payload predating that field.
              // Looked up across ALL of the product's units (not just active
              // ones) since the base unit's name remains meaningful for
              // display regardless of its own active state.
              const productBaseUnit =
                product?.units.find((u) => u.isBaseUnit === true) ??
                product?.units.find((u) => u.conversionFactor === 1);
              const selectedUnitIsBaseUnit =
                !!selectedUnit &&
                (selectedUnit.isBaseUnit === true || selectedUnit.conversionFactor === 1);
              // [Batch cost entry] Same shared derivation the server runs for
              // this row — null until both values are actually derivable, so a
              // half-typed row shows nothing instead of a misleading 0.00.
              const costBreakdown = costBreakdownForDisplay(
                row.totalCost.trim(),
                row.quantity.trim(),
                selectedUnit?.conversionFactor ?? 0
              );

              return (
                <div key={row.rowId} className="rounded-lg border border-zinc-200 p-3 space-y-3 dark:border-zinc-800">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">السطر {index + 1}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => removeItem(row.rowId)}
                      className="h-8 gap-1 text-xs text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30"
                    >
                      <Trash2 size={14} aria-hidden />
                      <span>إزالة</span>
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">المنتج *</Label>
                      <select
                        value={row.productId}
                        onChange={(e) => {
                          // [FIX] Switching product resets the unit to that
                          // product's first ACTIVE unit — a deactivated unit
                          // must never be silently selected, and a unit id
                          // belonging to the previously selected product
                          // could never be valid here regardless.
                          const nextProduct = products.find((p) => p.id === e.target.value);
                          const nextActiveUnits =
                            nextProduct?.units.filter((u) => u.isActive !== false) ?? [];
                          updateItem(row.rowId, {
                            productId: e.target.value,
                            unitId: nextActiveUnits[0]?.id || "",
                          });
                        }}
                        className="w-full h-9 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-sm"
                      >
                        <option value="">اختر المنتج...</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">الوحدة المشتراة *</Label>
                      {/* [FIX] Options built from `activeUnits`, not
                          `product.units` directly. */}
                      <select
                        value={row.unitId}
                        onChange={(e) => updateItem(row.rowId, { unitId: e.target.value })}
                        className="w-full h-9 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-sm"
                        disabled={!product || activeUnits.length === 0}
                      >
                        {!product || activeUnits.length === 0 ? (
                          <option value="">لا توجد وحدات قياس فعّالة لهذا المنتج</option>
                        ) : (
                          activeUnits.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.unitName} (معامل تحويل: {u.conversionFactor})
                            </option>
                          ))
                        )}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        الكمية المستلمة *{selectedUnit ? ` (بوحدة ${selectedUnit.unitName})` : ""}
                      </Label>
                      {/* Decimal-STRING input, matching AddBatchModal: the raw
                          text is sent as-is and never parsed through
                          parseFloat(). */}
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="مثال: 10"
                        value={row.quantity}
                        onChange={(e) => updateItem(row.rowId, { quantity: e.target.value })}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">إجمالي التكلفة المدفوعة * (ل.س)</Label>
                      {/* [Batch cost entry] The TOTAL paid for this row's whole
                          quantity — never a per-unit figure. Decimal-STRING
                          input, matching AddBatchModal: the raw text is sent
                          as-is and never parsed through parseFloat(). */}
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="مثال: 54000"
                        value={row.totalCost}
                        onChange={(e) => updateItem(row.rowId, { totalCost: e.target.value })}
                      />
                    </div>

                    <div className="space-y-1.5 sm:col-span-2">
                      <Label className="text-xs">تاريخ الانتهاء (اختياري)</Label>
                      <Input
                        type="date"
                        value={row.expiryDate}
                        onChange={(e) => updateItem(row.rowId, { expiryDate: e.target.value })}
                      />
                    </div>
                  </div>

                  {/* [Batch cost entry] Live per-row derivation — the merchant
                      sees the per-base-unit cost the server is about to store
                      before saving anything. */}
                  {costBreakdown && selectedUnit && (
                    <div
                      aria-live="polite"
                      className="space-y-1 rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2 text-[11px] dark:border-emerald-900 dark:bg-emerald-950/20"
                    >
                      {!selectedUnitIsBaseUnit && (
                        <p className="font-medium text-emerald-800 dark:text-emerald-300">
                          {row.quantity.trim()} {selectedUnit.unitName} ={" "}
                          {costBreakdown.quantityInBaseUnits}{" "}
                          {productBaseUnit?.unitName || "وحدة أساسية"}
                        </p>
                      )}
                      {/* Hidden when the row's unit IS the base unit — it would
                          repeat the per-base-unit figure below verbatim. */}
                      {!selectedUnitIsBaseUnit && (
                        <p className="text-emerald-700 dark:text-emerald-400">
                          سعر وحدة الشراء ({selectedUnit.unitName}):{" "}
                          {formatMoney(costBreakdown.pricePerPurchaseUnit, "SYP", 2)} ل.س
                        </p>
                      )}
                      <p className="text-emerald-700 dark:text-emerald-400">
                        سعر الوحدة الأساسية
                        {productBaseUnit ? ` (${productBaseUnit.unitName})` : ""}:{" "}
                        {formatMoney(costBreakdown.pricePerBaseUnit, "SYP", 2)} ل.س
                      </p>
                    </div>
                  )}

                  <p className="text-[11px] text-zinc-500">
                    إجمالي التكلفة دائماً بالليرة السورية — أدخل ما دفعته فعلاً مقابل الكمية في هذا
                    السطر، ويُحسب سعر الوحدة الأساسية تلقائياً. لا يظهر للزبائن ولا يتأثر بعملة تسعير
                    الوحدة.
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900 dark:bg-emerald-950/20">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-semibold text-emerald-800 dark:text-emerald-300">
                  عدد الأصناف: {items.length}
                </span>
                <span className="font-mono font-semibold text-emerald-800 dark:text-emerald-300">
                  إجمالي تكلفة الشراء: {estimatedTotalCost().toFixed(2)} ل.س
                </span>
              </div>
              <p className="mt-1 text-[11px] text-emerald-700/80 dark:text-emerald-400/80">
                مجموع الإجماليات التي أدخلتها في كل سطر — أي ما دفعته فعلاً في هذه الفاتورة.
              </p>
            </div>

            <div className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              <p>
                رقم الدفعة المخزَّن سيكون:{" "}
                <span className="font-mono text-zinc-800 dark:text-zinc-200">
                  {"{تاريخ الخادم}"}-{batchNumberSuffix.trim() || "—"}
                </span>{" "}
                (يُبنى عند الحفظ من تاريخ الخادم الفعلي).
              </p>
              {purchaseDateNote.trim() !== "" && (
                <p>
                  {/* Shown back as a memory aid ONLY — never persisted. */}
                  ملاحظة الشراء: {purchaseDateNote.trim()} —{" "}
                  <span className="text-zinc-500">للتنبيه فقط ولا تُحفظ في النظام.</span>
                </p>
              )}
            </div>

            <div className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
              {items.map((row, index) => {
                const product = products.find((p) => p.id === row.productId);
                const unit = product?.units.find((u) => u.id === row.unitId);
                // [Batch cost entry] Read-only echo of what the server will
                // derive for this row out of the entered quantity + total.
                const rowBreakdown = costBreakdownForDisplay(
                  row.totalCost.trim(),
                  row.quantity.trim(),
                  unit?.conversionFactor ?? 0
                );
                return (
                  <div key={row.rowId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="text-zinc-700 dark:text-zinc-300">
                      {index + 1}. {product?.name || "منتج غير محدد"}
                    </span>
                    <span className="font-mono text-xs text-zinc-500">
                      {row.quantity.trim()} {unit?.unitName || ""} · الإجمالي:{" "}
                      {row.totalCost.trim()} ل.س
                      {rowBreakdown ? ` · لكل وحدة أساسية: ${rowBreakdown.pricePerBaseUnit} ل.س` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
            disabled={loading}
          >
            إلغاء
          </Button>

          {step > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(step === 3 ? 2 : 1)}
              disabled={loading}
            >
              السابق
            </Button>
          )}

          {step === 1 && (
            <Button
              type="button"
              onClick={goToItemsStep}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              التالي: الأصناف
            </Button>
          )}

          {step === 2 && (
            <Button
              type="button"
              onClick={goToReviewStep}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              التالي: المراجعة
            </Button>
          )}

          {step === 3 && (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {loading ? "جاري الحفظ..." : "حفظ الدفعة"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}