/**
 * components/receipts/receipts-utils.ts
 *
 * v4.7 Phase 7 — display-only formatters for the receipts log. No fetching,
 * no state, no arithmetic on quantities — presentation only, mirroring
 * components/sales-log/sales-log-utils.ts's role for the sales log.
 *
 * [TWO ZONES, TWO RULES — deliberately different]
 *   - purchaseDate is a @db.Date column: rendered with lib/inventory/
 *     date-utils.ts's formatDbDate(), whose formatter is pinned to UTC. A
 *     @db.Date is stored as UTC midnight and must be read back in UTC or a
 *     browser west of UTC would show the PREVIOUS calendar day. formatDbDate
 *     is THE sanctioned reader of that column — never Date#getDate() here.
 *   - createdAt is a real timestamp of when the row was entered: rendered
 *     for the merchant in Asia/Damascus (fixed UTC+3 since 2022), so "17:00"
 *     means 17:00 to the merchant regardless of the viewing device's zone.
 *     The Intl formatter below is pinned to the BUSINESS_TIME_ZONE label
 *     ("Asia/Damascus") — display formatting only; every day-ARITHMETIC
 *     concern (business-day keys, boundaries) stays in syria-time.ts / date-
 *     utils.ts, which this module does not duplicate or re-derive. Because
 *     the zone is a permanent UTC+3 (no DST), the output is deterministic on
 *     any modern tzdata — the same premise batch-number's tests rest on.
 */

import { BUSINESS_TIME_ZONE, formatDbDate } from "@/lib/inventory/date-utils";

/** 'YYYY-MM-DD' for a receipt's purchaseDate (@db.Date, always UTC). */
export function formatPurchaseDate(iso: string): string {
  return formatDbDate(new Date(iso));
}

// Display-only formatter; created once at module load, reused for every row.
const damascusFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * 'YYYY-MM-DD HH:mm' in Asia/Damascus for a createdAt instant ("en-CA"
 * yields ISO-style YYYY-MM-DD field order with 2-digit fields; hour12: false
 * keeps 00–23 — no locale guessing, no device-zone influence).
 */
export function formatCreatedAt(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return "—";
  const parts = damascusFormatter.formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

/** 'DD Mon YYYY' (ar-SY, device zone — ExpiryBadge's precedent) or "—". */
export function formatExpiryDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ar-SY", { year: "numeric", month: "short", day: "numeric" });
}

/** Quantity display: raw decimal string + unit name (e.g. "24 قطعة"). */
export function formatQty(value: string, unitName: string): string {
  return `${value} ${unitName}`;
}

