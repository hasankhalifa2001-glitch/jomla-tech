/**
 * lib/receipts/receipt-model.ts
 *
 * T4f addendum — Rule 1 and Rule 2: ONE receipt model, built from whichever
 * representation of the invoice is authoritative right now.
 *
 *   - `source: "local"`  → an offlineInvoices Dexie row (PENDING / FAILED /
 *     SYNCED). Requires NO network call and NO receiptPdfUrl, and is what
 *     makes "thermal printing succeeds for a not-yet-synced invoice" true by
 *     construction rather than by luck: there is no fetch anywhere on this
 *     path to accidentally depend on.
 *   - `source: "server"` → the server-authoritative InvoiceDetail returned by
 *     GET /api/invoices/[id]. Used for a synced invoice's thermal print, and
 *     for the raster that becomes the cached, shared PDF (the approved plan's
 *     Condition 2: the shared artifact must carry server numbers, never a
 *     local row's view of them).
 *
 * Rule 2 is satisfied by construction rather than by a special case: a
 * locally-queued void record written by submitOfflineVoid() is just an
 * OfflineInvoice whose `voidsOfflineInvoiceId` is set, so it selects the same
 * VOID branch, renders the same void notice, and applies the same
 * negative-quantity rule as a server VOIDED invoice. There is deliberately no
 * `if (isOfflineVoid)` anywhere in this file.
 *
 * The output is a flat, ordered list of ReceiptBlock values — presentation
 * *intent*, not presentation. Wrapping, alignment and pixel math belong to
 * lib/receipts/receipt-layout.ts, which is fed by an injected
 * width-measuring function so the whole pipeline stays unit-testable with no
 * canvas, no DOM, and no Bluetooth.
 *
 * [FIX — SYP-only receipt] Per product decision: the printed/shared receipt
 * never shows a USD "≈" approximation — not on the total/paid/debt rows, not
 * per line item. Every money row below is built from `sypLabel()` alone.
 * The exchange-rate reference row is kept (it is a rate, not a converted
 * amount). USD fields still exist on OfflineInvoice / ServerReceiptDetail for
 * other parts of the app (e.g. the on-screen checkout modal) — they are just
 * never read by this file anymore.
 *
 * [FIX — business name] The receipt header now shows the tenant's business
 * name as the prominent title, with the SALE/VOID document label demoted to
 * a subtitle beneath it. Sourced offline-safe: LocalReceiptSource.businessName
 * comes from CachedSession.tenantName (see local-receipt-source.ts), never a
 * network call; ServerReceiptDetail.businessName comes from Tenant.name,
 * resolved server-side (see lib/data/invoices.ts). Falls back to the plain
 * document title when null, so a missing name never breaks receipt building.
 *
 * [v4.9 — DISPLAY MERGE OF SPLIT LINES] A sale whose FIFO allocation spans
 * several batches is stored as several InvoiceItem rows (one per batch), each
 * carrying only its share of the quantity in the SALE unit (20/24 = 0.8333,
 * 4/24 = 0.1667). Printed as-is, one طرد shows up as two fractional lines.
 * Lines with the same product name + unit name + unit price are therefore
 * merged for DISPLAY: quantities are summed with sumMoney(), and the merged
 * line's total is the SUM of the original lines' totals (NOT merged quantity
 * × price), so the receipt can never disagree with the invoice total even if
 * the rounded fractions sum to 0.9999. Nothing stored or returned by the API
 * changes — voids and stock restoration keep using the raw rows
 * (InvoiceItem.baseQuantity); this is a presentation-only step.
 */

