"use client";

/**
 * lib/receipts/printer-session.ts
 *
 * T4f — the SESSION-scoped half of Rule 4's split: the live, paired printer
 * handle for THIS browser tab. Deliberately separate from the PERSISTED half
 * (lib/receipts/printer-config.ts's per-device width).
 *
 * [WHY THESE TWO THINGS LIVE IN DIFFERENT PLACES]
 *   - The CONFIG (paper width + dots-per-line) is a human decision that must
 *     survive a reload, so it lives in Dexie's `deviceSettings` table.
 *   - The HANDLE holds a live `BluetoothDevice` object — a browser-owned,
 *     non-serializable handle tied to one permission grant in one tab. It
 *     cannot be written to IndexedDB (structured cloning drops the GATT
 *     surface), and pretending otherwise would produce a "configured" state
 *     that silently cannot print. So it lives in memory, for this page's
 *     lifetime only, and a reload means re-pairing via the browser's own
 *     chooser — which is also the only honest pairing UI, since a page cannot
 *     enumerate devices silently.
 *
 * [NO WIDTH DECISION LIVES HERE] This module never reads, infers, or stores a
 * dots-per-line value, and never inspects `handle.name` for one (Rule 4). The
 * name is carried for DISPLAY only. Width always comes from
 * printer-config.ts's resolvePrintableWidth().
 *
 * [WHY A MODULE-LEVEL STORE RATHER THAN REACT CONTEXT] Two components that are
 * not in a parent/child relationship need the same handle: the print button
 * (components/receipts/receipt-actions.tsx, rendered inside the checkout modal,
 * the offline void panel, and the sales-log detail modal) and the printer
 * settings popover (components/pos/printer-settings-popover.tsx, mounted in
 * pos-layout's top bar). Threading it through props would couple three
 * unrelated screens. A tiny subscribe/getSnapshot pair plus useSyncExternalStore
 * is the smallest honest sharing mechanism, and it is the SAME pattern
 * components/dashboard/connection-status.tsx already uses for `navigator.onLine`
 * and hooks/use-mobile.ts for a media query.
 */

import { useSyncExternalStore } from "react";
import { requestThermalPrinter, type ThermalPrinterHandle } from "./bluetooth-printer";

let pairedPrinter: ThermalPrinterHandle | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function getPairedPrinter(): ThermalPrinterHandle | null {
  return pairedPrinter;
}

/** Set/cleared by the pairing control; null forgets this tab's printer. */
export function setPairedPrinter(handle: ThermalPrinterHandle | null): void {
  pairedPrinter = handle;
  emitChange();
}

export function subscribeToPairedPrinter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** There is no printer on the server; SSR renders the unpaired state. */
export function getServerPairedPrinterSnapshot(): null {
  return null;
}

/**
 * Returns this tab's paired printer, pairing on demand if it has none.
 *
 * MUST be reached from a user gesture (a click) on the first call — the
 * browser's chooser requires one. Callers therefore never call this from an
 * effect; see receipt-actions.tsx's print handler.
 */
export async function ensurePairedPrinter(): Promise<ThermalPrinterHandle> {
  if (pairedPrinter) return pairedPrinter;
  const handle = await requestThermalPrinter();
  setPairedPrinter(handle);
  return handle;
}

export function usePairedPrinter(): ThermalPrinterHandle | null {
  return useSyncExternalStore(
    subscribeToPairedPrinter,
    getPairedPrinter,
    getServerPairedPrinterSnapshot
  );
}
