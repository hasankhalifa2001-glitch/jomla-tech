/**
 * T4f addendum — Rules 1, 2 and 5: ONE receipt model, two sources, one gate.
 *
 *   COVERAGE → ACCEPTANCE CRITERIA
 *   Rule 1 (print vs share, split by data-readiness)
 *     a. A PENDING (never-synced) invoice prints from the local row alone, and
 *        the print path's module graph performs NO network I/O — asserted both
 *        by source scan and by the absence of any fetch in the handler body.
 *     b. Share is refused for PENDING / FAILED / unknown status, and for a
 *        refusal renderRaster / cacheRaster / deliverPdf are NEVER called — the
 *        literal "no PDF-generation call fires while status !== SYNCED".
 *     c. Share becomes available the moment the status is SYNCED, reusing a
 *        cached URL with no rendering at all.
 *     d. The refusal message has exactly one source (share-gate.ts) and the
 *        control is DISABLED, not hidden.
 *   Rule 2 (offline voids)
 *     e. A locally-queued void (voidsOfflineInvoiceId set) reaches the same VOID
 *        branch as a server VOIDED invoice: void notice, void reason, restored
 *        units, and totals at the ORIGINAL sale's exchangeRateUsed.
 *   Rule 5 (negative quantities)
 *     f. A stored "-3" renders as "مرتجع: 3 <unit>" on both the 576- and
 *        384-dot layouts, and no customer-visible string ever shows a bare minus
 *        before a digit.
 *
 * FIXTURE NOTE: the offlineIds below are deliberately HYPHEN-FREE. A real
 * offlineId is a UUID (lib/offline/id.ts) and the receipt prints it as
 * "المرجع: <uuid>", whose own hyphens would collide with a naive "no minus sign"
 * scan. Keeping the fixture ids hyphen-free lets the minus sweep below cover
 * EVERY string the receipt renders, with no exclusions to hide a real failure in.
 */

import fs from "fs";
import path from "path";
import { describe, it, expect, vi } from "vitest";

import type { OfflineInvoice } from "@/lib/offline/db";
import { formatMoney } from "@/lib/utils/money";
import {
  buildReceiptModel,
  receiptModelStrings,
  type LocalReceiptSource,
  type ServerReceiptSource,
} from "@/lib/receipts/receipt-model";
import { layoutReceipt } from "@/lib/receipts/receipt-layout";
import {
  LOCAL_ONLY_NOTICE,
  RETURN_LABEL,
  SALE_DOCUMENT_LABEL,
  VOID_DOCUMENT_LABEL,
  VOID_TOTAL_LABEL,
  formatQuantityLabel,
} from "@/lib/receipts/receipt-lines";
import {
  SHARE_SYNC_INCOMPLETE_MESSAGE,
  canShareReceipt,
} from "@/lib/receipts/share-gate";
import {
  SHARE_TARGET_UNRESOLVED_MESSAGE,
  runShareReceiptFlow,
  type ShareFlowPorts,
  type ShareTarget,
} from "@/lib/receipts/share-flow";

const rootDir = process.cwd();

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const TENANT_ID = "tenant-t4f";
const CUSTOMER_NAME = "سوبرماركت الأمانة";
const EXCHANGE_RATE = "15000.0000";

const ITEM_NAMES = {
  productNames: { "prod-oil": "زيت دوار الشمس" },
  unitNames: { "unit-carton": "طرد" },
};

/** A brand-new, never-synced sale — status PENDING, no server row anywhere. */
function pendingSale(overrides: Partial<OfflineInvoice> = {}): OfflineInvoice {
  return {
    tenantId: TENANT_ID,
    offlineId: "pendingSaleOne",
    items: [
      {
        productId: "prod-oil",
        unitId: "unit-carton",
        quantity: "3.0000",
        unitPriceSYP: "50000.0000",
        unitPriceUSD: "3.3333",
      },
    ],
    totalSYP: "150000.0000",
    totalUSD: "10.0000",
    exchangeRateUsed: EXCHANGE_RATE,
    paidAmountSYP: "150000.0000",
    paidAmountUSD: "10.0000",
    debtAmountSYP: "0.0000",
    debtAmountUSD: "0.0000",
    paymentMethod: "CASH",
    createdAt: new Date("2026-09-25T10:15:00.000Z"),
    status: "PENDING",
    ...overrides,
  };
}