import type { OfflineInvoice, OfflineInvoiceItem } from "@/lib/offline/db";
import {
  compareMoney,
  multiplyMoney,
  sumMoney,
  type MoneyInput,
} from "@/lib/utils/money";
import {
  LOCAL_ONLY_NOTICE,
  SALE_DOCUMENT_LABEL,
  VOID_DOCUMENT_LABEL,
  VOID_TOTAL_LABEL,
  absoluteMoney,
  formatQuantityLabel,
  formatReceiptTimestamp,
  paymentMethodLabel,
  sypLabel,
} from "./receipt-lines";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Names for the local path. An offlineInvoices row stores only
 * productId/unitId (db.ts's OfflineInvoiceItem) — names were never
 * denormalized onto it — so a local receipt resolves them from the local
 * catalog cache. The post-checkout fast path already has them in hand
 * (components/pos/pos-layout.tsx passes the cart's CartLineItem[], which
 * carries `product.name` + `unitName`), so it simply pre-fills this map and
 * the print path touches Dexie not at all.
 */
export interface LocalReceiptItemNames {
  productNames: Record<string, string>;
  unitNames: Record<string, string>;
}

export const EMPTY_LOCAL_ITEM_NAMES: LocalReceiptItemNames = {
  productNames: {},
  unitNames: {},
};

export interface LocalReceiptSource {
  source: "local";
  invoice: OfflineInvoice;
  customerName: string;
  itemNames: LocalReceiptItemNames;
  /**
   * [FIX — business name] Tenant.name, sourced from CachedSession.tenantName
   * offline (see resolveLocalBusinessName in local-receipt-source.ts) — no
   * network call. Null when unavailable; headerBlocks() falls back to the
   * plain document title in that case.
   */
  businessName: string | null;
}

/**
 * Structural mirror of lib/data/invoices.ts's InvoiceDetail (and of
 * components/sales-log/types.ts's serialized twin). Declared here rather than
 * imported from a component so lib/receipts never depends on the UI layer —
 * an InvoiceDetail is assignable to this by structure alone.
 */
export interface ServerReceiptDetailItem {
  productName: string;
  unitName: string;
  quantity: string;
  unitPriceSYP: string;
  unitPriceUSD: string | null;
}

export interface ServerReceiptDetail {
  id: string;
  createdAt: string | Date;
  status: "COMPLETED" | "PENDING_REVIEW" | "VOIDED";
  voidsInvoiceId: string | null;
  voidReason: string | null;
  totalSYP: string;
  // [v4.9] Nullable — null for SYP-only sales with no frozen rate.
  totalUSD: string | null;
  paidAmountSYP: string;
  paidAmountUSD: string | null;
  debtAmountSYP: string;
  debtAmountUSD: string | null;
  exchangeRateUsed: string | null;
  /**
   * [Rule 3 reuse] Invoice.receiptPdfUrl as it arrives on the InvoiceDetail wire
   * DTO (lib/data/invoices.ts) / as returned by by-offline-id. OPTIONAL, because
   * the print path never reads it — only the share path does, and only to skip
   * rendering when this invoice has already been shared once (share-flow.ts's
   * STEP 3). A detail without it is therefore a valid, printable source.
   */
  receiptPdfUrl?: string | null;
  customer: { name: string };
  items: ServerReceiptDetailItem[];
  /** [FIX — business name] Tenant.name, resolved server-side. */
  businessName: string | null;
}

export interface ServerReceiptSource {
  source: "server";
  detail: ServerReceiptDetail;
}

export type ReceiptSource = LocalReceiptSource | ServerReceiptSource;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type ReceiptDocumentKind = "SALE" | "VOID";

export type ReceiptBlock =
  | { type: "title"; text: string }
  | { type: "subtitle"; text: string }
  | { type: "notice"; text: string; tone: "warn" | "danger" }
  | { type: "row"; label: string; value: string; emphasis?: "primary" | "danger" }
  | {
    type: "item";
    name: string;
    detail: string;
    total: string;
    /** Secondary/derived line. Unused since the SYP-only fix — kept optional
     * on the type so a future need (e.g. a per-tenant re-opt-in) does not
     * require touching receipt-layout.ts / receipt-canvas.ts again. */
    sub?: string;
    isReturn: boolean;
  }
  | { type: "divider" }
  | { type: "spacer" };

export interface ReceiptModel {
  kind: ReceiptDocumentKind;
  /** offlineId for a local row, Invoice id for a server row. */
  reference: string;
  createdAtLabel: string;
  customerName: string;
  isSynced: boolean;
  blocks: ReceiptBlock[];
}

function isVoidLocal(invoice: OfflineInvoice): boolean {
  return Boolean(invoice.voidsOfflineInvoiceId);
}

function isVoidServer(detail: ServerReceiptDetail): boolean {
  return detail.status === "VOIDED" || detail.voidsInvoiceId !== null;
}

function localItemName(
  names: LocalReceiptItemNames,
  item: OfflineInvoiceItem
): { productName: string; unitName: string } {
  return {
    productName: names.productNames[item.productId] ?? "صنف غير معروف",
    unitName: names.unitNames[item.unitId] ?? "وحدة",
  };
}

/**
 * [FIX — business name] `businessName` (when present and non-blank) becomes
 * the prominent receipt title, and the SALE/VOID document label is demoted
 * to a subtitle beneath it. With no business name, behavior is unchanged
 * from before this fix: the document label alone is the title.
 */
function headerBlocks(
  kind: ReceiptDocumentKind,
  reference: string,
  createdAt: string | Date,
  originalReference: string | null,
  businessName: string | null
): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];

  if (businessName && businessName.trim()) {
    blocks.push({ type: "title", text: businessName.trim() });
    blocks.push({
      type: "subtitle",
      text: kind === "VOID" ? VOID_DOCUMENT_LABEL : SALE_DOCUMENT_LABEL,
    });
  } else {
    blocks.push({
      type: "title",
      text: kind === "VOID" ? VOID_DOCUMENT_LABEL : SALE_DOCUMENT_LABEL,
    });
  }

  blocks.push({ type: "subtitle", text: `المرجع: ${reference}` });
  blocks.push({ type: "subtitle", text: `التاريخ: ${formatReceiptTimestamp(createdAt)}` });

  if (kind === "VOID" && originalReference) {
    blocks.push({ type: "subtitle", text: `الفاتورة الملغاة: ${originalReference}` });
  }

  return blocks;
}

