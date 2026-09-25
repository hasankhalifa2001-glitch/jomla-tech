/**
 * T4f addendum — Rule 4: THERMAL PRINTER WIDTH IS AN EXPLICIT, PER-DEVICE SETTING.
 *
 *   COVERAGE → ACCEPTANCE CRITERIA
 *   1. No code path infers dots-per-line from Bluetooth device metadata or from
 *      paper-width selection alone:
 *        - printer-config.ts's SOURCE contains no navigator.bluetooth / .gatt /
 *          requestDevice / device-name read (comments stripped first — the file
 *          documents the rule it must not break);
 *        - 576 / 384 appear in exactly two non-test files: the suggestion map
 *          (a prefill, never applied) and constraints.ts (the fixed PDF raster
 *          width, which is explicitly NOT a print-head width);
 *        - resolvePrintableWidth()'s body never mentions the paper width.
 *   2. An unconfirmed config is its own state and can never become printable by
 *      itself; resolvePrintableWidth() THROWS rather than defaulting.
 *   3. Persistence is per DEVICE: the stored row carries no tenantId and no
 *      userId, the reader takes no tenant/user argument, and the value survives
 *      a fresh read from Dexie.
 *
 * Runs against fake-indexeddb, the same harness lib/offline/__tests__ uses.
 */

import "fake-indexeddb/auto";
import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getOfflineDb, resetOfflineDbForTests } from "@/lib/offline/db";
import {
  DEFAULT_PAPER_WIDTH,
  DEVICE_SETTING_KEY_THERMAL_PRINTER,
  MAX_DOTS_PER_LINE,
  PAPER_WIDTH_SUGGESTED_DOTS,
  PRINTER_SETUP_REQUIRED_MESSAGE,
  PrinterNotConfiguredError,
  clearPrinterConfig,
  confirmPrinterConfig,
  createUnconfirmedPrinterConfig,
  fromDeviceSettingRecord,
  readPrinterConfig,
  resolvePrintableWidth,
  savePrinterConfig,
  suggestedDotsPerLine,
  toDeviceSettingRecord,
} from "@/lib/receipts/printer-config";

const rootDir = process.cwd();

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

