/**
 * Static source scans for the by-amount (بيع بالمبلغ) feature.
 *
 *  1. The tolerance rule lives ONLY in lib/utils/money.ts: one definition
 *     there, and no second literal (0.00005, 5e-5, 0.5e-4, 1/20000) anywhere
 *     else under app/, lib/ or components/ (tests excluded).
 *  2. lib/offline/pos-service.ts never does native arithmetic on a cart
 *     line's `quantity` (every write goes through money.ts).
 *  3. isBaseUnitLine() is the ONLY place in pos-service.ts that compares a
 *     unit's conversionFactor to 1 via compareMoney.
 *  4. No component under components/pos/** writes `lineTotalOverrideSYP`
 *     (only the pure funnel in pos-service.ts does).
 *
 * Every scan runs on SOURCE WITH COMMENTS REMOVED (and, where noted, string
 * literals blanked), so prose that merely mentions a forbidden pattern can
 * neither fail a scan nor hide a real violation. The scanners themselves are
 * self-tested below against known-good and known-bad snippets, so a regex that
 * silently stops matching cannot turn these scans into permanent passes.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

// ---------------------------------------------------------------------------
// Source readers
// ---------------------------------------------------------------------------

/** One left-to-right pass, so a "//" inside a string is never mistaken for a
 * comment and a quote inside a comment never opens a string. */
const TOKEN_RE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** Removes comments; string literals are kept verbatim. */
function stripComments(src: string): string {
  return src.replace(TOKEN_RE, (token) => (token.startsWith("/") ? "" : token));
}

/** Removes comments AND blanks string literals (`"abc"` becomes `""`), for
 * scans that must only ever look at executable code. */
function stripCommentsAndStrings(src: string): string {
  return src.replace(TOKEN_RE, (token) => (token.startsWith("/") ? "" : '""'));
}

function readRaw(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf-8");
}

const SKIPPED_DIRS = new Set(["node_modules", ".next", "generated", "__tests__"]);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

/** Every .ts/.tsx file under `relativeDir`, tests and build output excluded.
 * Returned paths use forward slashes so comparisons work on Windows too. */
function listSourceFiles(relativeDir: string): string[] {
  const results: string[] = [];
  const walk = (dirAbs: string, dirRel: string) => {
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      const rel = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dirAbs, entry.name), rel);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
        results.push(rel);
      }
    }
  };
  const abs = path.join(rootDir, relativeDir);
  expect(fs.existsSync(abs), `${relativeDir} must exist`).toBe(true);
  walk(abs, relativeDir);
  return results;
}

// ---------------------------------------------------------------------------
// Scanners (pure; self-tested at the bottom)
// ---------------------------------------------------------------------------

/** Any spelling of the half-quantity-step constant. Boundaries stop it from
 * matching inside longer numbers such as 10.000050 or 15e-5. */
const TOLERANCE_LITERAL_RES: RegExp[] = [
  /(?<![\w.])0?\.00005(?!\d)/,
  /(?<![\w.])5e-0?5(?![\w.])/i,
  /(?<![\w.])0?\.5e-0?4(?![\w.])/i,
  /(?<![\w.])1\s*\/\s*20000(?!\d)/,
];

function findToleranceLiteral(code: string): string | null {
  for (const re of TOLERANCE_LITERAL_RES) {
    const match = code.match(re);
    if (match) return match[0];
  }
  return null;
}

/** Native arithmetic on an identifier called `quantity` (item.quantity,
 * line.quantity, a bare `quantity`, ...). Run on comment- and string-free code. */
const NATIVE_QUANTITY_ARITHMETIC_RE = /\bquantity\s*(?:\+=?|-=?|\*=?|\/=?)(?!\s*[>])/;

/** compareMoney(<something>.conversionFactor, "1") in any spacing. Run on code
 * with comments removed but strings KEPT (the "1" is the point). */
const FACTOR_VS_ONE_RE =
  /compareMoney\(\s*[\w.?]*conversionFactor\s*,\s*(?:"1"|'1'|"1\.0+"|'1\.0+')\s*\)/g;

/** Object-literal key or assignment that WRITES lineTotalOverrideSYP.
 * Reads such as `x.lineTotalOverrideSYP === undefined` and type annotations
 * such as `lineTotalOverrideSYP?: string` deliberately do not match. */