/**
 * The SALE totals block. Every figure here is non-negative by the ledger's own
 * invariant (db.ts's createOfflineInvoiceRecord enforces paidAmountSYP >= 0 and
 * debtAmountSYP >= 0 on a plain sale), so no sign normalization is needed — and
 * applying one would silently hide a real invariant violation.
 *
 * [FIX — SYP-only] No longer takes or reads any USD figure. Every value is
 * `sypLabel()` alone — no "(≈ $X)" suffix anywhere on this block.
 */
function saleTotalBlocks(
  totalSYP: MoneyInput,
  paidSYP: MoneyInput,
  debtSYP: MoneyInput,
  exchangeRateUsed: MoneyInput | null
): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [
    { type: "divider" },
    {
      type: "row",
      label: "إجمالي الفاتورة",
      value: sypLabel(totalSYP),
      emphasis: "primary",
    },
    {
      type: "row",
      label: "المبلغ المدفوع",
      value: sypLabel(paidSYP),
    },
  ];

  if (compareMoney(debtSYP, "0") > 0) {
    blocks.push({
      type: "row",
      label: "المتبقي على الحساب (دين)",
      value: sypLabel(debtSYP),
      emphasis: "danger",
    });
  }

  // [v4.9] Omit the rate line entirely when null — no placeholder, no "—".
  if (exchangeRateUsed !== null) {
    blocks.push({
      type: "row",
      label: "سعر الصرف المعتمد",
      value: `${sypLabel(exchangeRateUsed)} / $`,
    });
  }

  return blocks;
}

/**
 * The VOID totals block — Condition 4 of the approved plan. Every figure is
 * shown as an ABSOLUTE value under an explicit label, because a void row's
 * stored money is negative by design (the same "negative for display
 * purposes" convention Rule 5 describes for quantities) and a customer-facing
 * receipt must never show a bare minus sign.
 *
 * [FIX — SYP-only] Same change as saleTotalBlocks: no USD parameters, no
 * "(≈ $X)" suffix.
 */
function voidTotalBlocks(
  totalSYP: MoneyInput,
  paidSYP: MoneyInput,
  debtSYP: MoneyInput,
  exchangeRateUsed: MoneyInput | null
): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [
    { type: "divider" },
    {
      type: "row",
      label: VOID_TOTAL_LABEL,
      value: sypLabel(absoluteMoney(totalSYP)),
      emphasis: "primary",
    },
    {
      type: "row",
      label: "المبلغ المُعاد للزبون",
      value: sypLabel(absoluteMoney(paidSYP)),
    },
  ];

  if (compareMoney(debtSYP, "0") !== 0) {
    blocks.push({
      type: "row",
      label: "تسوية الدين (إلغاء)",
      value: sypLabel(absoluteMoney(debtSYP)),
      emphasis: "danger",
    });
  }

  // [v4.9] Omit the rate line entirely when null — no placeholder, no "—".
  if (exchangeRateUsed !== null) {
    blocks.push({
      type: "row",
      label: "سعر الصرف المعتمد (فاتورة البيع الأصلية)",
      value: `${sypLabel(exchangeRateUsed)} / $`,
    });
  }

  return blocks;
}