/** The local void written by submitOfflineVoid(): negated quantities and money. */
function localVoid(): OfflineInvoice {
  return {
    tenantId: TENANT_ID,
    offlineId: "localVoidOne",
    voidsOfflineInvoiceId: "pendingSaleOne",
    voidReason: "إرجاع كامل من الزبون",
    items: [
      {
        productId: "prod-oil",
        unitId: "unit-carton",
        quantity: "-3.0000",
        unitPriceSYP: "50000.0000",
        unitPriceUSD: "3.3333",
      },
    ],
    totalSYP: "-150000.0000",
    totalUSD: "-10.0000",
    exchangeRateUsed: EXCHANGE_RATE,
    paidAmountSYP: "-150000.0000",
    paidAmountUSD: "-10.0000",
    debtAmountSYP: "0.0000",
    debtAmountUSD: "0.0000",
    createdAt: new Date("2026-09-25T11:00:00.000Z"),
    status: "PENDING",
  };
}

function localSource(invoice: OfflineInvoice): LocalReceiptSource {
  return { source: "local", invoice, customerName: CUSTOMER_NAME, itemNames: ITEM_NAMES };
}

const STUB_MEASURE = (text: string) => text.length * 8;

/** Every string the receipt renders, in order — the minus sweep's target. */
function renderedStrings(model: ReturnType<typeof buildReceiptModel>): string[] {
  return receiptModelStrings(model);
}

const SERVER_VOID_DETAIL = {
  id: "srvvoidone",
  createdAt: "2026-09-25T11:00:00.000Z",
  status: "VOIDED" as const,
  voidsInvoiceId: "srvsaleone",
  voidReason: "إرجاع كامل من الزبون",
  totalSYP: "-150000.0000",
  totalUSD: "-10.0000",
  paidAmountSYP: "-150000.0000",
  paidAmountUSD: "-10.0000",
  debtAmountSYP: "0.0000",
  debtAmountUSD: "0.0000",
  exchangeRateUsed: EXCHANGE_RATE,
  customer: { name: CUSTOMER_NAME },
  items: [
    {
      productName: "زيت دوار الشمس",
      unitName: "طرد",
      quantity: "-3.0000",
      unitPriceSYP: "50000.0000",
      unitPriceUSD: "3.3333",
    },
  ],
};

