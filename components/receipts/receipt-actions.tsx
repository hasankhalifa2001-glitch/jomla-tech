"use client";

/**
 * components/receipts/receipt-actions.tsx
 *
 * T4f addendum — the print/share control, and the ONLY place Rules 1, 2, 4 and
 * 5 meet the UI. Everything it does is delegated:
 *
 *   - WHAT to print/share → lib/receipts/receipt-model.ts (buildReceiptModel),
 *     fed either a local OfflineInvoice or a server InvoiceDetail. This is what
 *     makes Rule 2 need no special case: a locally-queued void is just a local
 *     invoice with voidsOfflineInvoiceId set, so it reaches the same VOID branch.
 *   - WHETHER share is allowed → lib/receipts/share-flow.ts + share-gate.ts.
 *   - At what WIDTH → lib/receipts/printer-config.ts (Rule 4; it throws rather
 *     than guessing).
 *   - Whether the bitmap FITS that width → escpos.ts's
 *     assertRasterMatchesConfiguredWidth, immediately before any byte is written.
 *
 * There is deliberately no `if (status === "SYNCED")` in this file for the share
 * path: the decision belongs to share-flow.ts, and this component only renders
 * its verdict. That keeps "share is disabled, not hidden, with the Arabic
 * explanation" a property of a tested function rather than of JSX.
 *
 * [DISABLED, NOT HIDDEN — Rule 1's exact wording] The share button is always in
 * the DOM. When the gate refuses, it is `disabled` with shareGateMessage()
 * rendered beside it, so a cashier sees WHY (\"شارك بعد اكتمال المزامنة\") instead
 * of a control that silently is not there. That string has exactly one source
 * (share-gate.ts) so the inline label and the toast cannot drift.
 *
 * [LIVE-ENABLE WITHOUT A RELOAD — Rule 1's other half] The gate's input is
 * useLocalInvoiceSyncStatus(offlineId), a Dexie live query. When
 * lib/offline/sync-worker.ts flips the row to SYNCED, that query re-runs and
 * this component re-renders enabled — no polling, no refetch callback, nothing
 * to forget to call.
 *
 * [PRINT NEEDS NO SERVER ROW] The print handler touches the network zero times:
 * printer config (Dexie), model (pure), canvas (local), Bluetooth (local). It
 * works for status PENDING, FAILED and SYNCED, and for a local void record
 * alike. Do not add a fetch here — Rule 1's first acceptance criterion is
 * precisely that there is none.
 *
 * [FIX — serverInvoiceId now actually used] `share-gate.ts`'s own header
 * documents the intent explicitly: "[serverInvoiceId] is carried here only so
 * the caller can decide whether it must resolve the id before acting". Before
 * this fix, the device-local branch of `resolveTarget` ignored the prop
 * entirely and always issued a GET /api/invoices/by-offline-id — even when the
 * caller (e.g. pos-layout, once OfflineInvoice.serverId is known post-sync)
 * already had the id in hand. Now, when `serverInvoiceId` is supplied, we skip
 * that round-trip and build the ShareTarget directly.
 *
 * We deliberately do NOT also fetch a cached receiptPdfUrl for this fast path.
 * We pass `receiptPdfUrl: null`, which tells share-flow.ts "treat this as if no
 * PDF is cached yet". This is SAFE, not merely convenient: the server-side
 * write in lib/data/receipts.ts's cacheReceiptPdfOnce() is a conditional
 * UPDATE ... WHERE receiptPdfUrl IS NULL — if a PDF was in fact already cached
 * (e.g. shared earlier from another device/tab), that UPDATE simply loses the
 * race (count === 0), and cacheReceiptPdfOnce() re-reads and returns the
 * existing URL instead. So the worst case here is one redundant raster
 * render + upload attempt on an already-shared invoice, never a wrong or
 * duplicated artifact. This keeps the fast path to zero extra requests instead
 * of adding a second lightweight "does this invoice already have a PDF"
 * lookup, at the cost of that rare redundant upload.
 */