/** Shared tail: the sync notice a device-local invoice must carry. */
function syncNoticeBlocks(isSynced: boolean): ReceiptBlock[] {
  if (isSynced) return [];
  return [{ type: "notice", text: LOCAL_ONLY_NOTICE, tone: "warn" }];
}

// ---------------------------------------------------------------------------
// [v4.9] Display merge of split lines
// ---------------------------------------------------------------------------

interface ReceiptLineInput {
  productName: string;
  unitName: string;
  /** Signed quantity in the SALE unit (negative on a void row). */
  quantity: string;
  unitPriceSYP: string;
}

interface MergedReceiptLine {
  productName: string;
  unitName: string;
  /** Sum of the original lines' quantities (signed). */
  quantity: string;
  unitPriceSYP: string;
  /**
   * Sum of each ORIGINAL line's |quantity × price| — deliberately NOT
   * (merged quantity × price): a split like 0.3333 × 3 sums to 0.9999 and
   * would print a total that disagrees with the invoice. Summing the
   * per-row totals reproduces the invoice total exactly.
   */
  lineTotalSYP: string;
}

/**
 * Merges lines that share product name + unit name + unit price (the key a
 * FIFO split produces: same sale line, different batch). Order of first
 * appearance is preserved. Display-only — see the file header.
 */
function mergeReceiptLines(lines: ReceiptLineInput[]): MergedReceiptLine[] {
  const merged = new Map<string, MergedReceiptLine>();

  for (const line of lines) {
    const rowTotal = absoluteMoney(multiplyMoney(line.quantity, line.unitPriceSYP));
    const key = `${line.productName}::${line.unitName}::${line.unitPriceSYP}`;
    const prev = merged.get(key);

    if (!prev) {
      merged.set(key, {
        productName: line.productName,
        unitName: line.unitName,
        quantity: line.quantity,
        unitPriceSYP: line.unitPriceSYP,
        lineTotalSYP: rowTotal,
      });
    } else {
      prev.quantity = sumMoney([prev.quantity, line.quantity]);
      prev.lineTotalSYP = sumMoney([prev.lineTotalSYP, rowTotal]);
    }
  }

  return [...merged.values()];
}

function mergedLinesToBlocks(lines: MergedReceiptLine[]): ReceiptBlock[] {
  return lines.map((line) => ({
    type: "item" as const,
    name: line.productName,
    // Rule 5: formatQuantityLabel turns a stored "-3" into "مرتجع: 3 <unit>".
    detail: `${formatQuantityLabel(line.quantity, line.unitName)} × ${sypLabel(
      absoluteMoney(line.unitPriceSYP)
    )}`,
    total: sypLabel(line.lineTotalSYP),
    isReturn: compareMoney(line.quantity, "0") < 0,
  }));
}

/**
 * [FIX — SYP-only] No longer computes or attaches `sub` (the "≈ $X" line per
 * item). Only the SYP line total is produced.
 * [v4.9] Lines are merged for display (see mergeReceiptLines).
 */
function localItemsToBlocks(
  items: OfflineInvoiceItem[],
  resolveName: (item: OfflineInvoiceItem) => { productName: string; unitName: string }
): ReceiptBlock[] {
  return mergedLinesToBlocks(
    mergeReceiptLines(
      items.map((item) => {
        const { productName, unitName } = resolveName(item);
        return {
          productName,
          unitName,
          quantity: item.quantity,
          unitPriceSYP: item.unitPriceSYP,
        };
      })
    )
  );
}

/**
 * [FIX — SYP-only] Same change as localItemsToBlocks.
 * [v4.9] Lines are merged for display (see mergeReceiptLines) — this is the
 * path that actually matters: a server invoice is where FIFO splits exist.
 */
function serverItemsToBlocks(items: ServerReceiptDetailItem[]): ReceiptBlock[] {
  return mergedLinesToBlocks(
    mergeReceiptLines(
      items.map((item) => ({
        productName: item.productName,
        unitName: item.unitName,
        quantity: item.quantity,
        unitPriceSYP: item.unitPriceSYP,
      }))
    )
  );
}

