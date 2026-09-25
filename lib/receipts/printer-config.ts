/**
 * lib/receipts/printer-config.ts
 *
 * T4f addendum — Rule 4: printer width is a MANUAL, EXPLICIT, PER-DEVICE
 * setting. Never inferred, never guessed.
 *
 * The problem this file exists to make impossible: 80 mm and 58 mm thermal
 * printers are commonly — but not universally — 576 and 384 dots per line.
 * "Commonly" is the whole trap. Web Bluetooth's device metadata does not
 * expose the print head's resolution, so any code that reads
 * `device.name`/GATT metadata, or that maps paper width → dots and calls it
 * done, is guessing at hardware it cannot see, and a wrong guess produces a
 * receipt that is silently clipped (or shrunk) on the customer's copy.
 *
 * THE RULE, stated once, enforced here:
 *   1. Suggested values may PREFILL a form. They are never applied.
 *      PAPER_WIDTH_SUGGESTED_DOTS is exported for the settings UI and for
 *      nothing else; `resolvePrintableWidth()` below will not act on a config
 *      until a human has explicitly confirmed it.
 *   2. An unconfirmed config is its own state (`isConfirmed: false`) and is
 *      never coerced into a usable one. This mirrors T3a's BarcodeSource rule
 *      exactly (see prisma/schema.prisma's BarcodeSource note and
 *      components/inventory/AddProductModal.tsx, where "" is a distinct
 *      "unconfirmed" value never silently turned into "INTERNAL") — the
 *      addendum cites that precedent directly, so this file follows it rather
 *      than inventing a new posture.
 *   3. Persistence is per DEVICE: one row in Dexie's `deviceSettings` table
 *      (lib/offline/db.ts, version 2), which carries no tenantId and no userId
 *      — the same tenant's cashiers may use different physical printers on
 *      different devices, so a tenant- or user-scoped setting would be
 *      structurally wrong, not merely inconvenient.
 *
 * [NOT THIS FILE'S JOB] Nothing here talks to Bluetooth. The transport lives
 * in lib/receipts/bluetooth-printer.ts, which imports this module (never the
 * reverse). A static source scan in the T4f tests asserts that this file
 * contains no navigator.bluetooth / gatt / requestDevice reference at all, so
 * "width could be inferred from the device" stays mechanically false rather
 * than merely reviewed.
 *
 * [FIX] validateDotsPerLine() previously hardcoded the literal `8` for the
 * "must be a byte-aligned width" rule, duplicating constraints.ts's
 * RASTER_PIXEL_ALIGNMENT (the same constant escpos.ts's
 * bytesPerRowForWidth() already enforces this rule against). Now imported
 * and referenced directly, so the two checks can never drift apart.
 */

import { getOfflineDb, isOfflineDbSupported, type DeviceSetting } from "@/lib/offline/db";
import { RASTER_PIXEL_ALIGNMENT } from "./constraints";

export type PaperWidth = "80mm" | "58mm";

/**
 * A PREFILL-ONLY suggestion. Present so the settings UI can open on a sensible
 * value; deliberately not a lookup table any print path may consult. The only
 * function that returns it has "unconfirmed" in its name.
 */
export const PAPER_WIDTH_SUGGESTED_DOTS: Record<PaperWidth, number> = {
  "80mm": 576,
  "58mm": 384,
};

export const DEFAULT_PAPER_WIDTH: PaperWidth = "80mm";

/** The one row this module owns in Dexie's deviceSettings table. */
export const DEVICE_SETTING_KEY_THERMAL_PRINTER = "thermal-printer";

/** Sanity ceiling for a hand-entered override (a 300 dpi 112 mm head is 1320). */
export const MAX_DOTS_PER_LINE = 4096;

export const PRINTER_SETUP_REQUIRED_MESSAGE =
  "لم يتم ضبط عرض رأس الطابعة على هذا الجهاز بعد — افتح «إعدادات الطابعة» لتحديد المقاس (80مم / 58مم) وتأكيد عدد النقاط في السطر.";

export class PrinterNotConfiguredError extends Error {
  constructor(message: string = PRINTER_SETUP_REQUIRED_MESSAGE) {
    super(message);
    this.name = "PrinterNotConfiguredError";
  }
}

export class InvalidPrinterWidthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPrinterWidthError";
  }
}

export interface PrinterConfig {
  paperWidth: PaperWidth;
  /** Dots per printed line — the value that must equal the bitmap's width. */
  dotsPerLine: number;
  /** See rule 2 above. False means "not yet usable", never "assume". */
  isConfirmed: boolean;
  confirmedAt: Date | null;
  updatedAt: Date;
}

export function isPaperWidth(value: unknown): value is PaperWidth {
  return value === "80mm" || value === "58mm";
}

/** The suggested (never applied) dots-per-line for a paper width. */
export function suggestedDotsPerLine(paperWidth: PaperWidth): number {
  return PAPER_WIDTH_SUGGESTED_DOTS[paperWidth];
}

/**
 * A config that has NOT been confirmed: the paper width is remembered (so the
 * form reopens where the user left it) but `isConfirmed` is false, which makes
 * it unusable for printing. Selecting a paper width alone therefore can never
 * silently become a decision.
 */
export function createUnconfirmedPrinterConfig(
  paperWidth: PaperWidth = DEFAULT_PAPER_WIDTH,
  now: Date = new Date()
): PrinterConfig {
  return {
    paperWidth,
    dotsPerLine: suggestedDotsPerLine(paperWidth),
    isConfirmed: false,
    confirmedAt: null,
    updatedAt: now,
  };
}

