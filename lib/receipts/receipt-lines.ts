/**
 * lib/receipts/receipt-lines.ts
 *
 * T4f addendum — the pure, shared label/formatting rules for every receipt
 * line this system can print or share. Rule 5 of the addendum ("negative
 * quantity display on void receipts") and Condition 4 of the approved PDF
 * plan ("void totals are shown as إجمالي المرتجع, absolute") both live here,
 * ONCE, so the thermal bitmap and the shared PDF cannot render the same
 * invoice differently.
 *
 * [Rule 5 — WHY THIS IS NOT JUST `${quantity}`] T4d stores a void
 * InvoiceItem.quantity as a negative number in the original sale unit
 * ("-3") explicitly "for display purposes only". The whole point of that
 * storage decision is that the DISPLAY then has to turn it into something a
 * customer can read — a printed receipt showing "-3 طرد" reads as a
 * bookkeeping artifact, not as "the customer returned 3 cartons". So any
 * negative quantity renders under an explicit "مرتجع" label using the
 * ABSOLUTE value, never a bare minus sign, on both widths and in both the
 * PNG/PDF and thermal paths.
 *
 * [MONEY DISCIPLINE] Every absolute value here goes through
 * lib/utils/money.ts's compareMoney/subtractMoney — never Math.abs, never
 * native Number arithmetic, never Decimal.negated() directly. That mirrors
 * the exact rule the void path itself already follows: server-side
 * (app/api/ledger/voids/route.ts negates via subtractMoney("0", x)) and
 * offline (lib/offline/db.ts's createOfflineVoidRecord), so a receipt's
 * arithmetic is the same arithmetic the ledger used.
 */

import {
  compareMoney,
  formatMoney,
  serializeMoney,
  subtractMoney,
  toDecimal,
  type MoneyInput,
} from "@/lib/utils/money";

// ---------------------------------------------------------------------------
// The Arabic vocabulary this whole feature is built from. Every user-visible
// string a receipt renders appears here exactly once — a test asserts these
// specific byte sequences, and no component is allowed to hand-write them.
// ---------------------------------------------------------------------------

/** Rule 5's label for a reversed line item. */
export const RETURN_LABEL = "مرتجع";

/** The document label for a void in both sources (server VOIDED / local void). */
export const VOID_DOCUMENT_LABEL = "إيصال إلغاء";

/** The document label for an ordinary sale. */
export const SALE_DOCUMENT_LABEL = "إيصال بيع";

/** Condition 4 — the void total label. Never "الإجمالي" with a minus sign. */
export const VOID_TOTAL_LABEL = "إجمالي المرتجع";

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: "نقداً (كاش)",
  SHAM_CASH: "شام كاش (Sham Cash)",
  SYRIATEL_CASH: "سيرياتيل كاش (Syriatel)",
  BANK_TRANSFER: "تحويل بنكي / مكتب",
  OTHER: "وسيلة أخرى",
};

/** Shown on a receipt printed while the invoice is still device-local. */
export const LOCAL_ONLY_NOTICE =
  "هذه الفاتورة محفوظة على هذا الجهاز فقط — لم تتم المزامنة مع السيرفر بعد.";

// ---------------------------------------------------------------------------
// Numeric formatting
// ---------------------------------------------------------------------------

/**
 * Quantities are Decimal(18,4) strings end-to-end (db.ts's OfflineInvoiceItem
 * and ProductBatch.quantity alike), because a weighed product can be sold as
 * e.g. 1.75 kg. Printing "1.7500" on a receipt is noise, so trailing zeros
 * are trimmed — but the trimming happens on the DECIMAL's own fixed-point
 * string, never by round-tripping through Number().
 */
export function formatQuantity(quantity: MoneyInput): string {
  const fixed = toDecimal(quantity).toFixed(4);
  const trimmed = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
  if (trimmed === "" || trimmed === "-0" || trimmed === "-") return "0";
  return trimmed;
}

export function isNegativeQuantity(quantity: MoneyInput): boolean {
  return compareMoney(quantity, "0") < 0;
}

/** |value| as a Decimal string, via the money module only. */
export function absoluteMoney(value: MoneyInput): string {
  return compareMoney(value, "0") < 0
    ? subtractMoney("0", value)
    : serializeMoney(value);
}

/**
 * Rule 5 in one function: "مرتجع: 3 طرد" for a negative quantity (absolute
 * value, explicit label), "3 طرد" otherwise.
 */
export function formatQuantityLabel(
  quantity: MoneyInput,
  unitName: string
): string {
  const unit = unitName.trim() || "وحدة";
  if (isNegativeQuantity(quantity)) {
    return `${RETURN_LABEL}: ${formatQuantity(absoluteMoney(quantity))} ${unit}`;
  }
  return `${formatQuantity(quantity)} ${unit}`;
}

export function sypLabel(value: MoneyInput): string {
  return `${formatMoney(value, "SYP")} ل.س`;
}

export function usdLabel(value: MoneyInput): string {
  return `$${formatMoney(value, "USD")}`;
}

/** "150,000 ل.س (≈ $10.00)" — the shape the rest of the UI already uses. */
export function dualMoneyLabel(syp: MoneyInput, usd: MoneyInput | null): string {
  return usd === null ? sypLabel(syp) : `${sypLabel(syp)} (≈ ${usdLabel(usd)})`;
}

/**
 * A receipt timestamp. Deliberately locale-driven (ar-SY), matching
 * lib/utils/money.ts's own "Intl for localized display only" precedent.
 * Tests assert shape/absence-of-minus rather than an exact string, since the
 * exact output is Node/ICU-version dependent by design.
 */
export function formatReceiptTimestamp(createdAt: Date | string): string {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-SY", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

export function paymentMethodLabel(paymentMethod?: string | null): string | null {
  if (!paymentMethod) return null;
  return PAYMENT_METHOD_LABELS[paymentMethod] ?? paymentMethod;
}