function buildLocalModel(source: LocalReceiptSource): ReceiptModel {
  const { invoice, itemNames } = source;
  const kind: ReceiptDocumentKind = isVoidLocal(invoice) ? "VOID" : "SALE";
  const isSynced = invoice.status === "SYNCED";

  const blocks: ReceiptBlock[] = headerBlocks(
    kind,
    invoice.offlineId,
    invoice.createdAt,
    invoice.voidsOfflineInvoiceId ?? null,
    source.businessName
  );

  blocks.push({ type: "row", label: "الزبون", value: source.customerName || "زبون نقدي" });

  const methodLabel = paymentMethodLabel(invoice.paymentMethod);
  if (methodLabel) {
    blocks.push({ type: "row", label: "طريقة الدفع", value: methodLabel });
  }

  if (kind === "VOID" && invoice.voidReason) {
    blocks.push({
      type: "notice",
      text: `سبب الإلغاء: ${invoice.voidReason}`,
      tone: "danger",
    });
  }

  blocks.push({ type: "divider" });
  blocks.push(
    ...localItemsToBlocks(invoice.items, (item) => localItemName(itemNames, item))
  );

  blocks.push(
    ...(kind === "VOID"
      ? voidTotalBlocks(
        invoice.totalSYP,
        invoice.paidAmountSYP,
        invoice.debtAmountSYP,
        invoice.exchangeRateUsed
      )
      : saleTotalBlocks(
        invoice.totalSYP,
        invoice.paidAmountSYP,
        invoice.debtAmountSYP,
        invoice.exchangeRateUsed
      )),
    ...syncNoticeBlocks(isSynced)
  );

  return {
    kind,
    reference: invoice.offlineId,
    createdAtLabel: formatReceiptTimestamp(invoice.createdAt),
    customerName: source.customerName || "زبون نقدي",
    isSynced,
    blocks,
  };
}

function buildServerModel(source: ServerReceiptSource): ReceiptModel {
  const { detail } = source;
  const kind: ReceiptDocumentKind = isVoidServer(detail) ? "VOID" : "SALE";
  const customerName = detail.customer?.name || "زبون نقدي";

  const blocks: ReceiptBlock[] = headerBlocks(
    kind,
    detail.id,
    detail.createdAt,
    detail.voidsInvoiceId,
    detail.businessName
  );

  blocks.push({ type: "row", label: "الزبون", value: customerName });

  if (kind === "VOID" && detail.voidReason) {
    blocks.push({
      type: "notice",
      text: `سبب الإلغاء: ${detail.voidReason}`,
      tone: "danger",
    });
  }

  blocks.push({ type: "divider" });
  blocks.push(...serverItemsToBlocks(detail.items));

  blocks.push(
    ...(kind === "VOID"
      ? voidTotalBlocks(
        detail.totalSYP,
        detail.paidAmountSYP,
        detail.debtAmountSYP,
        detail.exchangeRateUsed
      )
      : saleTotalBlocks(
        detail.totalSYP,
        detail.paidAmountSYP,
        detail.debtAmountSYP,
        detail.exchangeRateUsed
      ))
    // A server-sourced invoice is on the server by definition: no sync notice.
  );

  return {
    kind,
    reference: detail.id,
    createdAtLabel: formatReceiptTimestamp(detail.createdAt),
    customerName,
    isSynced: true,
    blocks,
  };
}

/**
 * The single entry point both paths (thermal bitmap, shared PDF raster) use.
 * Nothing in this file — or anywhere it imports — performs I/O, so the
 * "thermal printing of a PENDING invoice makes zero network calls" acceptance
 * criterion is a property of the module graph, not of a runtime check.
 */
export function buildReceiptModel(source: ReceiptSource): ReceiptModel {
  return source.source === "local"
    ? buildLocalModel(source)
    : buildServerModel(source);
}

/**
 * Every user-visible string in a model, in order — the sweep target for the
 * mechanical "no bare minus sign on a customer-facing receipt" assertion
 * (Rule 5 + Condition 4) shared by the thermal and PDF tests.
 */
export function receiptModelStrings(model: ReceiptModel): string[] {
  const out: string[] = [];

  for (const block of model.blocks) {
    switch (block.type) {
      case "title":
      case "subtitle":
        out.push(block.text);
        break;
      case "notice":
        out.push(block.text);
        break;
      case "row":
        out.push(block.label, block.value);
        break;
      case "item":
        out.push(block.name, block.detail, block.total);
        if (block.sub) out.push(block.sub);
        break;
      default:
        break;
    }
  }

  return receiptModelStringsTail(out);
}

// Kept as a trivial identity hop so the exported function above stays a
// single linear switch; no behavior of its own.
function receiptModelStringsTail(out: string[]): string[] {
  return out;
}