/**
 * Validates a human-entered dots-per-line value. Must be a positive integer, a
 * multiple of RASTER_PIXEL_ALIGNMENT (thermal heads address whole bytes per
 * line — see escpos.ts's bytesPerRowForWidth(), which enforces the identical
 * rule from the same constant), and within MAX_DOTS_PER_LINE.
 */
export function validateDotsPerLine(value: number): number {
  if (!Number.isInteger(value)) {
    throw new InvalidPrinterWidthError(
      `عدد النقاط في السطر يجب أن يكون رقماً صحيحاً (تم إدخال ${value}).`
    );
  }
  if (value <= 0 || value > MAX_DOTS_PER_LINE) {
    throw new InvalidPrinterWidthError(
      `عدد النقاط في السطر يجب أن يكون بين ${RASTER_PIXEL_ALIGNMENT} و ${MAX_DOTS_PER_LINE} (تم إدخال ${value}).`
    );
  }
  if (value % RASTER_PIXEL_ALIGNMENT !== 0) {
    throw new InvalidPrinterWidthError(
      `عدد النقاط في السطر يجب أن يكون من مضاعفات ${RASTER_PIXEL_ALIGNMENT} لأن الطابعة الحرارية تعنون الخط بالبايت (تم إدخال ${value}).`
    );
  }
  return value;
}

/**
 * The explicit confirmation step — the ONLY way a PrinterConfig becomes
 * printable. Called from the settings UI when the user presses «تأكيد».
 */
export function confirmPrinterConfig(
  config: PrinterConfig,
  dotsPerLine: number,
  now: Date = new Date()
): PrinterConfig {
  return {
    paperWidth: config.paperWidth,
    dotsPerLine: validateDotsPerLine(dotsPerLine),
    isConfirmed: true,
    confirmedAt: now,
    updatedAt: now,
  };
}

/**
 * The print pipeline's single source of truth for bitmap width. Throws
 * PrinterNotConfiguredError for a missing or UNCONFIRMED config — an
 * unfinished printer setup must never degrade into a default width.
 */
export function resolvePrintableWidth(
  config: PrinterConfig | null | undefined
): number {
  if (!config || !config.isConfirmed) throw new PrinterNotConfiguredError();
  // A persisted row could have been hand-edited; re-validate on read.
  return validateDotsPerLine(config.dotsPerLine);
}

// ---------------------------------------------------------------------------
// Per-device persistence (Dexie `deviceSettings`, version 2)
// ---------------------------------------------------------------------------

/**
 * The stored row. Note what is absent: no tenantId, no userId, no device
 * fingerprint. The row can therefore only ever describe "this browser
 * profile" — which is exactly the granularity Rule 4 asks for.
 */
export function toDeviceSettingRecord(
  config: PrinterConfig,
  now: Date = new Date()
): DeviceSetting {
  return {
    key: DEVICE_SETTING_KEY_THERMAL_PRINTER,
    printerPaperWidth: config.paperWidth,
    printerDotsPerLine: config.dotsPerLine,
    printerIsConfirmed: config.isConfirmed,
    printerConfirmedAt: config.confirmedAt ?? undefined,
    updatedAt: config.updatedAt ?? now,
  };
}

/**
 * Reads a stored row back. Returns null when nothing was ever saved. A row
 * whose `printerIsConfirmed` is not exactly `true` comes back with
 * `isConfirmed: false` (see DeviceSetting's own note) so a partially written
 * row is inert rather than usable.
 */
export function fromDeviceSettingRecord(record: DeviceSetting): PrinterConfig | null {
  if (record.key !== DEVICE_SETTING_KEY_THERMAL_PRINTER) return null;
  if (!isPaperWidth(record.printerPaperWidth)) return null;

  const dots = record.printerDotsPerLine;
  if (typeof dots !== "number" || !Number.isInteger(dots) || dots <= 0) {
    return null;
  }

  return {
    paperWidth: record.printerPaperWidth,
    dotsPerLine: dots,
    isConfirmed: record.printerIsConfirmed === true,
    confirmedAt: record.printerConfirmedAt ?? null,
    updatedAt: record.updatedAt,
  };
}

function assertOfflineDbAvailable(): void {
  if (!isOfflineDbSupported()) {
    throw new Error(
      "إعدادات الطابعة محفوظة على هذا الجهاز فقط، وتتطلب تفعيل التخزين المحلي (IndexedDB) في المتصفح."
    );
  }
}

/** null when this device has never been configured. */
export async function readPrinterConfig(): Promise<PrinterConfig | null> {
  assertOfflineDbAvailable();
  const row = await getOfflineDb()
    .deviceSettings.get(DEVICE_SETTING_KEY_THERMAL_PRINTER);
  return row ? fromDeviceSettingRecord(row) : null;
}

/** Upserts the device's printer row and returns the persisted config. */
export async function savePrinterConfig(
  config: PrinterConfig,
  now: Date = new Date()
): Promise<PrinterConfig> {
  assertOfflineDbAvailable();
  const persisted: PrinterConfig = { ...config, updatedAt: now };
  await getOfflineDb().deviceSettings.put(toDeviceSettingRecord(persisted, now));
  return persisted;
}

/** Convenience for the settings UI's "clear/reset" affordance. */
export async function clearPrinterConfig(): Promise<void> {
  assertOfflineDbAvailable();
  await getOfflineDb().deviceSettings.delete(DEVICE_SETTING_KEY_THERMAL_PRINTER);
}