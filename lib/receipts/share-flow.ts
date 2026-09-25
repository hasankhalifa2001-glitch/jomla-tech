/**
 * lib/receipts/share-flow.ts
 *
 * T4f addendum — Rules 1 and 3, as an ORDER OF OPERATIONS that can be asserted
 * in a test rather than merely described in a comment.
 *
 * [THE PROBLEM THIS FILE SOLVES] Rule 1's third acceptance criterion is
 * negative: "No client-generated temporary PDF is ever produced for an
 * unsynced invoice — verified by confirming no PDF-generation call fires while
 * status !== SYNCED." A negative property cannot be verified by reading a
 * component's JSX, and this repo's test environment is `environment: "node"`
 * (vitest.config.ts) with no jsdom, so it cannot render one either.
 *
 * So the sequence lives here, as a plain async function over INJECTED ports,
 * and the component that renders the buttons becomes a thin adapter that
 * supplies real implementations. A test then supplies spies and asserts the
 * negative directly: renderRaster was NOT called, cacheRaster was NOT called,
 * deliverPdf was NOT called — for every status except "SYNCED". That is the
 * same "pure decision + thin component" division this codebase already uses
 * for the void surfaces (lib/offline/pos-service.ts's canVoidOfflineInvoice /
 * shouldShowOfflineVoidPanel feed components/pos/offline-void-panel.tsx).
 *
 * [PRECISE VOCABULARY, BECAUSE THE SPEC RULE IS PRECISE] The client never
 * GENERATES or CACHES a PDF. It renders a PNG RASTER (the browser is the only
 * thing that shapes Arabic correctly — see lib/receipts/pdf.ts's header), posts
 * those pixels, and the SERVER produces and caches exactly one PDF keyed off
 * Invoice.receiptPdfUrl (Rule 3). So "PDF generation" on this side means
 * `renderRaster`, and "temporary PDF" means a raster that was rendered and then
 * never referenced by the invoice. The ordering below is what makes the second
 * thing impossible: renderRaster() is unreachable until the gate has passed AND
 * the server has confirmed the row has no URL yet.
 *
 * [THE GATE IS CHECKED FIRST, BEFORE resolveTarget()] Deliberately: resolveTarget()
 * is the network call (GET /api/invoices/by-offline-id), so checking the gate
 * afterwards would mean an unsynced invoice still issued a request. Rule 1 says
 * share is gated on sync state, so an unsynced invoice must do NOTHING — not
 * "fail safely after trying".
 */

import { canShareReceipt, SHARE_SYNC_INCOMPLETE_MESSAGE } from "./share-gate";
import type { ShareGateInput } from "./share-gate";

/** Arabic explanation for "the local row says SYNCED but the server has no row yet". */
export const SHARE_TARGET_UNRESOLVED_MESSAGE =
  "لم يتم العثور على الفاتورة على السيرفر بعد — أعد المحاولة بعد اكتمال المزامنة.";

export const SHARE_FAILED_MESSAGE = "تعذّر إنشاء ملف الإيصال. حاول مرة أخرى.";

/** The server-side identity + caching state of one invoice. */
export interface ShareTarget {
  serverInvoiceId: string;
  /** Invoice.receiptPdfUrl — null until the FIRST share has been cached. */
  receiptPdfUrl: string | null;
}

export interface ShareFlowPorts {
  /**
   * The invoice's sync state. Rules 1 and 2: this is the live Dexie status for
   * a device-local invoice, and "SYNCED" for an invoice that arrived over
   * GET /api/invoices/[id] (already on the server by construction).
   */
  getSyncStatus(): ShareGateInput["status"] | Promise<ShareGateInput["status"]>;

  /** Resolves the server row (and its cached URL). null when it does not exist yet. */
  resolveTarget(): Promise<ShareTarget | null>;

  /** The browser half: model -> PNG raster. The only DOM-bound step. */
  renderRaster(): Promise<Blob>;

  /** POSTs the raster; the server wraps, uploads, and conditionally claims the URL. */
  cacheRaster(serverInvoiceId: string, raster: Blob): Promise<string>;

  /** Hands the (now guaranteed to exist) PDF to the user. */
  deliverPdf(url: string): void;
}

export type ShareFlowResult =
  /** Refused before any render or request. `messageAr` is shown on the disabled control. */
  | { kind: "blocked"; messageAr: string }
  /** The invoice already had a cached URL: served as-is, nothing rendered, nothing posted. */
  | { kind: "reused"; url: string }
  /** This call is the one that produced and cached the artifact. */
  | { kind: "generated"; url: string };

/**
 * The single share sequence. Never throws for an expected refusal — a blocked
 * share is a normal, explainable outcome (Rule 1), so it is a returned value
 * the UI can render rather than an exception it must catch.
 */
export async function runShareReceiptFlow(ports: ShareFlowPorts): Promise<ShareFlowResult> {
  // ---- STEP 1: the gate. No render, no network below this line until it passes.
  const status = await ports.getSyncStatus();
  const gate = canShareReceipt({ status });
  if (!gate.allowed) {
    return {
      kind: "blocked",
      messageAr: gate.reasonAr ?? SHARE_SYNC_INCOMPLETE_MESSAGE,
    };
  }

  // ---- STEP 2: the server row must exist before a PDF can be keyed off it.
  const target = await ports.resolveTarget();
  if (!target) {
    return { kind: "blocked", messageAr: SHARE_TARGET_UNRESOLVED_MESSAGE };
  }

  // ---- STEP 3: reuse, exactly as originally scoped ("subsequent shares reuse it").
  // This is also Rule 3's "third, later share request ... with no new generation
  // call": the route's own fast path short-circuits server-side, and this branch
  // short-circuits client-side, so a cached invoice renders nothing at all.
  if (target.receiptPdfUrl) {
    ports.deliverPdf(target.receiptPdfUrl);
    return { kind: "reused", url: target.receiptPdfUrl };
  }

  // ---- STEP 4: first share — render, post, deliver. Win or lose the race,
  // the URL returned is the one the invoice now points at (see
  // lib/data/receipts.ts's cacheReceiptPdfOnce for the losing branch).
  const raster = await ports.renderRaster();
  const url = await ports.cacheRaster(target.serverInvoiceId, raster);
  ports.deliverPdf(url);
  return { kind: "generated", url };
}