describe("Rule 1(a) — a PENDING invoice prints entirely from the local row", () => {
  it("builds a SALE receipt from the Dexie row, flagged as not-yet-synced", () => {
    const model = buildReceiptModel(localSource(pendingSale()));

    expect(model.kind).toBe("SALE");
    expect(model.isSynced).toBe(false);
    expect(model.reference).toBe("pendingSaleOne");
    expect(model.customerName).toBe(CUSTOMER_NAME);

    const strings = renderedStrings(model);
    expect(strings).toContain(SALE_DOCUMENT_LABEL);
    // The "saved on this device only" notice T4b already uses for this state.
    expect(strings).toContain(LOCAL_ONLY_NOTICE);
  });

  it("renders no local-only notice once the row is SYNCED", () => {
    const model = buildReceiptModel(localSource(pendingSale({ status: "SYNCED" })));
    expect(model.isSynced).toBe(true);
    expect(renderedStrings(model)).not.toContain(LOCAL_ONLY_NOTICE);
  });

  it("the print path's module graph performs no network I/O", () => {
    // The whole point of Rule 1's first criterion is that this is a property of
    // the code, not of a runtime flag: there is no fetch on this path to skip.
    for (const file of [
      "lib/receipts/receipt-model.ts",
      "lib/receipts/receipt-lines.ts",
      "lib/receipts/receipt-layout.ts",
      "lib/receipts/escpos.ts",
      "lib/receipts/local-receipt-source.ts",
    ]) {
      const code = stripComments(readSource(file));
      expect(code, `${file} must not call fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${file} must not use XMLHttpRequest`).not.toContain("XMLHttpRequest");
      expect(code, `${file} must not import an HTTP client`).not.toMatch(
        /from\s+["'](axios|node-fetch)["']/
      );
    }
  });

  it("the thermal handler reaches no network and resolves the width before pairing", () => {
    // Comments stripped: the handler DOCUMENTS that it carries no receiptPdfUrl,
    // and that documentation must not count as a reference to one.
    const source = stripComments(readSource("components/receipts/receipt-actions.tsx"));
    const start = source.indexOf("async function handleThermalPrint");
    expect(start).toBeGreaterThan(-1);

    const body = source.slice(start, source.indexOf("async function handleShare", start));

    // Rule 1: zero network calls on the thermal path, and no dependency on the
    // server-side PDF cache.
    expect(body).not.toMatch(/\bfetch\s*\(/);
    expect(body).not.toContain("receiptPdfUrl");

    // Rule 4's order: the CONFIRMED width is resolved first, then the raster is
    // built at exactly that width, then re-asserted, then bytes are sent.
    const iConfig = body.indexOf("readPrinterConfig(");
    const iWidth = body.indexOf("resolvePrintableWidth(");
    const iRaster = body.indexOf("rasterizeReceipt(");
    const iAssert = body.indexOf("assertRasterMatchesConfiguredWidth(");
    const iPair = body.indexOf("ensurePairedPrinter(");
    const iWrite = body.indexOf("printEscPosBytes(");

    expect(iConfig).toBeGreaterThan(-1);
    expect(iConfig).toBeLessThan(iWidth);
    expect(iWidth).toBeLessThan(iRaster);
    expect(iRaster).toBeLessThan(iAssert);
    expect(iAssert).toBeLessThan(iPair);
    expect(iPair).toBeLessThan(iWrite);
  });
});

describe("Rules 2 + 5 — void receipts, local and server, at both widths", () => {
  it("Rule 2: a locally-queued void reaches the same VOID treatment as a server void", () => {
    const localModel = buildReceiptModel(localSource(localVoid()));
    const serverModel = buildReceiptModel({
      source: "server",
      detail: SERVER_VOID_DETAIL,
    } as ServerReceiptSource);

    expect(localModel.kind).toBe("VOID");
    expect(serverModel.kind).toBe("VOID");

    for (const model of [localModel, serverModel]) {
      const strings = renderedStrings(model);
      const joined = strings.join("\n");

      expect(strings).toContain(VOID_DOCUMENT_LABEL);
      expect(strings).toContain(VOID_TOTAL_LABEL);
      expect(joined).toContain("إرجاع كامل من الزبون");
      // The void shows the rate frozen on the ORIGINAL sale (carried by the void
      // row itself), never a freshly re-derived one. Compared through the SAME
      // formatter the model uses, because money renders in the locale's own
      // digits (ar-SY → Arabic-Indic numerals), not ASCII.
      expect(joined).toContain(formatMoney(EXCHANGE_RATE, "SYP"));
    }
  });

  it("Rule 5: formatQuantityLabel turns a stored negative into an explicit return", () => {
    expect(formatQuantityLabel("-3.0000", "طرد")).toBe(`${RETURN_LABEL}: 3 طرد`);
    expect(formatQuantityLabel("3.0000", "طرد")).toBe("3 طرد");
    // A fractional (weighed) return keeps its decimals, and still carries no sign.
    expect(formatQuantityLabel("-1.7500", "كغ")).toBe(`${RETURN_LABEL}: 1.75 كغ`);
  });

  it("Rule 5: a reversed line renders as مرتجع with the ABSOLUTE quantity, flagged isReturn", () => {
    const model = buildReceiptModel(localSource(localVoid()));
    const reversed = model.blocks.find((block) => block.type === "item");

    expect(reversed).toBeDefined();
    if (reversed?.type !== "item") throw new Error("expected an item block");

    expect(reversed.isReturn).toBe(true);
    expect(reversed.detail).toContain(`${RETURN_LABEL}: 3 طرد`);
    expect(reversed.detail).not.toContain("-3");
    expect(reversed.total).not.toMatch(/-\s?\d/);
  });

  it("Rule 5: no customer-visible string shows a minus before a digit", () => {
    for (const model of [
      buildReceiptModel(localSource(localVoid())),
      buildReceiptModel({ source: "server", detail: SERVER_VOID_DETAIL } as ServerReceiptSource),
    ]) {
      for (const text of renderedStrings(model)) {
        expect(text, `"${text}" must not show a bare minus sign`).not.toMatch(/-\s?\d/);
      }
    }
  });

  it("Rules 4/5: lays out at BOTH configured widths with the return label intact", () => {
    const localVoidModel = buildReceiptModel(localSource(localVoid()));
    const serverVoidModel = buildReceiptModel({
      source: "server",
      detail: SERVER_VOID_DETAIL,
    } as ServerReceiptSource);

    for (const widthPx of [576, 384]) {
      for (const model of [localVoidModel, serverVoidModel]) {
        // layoutReceipt() throws on any overflow, so a successful call IS the
        // width invariant holding at this width.
        const layout = layoutReceipt(model, { widthPx, measure: STUB_MEASURE });
        expect(layout.widthPx).toBe(widthPx);

        const texts = layout.ops
          .filter((op) => op.kind === "text")
          .map((op) => op.text);

        expect(texts.join("\n"), `width ${widthPx}`).toContain(`${RETURN_LABEL}: 3 طرد`);
        for (const text of texts) {
          expect(text, `width ${widthPx}: "${text}"`).not.toMatch(/-\s?\d/);
        }

        // The reversed line is also visually flagged for the renderer.
        const returnOps = layout.ops.filter(
          (op) => op.kind === "text" && op.isReturn
        );
        expect(returnOps.length, `width ${widthPx}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("Rule 1(b,c,d) — share is gated on sync state, and only then touches anything", () => {
  function makePorts(params: { status: unknown; target: ShareTarget | null }) {
    const getSyncStatus = vi.fn(() => params.status as never);
    const resolveTarget = vi.fn(async () => params.target);
    const renderRaster = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])]));
    const cacheRaster = vi.fn(async () => "https://cdn.example/receipt.pdf");
    const deliverPdf = vi.fn();

    const ports: ShareFlowPorts = {
      getSyncStatus,
      resolveTarget,
      renderRaster,
      cacheRaster,
      deliverPdf,
    };

    return { ports, getSyncStatus, resolveTarget, renderRaster, cacheRaster, deliverPdf };
  }

  it("canShareReceipt is true for SYNCED and false for everything else (fail-safe on unknown)", () => {
    expect(canShareReceipt({ status: "SYNCED" })).toEqual({ allowed: true, reasonAr: null });

    for (const status of ["PENDING", "FAILED", null, undefined] as const) {
      expect(canShareReceipt({ status })).toEqual({
        allowed: false,
        reasonAr: SHARE_SYNC_INCOMPLETE_MESSAGE,
      });
    }
  });

  it("an unsynced invoice renders NOTHING and requests NOTHING", async () => {
    // Rule 1's third acceptance criterion, stated as a test: no PDF-generation
    // call (renderRaster) and no upload (cacheRaster) may fire while
    // status !== SYNCED — and, because the gate is checked before the target is
    // resolved, no request is issued either.
    for (const status of ["PENDING", "FAILED", null, undefined] as const) {
      const { ports, resolveTarget, renderRaster, cacheRaster, deliverPdf } = makePorts({
        status,
        target: { serverInvoiceId: "invoice-1", receiptPdfUrl: null },
      });

      const result = await runShareReceiptFlow(ports);

      expect(result).toEqual({ kind: "blocked", messageAr: SHARE_SYNC_INCOMPLETE_MESSAGE });
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(renderRaster).not.toHaveBeenCalled();
      expect(cacheRaster).not.toHaveBeenCalled();
      expect(deliverPdf).not.toHaveBeenCalled();
    }
  });

  it("a SYNCED invoice with a cached URL reuses it — no rendering, no upload", async () => {
    const { ports, renderRaster, cacheRaster, deliverPdf } = makePorts({
      status: "SYNCED",
      target: { serverInvoiceId: "invoice-1", receiptPdfUrl: "https://cdn.example/cached.pdf" },
    });

    const result = await runShareReceiptFlow(ports);

    expect(result).toEqual({ kind: "reused", url: "https://cdn.example/cached.pdf" });
    expect(renderRaster).not.toHaveBeenCalled();
    expect(cacheRaster).not.toHaveBeenCalled();
    expect(deliverPdf).toHaveBeenCalledWith("https://cdn.example/cached.pdf");
  });

  it("a SYNCED invoice's FIRST share renders once, uploads once, and serves the server's URL", async () => {
    const { ports, renderRaster, cacheRaster, deliverPdf } = makePorts({
      status: "SYNCED",
      target: { serverInvoiceId: "invoice-1", receiptPdfUrl: null },
    });

    const result = await runShareReceiptFlow(ports);

    expect(result).toEqual({ kind: "generated", url: "https://cdn.example/receipt.pdf" });
    expect(renderRaster).toHaveBeenCalledTimes(1);
    expect(cacheRaster).toHaveBeenCalledTimes(1);
    expect(cacheRaster).toHaveBeenCalledWith("invoice-1", expect.any(Blob));
    expect(deliverPdf).toHaveBeenCalledWith("https://cdn.example/receipt.pdf");
  });

  it("SYNCED but with no server row yet: blocked, and still nothing rendered", async () => {
    const { ports, renderRaster, cacheRaster, deliverPdf } = makePorts({
      status: "SYNCED",
      target: null,
    });

    const result = await runShareReceiptFlow(ports);

    expect(result).toEqual({ kind: "blocked", messageAr: SHARE_TARGET_UNRESOLVED_MESSAGE });
    expect(renderRaster).not.toHaveBeenCalled();
    expect(cacheRaster).not.toHaveBeenCalled();
    expect(deliverPdf).not.toHaveBeenCalled();
  });

  it("accepts an async sync-status port (the live Dexie query shape)", async () => {
    const { ports, renderRaster } = makePorts({
      status: Promise.resolve("PENDING"),
      target: { serverInvoiceId: "invoice-1", receiptPdfUrl: null },
    });

    const result = await runShareReceiptFlow(ports);

    expect(result.kind).toBe("blocked");
    expect(renderRaster).not.toHaveBeenCalled();
  });

  it("the gate is checked, and the target resolved, BEFORE any raster work (source order)", () => {
    const code = readSource("lib/receipts/share-flow.ts");

    const iGate = code.indexOf("canShareReceipt(");
    const iTarget = code.indexOf("await ports.resolveTarget()");
    const iRender = code.indexOf("await ports.renderRaster()");

    expect(iGate).toBeGreaterThan(-1);
    expect(iTarget).toBeGreaterThan(-1);
    expect(iRender).toBeGreaterThan(-1);
    expect(iGate).toBeLessThan(iTarget);
    expect(iTarget).toBeLessThan(iRender);

    // And share-flow.ts itself performs no I/O of its own.
    expect(stripComments(code)).not.toMatch(/\bfetch\s*\(/);
  });

  it("the control is DISABLED, never hidden, with one single source for the Arabic reason", () => {
    const actions = readSource("components/receipts/receipt-actions.tsx");
    // Comments are excluded: the component's header DOCUMENTS the message it
    // must not re-implement, which is exactly the behaviour we want to keep
    // (the doc reference is not a second source of truth — the CODE is).
    const actionsCode = stripComments(actions);

    // Disabled, not conditionally rendered away.
    expect(actionsCode).toContain("disabled={!gate.allowed");
    expect(actionsCode).not.toContain("{gate.allowed &&");
    // The message is rendered inline for the cashier (not only inside a toast).
    expect(actionsCode).toContain('role="status"');
    // Live Dexie query → the button enables the instant the row flips to SYNCED.
    expect(actionsCode).toContain("useLocalInvoiceSyncStatus(");

    // The Arabic string has exactly ONE home: it is DEFINED once in
    // share-gate.ts (and merely referenced by name thereafter), and the literal
    // text appears in no other file's code — which is how a label and a toast
    // drift apart.
    const gateSource = readSource("lib/receipts/share-gate.ts");
    expect(gateSource.split("export const SHARE_SYNC_INCOMPLETE_MESSAGE").length - 1).toBe(1);
    expect(gateSource.split(SHARE_SYNC_INCOMPLETE_MESSAGE).length - 1).toBe(1);
    expect(actionsCode).not.toContain(SHARE_SYNC_INCOMPLETE_MESSAGE);
  });
});