const OVERRIDE_WRITE_RES: RegExp[] = [
  /\blineTotalOverrideSYP\s*:(?!:)/, //          { lineTotalOverrideSYP: x }
  /\.lineTotalOverrideSYP\s*(?<![=!<>])=(?!=)/, // line.lineTotalOverrideSYP = x
  /\[\s*["']lineTotalOverrideSYP["']\s*\]\s*(?<![=!<>])=(?!=)/, // line["lineTotalOverrideSYP"] = x
];

function findOverrideWrite(code: string): string | null {
  for (const re of OVERRIDE_WRITE_RES) {
    const match = code.match(re);
    if (match) return match[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. The tolerance rule is defined once
// ---------------------------------------------------------------------------

describe("tolerance single-definition scan", () => {
  it("money.ts defines QUANTITY_HALF_STEP exactly once, with the only 0.00005 literal", () => {
    const code = stripComments(readRaw("lib/utils/money.ts"));
    expect((code.match(/export const QUANTITY_HALF_STEP\b/g) ?? []).length).toBe(1);
    expect((code.match(/(?<![\w.])0?\.00005(?!\d)/g) ?? []).length).toBe(1);
  });

  it("no second tolerance literal anywhere under app/, lib/ or components/ (money.ts and tests excluded)", () => {
    const files = [
      ...listSourceFiles("app"),
      ...listSourceFiles("lib"),
      ...listSourceFiles("components"),
    ].filter((rel) => rel !== "lib/utils/money.ts");

    // Guard against a walker that silently finds nothing.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("lib/offline/pos-service.ts");
    expect(files).toContain("app/api/sync/route.ts");

    const offenders: string[] = [];
    for (const rel of files) {
      const hit = findToleranceLiteral(stripComments(readRaw(rel)));
      if (hit) offenders.push(`${rel} contains ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. pos-service.ts: no native quantity arithmetic, one factor-vs-1 check
// ---------------------------------------------------------------------------

describe("pos-service.ts discipline", () => {
  const raw = readRaw("lib/offline/pos-service.ts");

  it("never does native arithmetic on `quantity`", () => {
    const code = stripCommentsAndStrings(raw);
    const lines = code
      .split("\n")
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => NATIVE_QUANTITY_ARITHMETIC_RE.test(text))
      .map(({ text, line }) => `line ${line}: ${text.trim()}`);
    expect(lines).toEqual([]);
  });

  it("isBaseUnitLine is the ONLY compareMoney(conversionFactor, \"1\") in the file", () => {
    const code = stripComments(raw);
    const matches = code.match(FACTOR_VS_ONE_RE) ?? [];
    expect(matches).toHaveLength(1);

    // ...and that one match is inside isBaseUnitLine itself.
    const start = code.indexOf("export function isBaseUnitLine");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("\n}", start);
    expect(code.slice(start, end)).toMatch(FACTOR_VS_ONE_RE);
  });
});

// ---------------------------------------------------------------------------
// 4. Components never write the override
// ---------------------------------------------------------------------------

describe("components/pos/** never write lineTotalOverrideSYP", () => {
  it("only the pos-service funnel writes it", () => {
    const files = listSourceFiles("components/pos");
    expect(files.length).toBeGreaterThan(3);
    expect(files).toContain("components/pos/pos-layout.tsx");
    expect(files).toContain("components/pos/cart-panel.tsx");

    const offenders: string[] = [];
    for (const rel of files) {
      const hit = findOverrideWrite(stripCommentsAndStrings(readRaw(rel)));
      if (hit) offenders.push(`${rel} writes ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scanner self-tests: the scans above are only worth anything if these hold.
// ---------------------------------------------------------------------------

describe("scanner self-tests", () => {
  it("strips comments without mistaking a URL string for one", () => {
    const src = 'const a = 1; // quantity + 1\nconst u = "https://x.y/z"; /* 0.00005 */';
    expect(stripComments(src)).not.toContain("quantity + 1");
    expect(stripComments(src)).not.toContain("0.00005");
    expect(stripComments(src)).toContain('"https://x.y/z"');
    expect(stripCommentsAndStrings(src)).not.toContain("https");
  });

  it("tolerance literal: catches every spelling, ignores look-alikes", () => {
    for (const bad of [
      "const t = 0.00005;",
      'const t = "0.00005";',
      "const t = .00005;",
      "const t = 5e-5;",
      "const t = 5E-05;",
      "const t = 0.5e-4;",
      "const t = 1 / 20000;",
    ]) {
      expect(findToleranceLiteral(bad), bad).not.toBeNull();
    }
    for (const good of ["const t = 15e-5;", "const t = 0.000051;", "const t = 10.00005;", "x = 120000;"]) {
      expect(findToleranceLiteral(good), good).toBeNull();
    }
  });

  it("native quantity arithmetic: catches + - * / and compound forms, ignores everything else", () => {
    for (const bad of [
      "const n = item.quantity + 1;",
      "const n = quantity - delta;",
      "const n = line.quantity * factor;",
      "const n = line.quantity / 2;",
      "quantity += 1;",
      "total -= quantity -1;",
    ]) {
      expect(NATIVE_QUANTITY_ARITHMETIC_RE.test(bad), bad).toBe(true);
    }
    for (const good of [
      "quantity: number;",
      "quantity: Number(quantity),",
      "{ ...i, quantity: newQuantity }",
      "if (quantity <= 0) return;",
      "const q = Number(addMoney(item.quantity, 1));",
      "const parts = quantity ? 1 : 2;",
    ]) {
      expect(NATIVE_QUANTITY_ARITHMETIC_RE.test(good), good).toBe(false);
    }
  });

  it("factor-vs-1: catches the compareMoney form only", () => {
    expect('compareMoney(item.conversionFactor, "1") === 0'.match(FACTOR_VS_ONE_RE)).toHaveLength(1);
    expect("compareMoney( cachedUnit.conversionFactor , '1' ) !== 0".match(FACTOR_VS_ONE_RE)).toHaveLength(1);
    expect('compareMoney(item.unitPriceSYP, "1")'.match(FACTOR_VS_ONE_RE)).toBeNull();
    expect("compareMoney(item.lineTotalOverrideSYP, 0) <= 0".match(FACTOR_VS_ONE_RE)).toBeNull();
  });

  it("override writes: catches key and assignment forms, ignores reads and types", () => {
    for (const bad of [
      '{ ...i, lineTotalOverrideSYP: "5000.0000" }',
      "{ lineTotalOverrideSYP: amount }",
      'line.lineTotalOverrideSYP = "5000"',
      'line["lineTotalOverrideSYP"] = "5000"',
    ]) {
      expect(findOverrideWrite(bad), bad).not.toBeNull();
    }
    for (const good of [
      "if (item.lineTotalOverrideSYP === undefined) return;",
      "if (item.lineTotalOverrideSYP !== undefined) show();",
      "const mode = item.lineTotalOverrideSYP ? 1 : 2;",
      "lineTotalOverrideSYP?: string;",
      "formatMoney(item.lineTotalOverrideSYP)",
    ]) {
      expect(findOverrideWrite(good), good).toBeNull();
    }
  });
});