/**
 * Comments are stripped before every source scan below. This is not laziness —
 * it is required for the assertions to MEAN anything: printer-config.ts's own
 * header names `navigator.bluetooth`, `.gatt` and `requestDevice` while
 * explaining why it must not use them, and constraints.ts's header explains that
 * 576 is NOT a print-head width. A scan that matched its own documentation
 * would force the codebase to stop documenting its rules in order to pass.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

beforeEach(async () => {
  await resetOfflineDbForTests();
});

afterEach(async () => {
  await resetOfflineDbForTests();
});

describe("Rule 4 — width is never inferred", () => {
  it("printer-config.ts contains no Web Bluetooth / device-metadata access", () => {
    const code = stripComments(readSource("lib/receipts/printer-config.ts"));

    for (const forbidden of [
      "navigator.bluetooth",
      ".gatt",
      "requestDevice",
      "device.name",
    ]) {
      expect(code, `printer-config.ts must not reference '${forbidden}'`).not.toContain(
        forbidden
      );
    }
  });

  it("the only width literals in lib/receipts are the prefill suggestion and the fixed PDF raster", () => {
    const receiptDir = path.join(rootDir, "lib", "receipts");
    const offenders: string[] = [];

    for (const entry of fs.readdirSync(receiptDir)) {
      if (!entry.endsWith(".ts")) continue;
      const code = stripComments(fs.readFileSync(path.join(receiptDir, entry), "utf8"));
      if (/\b(576|384)\b/.test(code)) offenders.push(entry);
    }

    // constraints.ts — the PDF raster width, device-independent by design.
    // printer-config.ts — the PREFILL map (and nothing else consults it).
    expect(offenders.sort()).toEqual(["constraints.ts", "printer-config.ts"]);
  });

  it("resolvePrintableWidth() never consults the selected paper width", () => {
    const code = stripComments(readSource("lib/receipts/printer-config.ts"));
    const start = code.indexOf("export function resolvePrintableWidth");
    expect(start).toBeGreaterThan(-1);

    const body = code.slice(start, code.indexOf("\n}", start));

    expect(body).not.toContain("paperWidth");
    expect(body).not.toContain("suggestedDotsPerLine");
    expect(body).not.toContain("PAPER_WIDTH_SUGGESTED_DOTS");
    // And it does require the explicit confirmation, by name.
    expect(body).toContain("isConfirmed");
  });

  it("a paper-width choice is only ever a prefilled, UNCONFIRMED config", () => {
    expect(PAPER_WIDTH_SUGGESTED_DOTS["80mm"]).toBe(576);
    expect(PAPER_WIDTH_SUGGESTED_DOTS["58mm"]).toBe(384);
    expect(suggestedDotsPerLine("58mm")).toBe(384);

    const unconfirmed = createUnconfirmedPrinterConfig("58mm");
    expect(unconfirmed.paperWidth).toBe("58mm");
    expect(unconfirmed.dotsPerLine).toBe(384);
    expect(unconfirmed.isConfirmed).toBe(false);
    expect(unconfirmed.confirmedAt).toBeNull();

    // Selecting a width therefore cannot print: the resolver refuses it.
    expect(() => resolvePrintableWidth(unconfirmed)).toThrow(PrinterNotConfiguredError);
    expect(() => resolvePrintableWidth(unconfirmed)).toThrow(PRINTER_SETUP_REQUIRED_MESSAGE);
  });

  it("an unset config throws instead of falling back to a default", () => {
    expect(DEFAULT_PAPER_WIDTH).toBe("80mm");
    expect(() => resolvePrintableWidth(null)).toThrow(PrinterNotConfiguredError);
    expect(() => resolvePrintableWidth(undefined)).toThrow(PrinterNotConfiguredError);
  });

  it("confirmation is the only path to a usable width, and it validates shape", () => {
    const base = createUnconfirmedPrinterConfig("80mm");
    const confirmed = confirmPrinterConfig(base, 576);

    expect(confirmed.isConfirmed).toBe(true);
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    expect(resolvePrintableWidth(confirmed)).toBe(576);

    // 58 mm / 384 works identically.
    const narrow = confirmPrinterConfig(createUnconfirmedPrinterConfig("58mm"), 384);
    expect(resolvePrintableWidth(narrow)).toBe(384);

    // Not a multiple of 8: thermal heads address whole bytes per line.
    expect(() => confirmPrinterConfig(base, 570)).toThrow();
    expect(() => confirmPrinterConfig(base, 0)).toThrow();
    expect(() => confirmPrinterConfig(base, -384)).toThrow();
    expect(() => confirmPrinterConfig(base, 1.5)).toThrow();
    expect(() => confirmPrinterConfig(base, MAX_DOTS_PER_LINE + 8)).toThrow();
  });
});

describe("Rule 4 — the setting is per DEVICE, not per tenant or user", () => {
  it("the stored row carries no tenantId and no userId", () => {
    const record = toDeviceSettingRecord(
      confirmPrinterConfig(createUnconfirmedPrinterConfig("80mm"), 576)
    );
    const keys = Object.keys(record);

    expect(keys).toContain("key");
    expect(keys).not.toContain("tenantId");
    expect(keys).not.toContain("userId");
    expect(record.key).toBe(DEVICE_SETTING_KEY_THERMAL_PRINTER);
  });

  it("neither the reader nor the writer takes a tenant/user argument", () => {
    // A tenant-scoped signature would put the value on the tenant; a
    // user-scoped one would follow the cashier onto a different device. Rule 4
    // requires neither: the same tenant's cashiers may use different printers.
    expect(readPrinterConfig.length).toBe(0);
    expect(savePrinterConfig.length).toBe(1);
  });

  it("round-trips through Dexie's deviceSettings table (survives a new session)", async () => {
    expect(await readPrinterConfig()).toBeNull();

    await savePrinterConfig(confirmPrinterConfig(createUnconfirmedPrinterConfig("58mm"), 384));

    const reloaded = await readPrinterConfig();
    expect(reloaded?.paperWidth).toBe("58mm");
    expect(reloaded?.dotsPerLine).toBe(384);
    expect(reloaded?.isConfirmed).toBe(true);
    expect(resolvePrintableWidth(reloaded)).toBe(384);

    await clearPrinterConfig();
    expect(await readPrinterConfig()).toBeNull();
  });

  it("a half-written or hand-edited row is INERT, never 'close enough'", async () => {
    await getOfflineDb().deviceSettings.put({
      key: DEVICE_SETTING_KEY_THERMAL_PRINTER,
      printerPaperWidth: "80mm",
      printerDotsPerLine: 576,
      printerIsConfirmed: undefined,
      updatedAt: new Date(),
    });

    const stored = await readPrinterConfig();
    expect(stored?.isConfirmed).toBe(false);
    expect(() => resolvePrintableWidth(stored)).toThrow(PrinterNotConfiguredError);
  });

  it("rejects a row that is not this module's setting, or whose width is nonsense", () => {
    const now = new Date();

    expect(fromDeviceSettingRecord({ key: "some-other-setting", updatedAt: now })).toBeNull();
    expect(
      fromDeviceSettingRecord({
        key: DEVICE_SETTING_KEY_THERMAL_PRINTER,
        printerPaperWidth: "80mm",
        printerDotsPerLine: 0,
        printerIsConfirmed: true,
        updatedAt: now,
      })
    ).toBeNull();
  });
});