import { useState } from "react";
import { Loader2, Printer, Share2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { renderReceiptPngBlob, rasterizeReceipt } from "@/components/receipts/receipt-canvas";
import { buildReceiptModel, type ReceiptSource } from "@/lib/receipts/receipt-model";
import { assertRasterMatchesConfiguredWidth, buildRasterCommands } from "@/lib/receipts/escpos";
import {
  BLUETOOTH_UNSUPPORTED_MESSAGE,
  isWebBluetoothSupported,
  printEscPosBytes,
} from "@/lib/receipts/bluetooth-printer";
import { ensurePairedPrinter } from "@/lib/receipts/printer-session";
import {
  PRINTER_SETUP_REQUIRED_MESSAGE,
  PrinterNotConfiguredError,
  readPrinterConfig,
  resolvePrintableWidth,
} from "@/lib/receipts/printer-config";
import { canShareReceipt, shareGateMessage } from "@/lib/receipts/share-gate";
import { useLocalInvoiceSyncStatus } from "@/lib/receipts/use-local-invoice-status";
import { runShareReceiptFlow, SHARE_FAILED_MESSAGE, type ShareTarget } from "@/lib/receipts/share-flow";

export interface ReceiptActionsProps {
  /**
   * The authoritative representation of this invoice right now (Rule 1).
   *
   * Accepts a THUNK so a caller that does not have the item NAMES in hand can
   * resolve them at click time instead of on every render. That matters for the
   * offline void panel: an offlineInvoices row stores only productId/unitId, so
   * the panel passes buildLocalReceiptSource() — a Dexie read of the local
   * catalog — which should happen when the cashier actually prints, not on each
   * row's every re-render. The post-checkout fast path passes a plain object,
   * because pos-layout still holds the cart's own names and needs no read at all.
   */
  source: ReceiptSource | (() => Promise<ReceiptSource>);
  /**
   * The local offlineId, when this invoice also has a device-local row. Drives
   * the live sync-status gate, so a POS-side receipt enables its share button
   * the instant its background sync lands.
   */
  offlineId?: string | null;
  /**
   * The server Invoice id when already known (OfflineInvoice.serverId, or
   * detail.id). When set, the share flow's `resolveTarget` uses it directly
   * instead of issuing a GET /api/invoices/by-offline-id lookup — see the
   * [FIX] note above.
   */
  serverInvoiceId?: string | null;
  /** "default" on a modal's action row, "sm" in a dense list row. */
  size?: "sm" | "default";
  className?: string;
  /**
   * Invoked when thermal printing fails because this device has no confirmed
   * printer config. pos-layout opens its printer settings popover, so the user
   * lands on the fix rather than a dead end.
   */
  onPrinterSetupRequired?: () => void;
}

/** A server-sourced invoice is on the server by construction (see share-gate.ts). */
const SERVER_SOURCED_STATUS = "SYNCED" as const;

export function ReceiptActions({
  source,
  offlineId,
  serverInvoiceId,
  size = "default",
  className,
  onPrinterSetupRequired,
}: ReceiptActionsProps) {
  const [busy, setBusy] = useState<"print" | "share" | null>(null);
  const [gateMessage, setGateMessage] = useState<string | null>(null);

  // Hooks cannot be conditional, so this always runs; its answer is only
  // consulted when there is a LOCAL row to ask about (see `status` below).
  const localStatus = useLocalInvoiceSyncStatus(offlineId);
  const status = offlineId ? localStatus.status : SERVER_SOURCED_STATUS;
  const gate = canShareReceipt({ status, serverInvoiceId });
  const gateReason = gate.allowed ? null : shareGateMessage({ status, serverInvoiceId });

  /** Resolves the source — a plain object, or a thunk that reads Dexie. */
  async function currentSource(): Promise<ReceiptSource> {
    return typeof source === "function" ? source() : source;
  }

  async function handleThermalPrint() {
    if (!isWebBluetoothSupported()) {
      // Says why, and points at the browser-print fallback, rather than failing
      // silently — see bluetooth-printer.ts's own note on this.
      toast.error(BLUETOOTH_UNSUPPORTED_MESSAGE);
      return;
    }

    setBusy("print");
    try {
      // Rule 4, in order: the width is this device's CONFIRMED value, or nothing
      // is printed at all. resolvePrintableWidth() throws
      // PrinterNotConfiguredError instead of falling back to a paper-size guess.
      const config = await readPrinterConfig();
      const dotsPerLine = resolvePrintableWidth(config);

      const activeSource = await currentSource();
      const model = buildReceiptModel(activeSource);

      // No fetch, no server row, no receiptPdfUrl anywhere on this path.
      const raster = await rasterizeReceipt(model, { dotsPerLine });

      // The last gate before bytes reach a print head.
      assertRasterMatchesConfiguredWidth(raster, dotsPerLine);

      const handle = await ensurePairedPrinter();
      await printEscPosBytes(handle, buildRasterCommands(raster, { cut: true, feedLines: 6 }));

      toast.success("تم إرسال الإيصال إلى الطابعة الحرارية.");
    } catch (error) {
      if (error instanceof PrinterNotConfiguredError) {
        toast.error(PRINTER_SETUP_REQUIRED_MESSAGE);
        onPrinterSetupRequired?.();
      } else {
        toast.error(
          error instanceof Error ? error.message : "تعذّرت الطباعة الحرارية على هذا الجهاز."
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleShare() {
    setBusy("share");
    setGateMessage(null);
    try {
      const result = await runShareReceiptFlow({
        // The gate reads the live sync state, and share-flow.ts checks it BEFORE
        // anything else — so an unsynced invoice issues no request and renders
        // no raster (Rule 1's third acceptance criterion).
        getSyncStatus: () => status,

        resolveTarget: async (): Promise<ShareTarget | null> => {
          const activeSource = await currentSource();

          // Server-sourced: id and cached URL are already in hand.
          if (activeSource.source === "server") {
            return {
              serverInvoiceId: activeSource.detail.id,
              receiptPdfUrl: activeSource.detail.receiptPdfUrl ?? null,
            };
          }

          // Device-local, but the caller already told us the server id (e.g.
          // this invoice has already synced and the caller carries
          // OfflineInvoice.serverId). Skip the network round-trip entirely —
          // see the [FIX] note in this file's header for why passing
          // receiptPdfUrl: null here is safe, not merely convenient.
          if (serverInvoiceId) {
            return { serverInvoiceId, receiptPdfUrl: null };
          }

          // Device-local, id unknown: the one remaining case that actually
          // needs the by-offline-id lookup.
          const res = await fetch(
            `/api/invoices/by-offline-id?offlineId=${encodeURIComponent(activeSource.invoice.offlineId)}`,
            { cache: "no-store" }
          );
          if (!res.ok) return null;

          const payload = (await res.json().catch(() => null)) as {
            invoice?: { id?: string; receiptPdfUrl?: string | null } | null;
          } | null;
          const invoice = payload?.invoice;
          if (!invoice?.id) return null;

          return {
            serverInvoiceId: invoice.id,
            receiptPdfUrl: invoice.receiptPdfUrl ?? null,
          };
        },

        renderRaster: async () => {
          const model = buildReceiptModel(await currentSource());
          const { blob } = await renderReceiptPngBlob(model);
          return blob;
        },

        cacheRaster: async (invoiceId, raster) => {
          const form = new FormData();
          form.append("raster", raster, `receipt-${invoiceId}.png`);
          const res = await fetch(`/api/invoices/${invoiceId}/receipt`, {
            method: "POST",
            body: form,
          });
          const data = (await res.json().catch(() => null)) as {
            success?: boolean;
            receiptPdfUrl?: string;
            message?: string;
          } | null;
          if (!res.ok || !data?.success || !data.receiptPdfUrl) {
            throw new Error(data?.message || SHARE_FAILED_MESSAGE);
          }
          return data.receiptPdfUrl;
        },

        deliverPdf: (url) => {
          // The client never holds or writes a PDF — it opens the server-cached
          // artifact, which the user then shares from their own viewer. See
          // share-flow.ts's note on why the client only ever produces a raster.
          window.open(url, "_blank", "noopener,noreferrer");
        },
      });

      if (result.kind === "blocked") {
        setGateMessage(result.messageAr);
        toast.error(result.messageAr);
        return;
      }

      toast.success(
        result.kind === "reused"
          ? "تم فتح الإيصال المُخزَّن مسبقاً على السيرفر."
          : "تم إنشاء الإيصال ومشاركته."
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : SHARE_FAILED_MESSAGE);
    } finally {
      setBusy(null);
    }
  }

  const inlineMessage = gateMessage ?? gateReason;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size={size === "sm" ? "sm" : "default"}
          onClick={handleThermalPrint}
          disabled={busy !== null}
          className={size === "sm" ? "gap-1.5 text-[11px]" : "gap-1.5 text-xs"}
          title="طباعة حرارية مباشرة (58/80 مم) عبر البلوتوث — لا تحتاج اتصالاً بالإنترنت"
        >
          {busy === "print" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Printer className="h-3.5 w-3.5" />
          )}
          <span>طباعة حرارية</span>
        </Button>

        {/*
          Rule 1: DISABLED — never hidden — until the invoice is on the server,
          with the Arabic explanation right beside it. aria-disabled mirrors the
          visual state for assistive tech, and the title carries the same string
          so a hover explains the disabled state too.
        */}
        <Button
          type="button"
          variant="outline"
          size={size === "sm" ? "sm" : "default"}
          onClick={handleShare}
          disabled={!gate.allowed || busy !== null}
          aria-disabled={!gate.allowed}
          className={size === "sm" ? "gap-1.5 text-[11px]" : "gap-1.5 text-xs"}
          title={gate.allowed ? "فتح أو إنشاء ملف PDF للإيصال ومشاركته" : gateReason ?? undefined}
        >
          {busy === "share" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Share2 className="h-3.5 w-3.5" />
          )}
          <span>مشاركة الإيصال (PDF)</span>
        </Button>
      </div>

      {inlineMessage && (
        <p
          role="status"
          className="mt-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
        >
          {inlineMessage}
        </p>
      )}
    </div>
  );
}