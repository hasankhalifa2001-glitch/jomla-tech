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
 */

import type { OfflineInvoice, OfflineInvoiceItem } from "@/lib/offline/db";
import { compareMoney, multiplyMoney, type MoneyInput } from "@/lib/utils/money";
import {
  LOCAL_ONLY_NOTICE,
  SALE_DOCUMENT_LABEL,
  VOID_DOCUMENT_LABEL,
  VOID_TOTAL_LABEL,
  absoluteMoney,
  dualMoneyLabel,
  formatQuantityLabel,
  formatReceiptTimestamp,
  paymentMethodLabel,
  sypLabel,
  usdLabel,
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
  totalUSD: string;
  paidAmountSYP: string;
  paidAmountUSD: string;
  debtAmountSYP: string;
  debtAmountUSD: string;
  exchangeRateUsed: string;
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
      /** Secondary/derived line (the USD "≈" figure), when there is one. */
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

function headerBlocks(
  kind: ReceiptDocumentKind,
  reference: string,
  createdAt: string | Date,
  originalReference: string | null
): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [
    { type: "title", text: kind === "VOID" ? VOID_DOCUMENT_LABEL : SALE_DOCUMENT_LABEL },
    { type: "subtitle", text: `المرجع: ${reference}` },
    { type: "subtitle", text: `التاريخ: ${formatReceiptTimestamp(createdAt)}` },
  ];

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
 */
function saleTotalBlocks(
  totalSYP: MoneyInput,
  totalUSD: MoneyInput | null,
  paidSYP: MoneyInput,
  paidUSD: MoneyInput | null,
  debtSYP: MoneyInput,
  debtUSD: MoneyInput | null,
  exchangeRateUsed: MoneyInput | null
): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [
    { type: "divider" },
    {
      type: "row",
      label: "إجمالي الفاتورة",
      value: dualMoneyLabel(totalSYP, totalUSD),
      emphasis: "primary",
    },
    {
      type: "row",
      label: "المبلغ المدفوع",
      value: dualMoneyLabel(paidSYP, paidUSD),
    },
  ];

  if (compareMoney(debtSYP, "0") > 0) {
    blocks.push({
      type: "row",
      label: "المتبقي على الحساب (دين)",
      value: dualMoneyLabel(debtSYP, debtUSD),
      emphasis: "danger",
    });
  }

  blocks.push({
    type: "row",
    label: "سعر الصرف المعتمد",
    value: exchangeRateUsed === null ? "—" : `${sypLabel(exchangeRateUsed)} / $`,
  });

  return blocks;
}

/**
 * The VOID totals block — Condition 4 of the approved plan. Every figure is
 * shown as an ABSOLUTE value under an explicit label, because a void row's
 * stored money is negative by design (the same "negative for display
 * purposes" convention Rule 5 describes for quantities) and a customer-facing
 * receipt must never show a bare minus sign.
 */
function voidTotalBlocks(
  totalSYP: MoneyInput,
  totalUSD: MoneyInput | null,
  paidSYP: MoneyInput,
  paidUSD: MoneyInput | null,
  debtSYP: MoneyInput,
  debtUSD: MoneyInput | null,
  exchangeRateUsed: MoneyInput | null
): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [
    { type: "divider" },
    {
      type: "row",
      label: VOID_TOTAL_LABEL,
      value: dualMoneyLabel(
        absoluteMoney(totalSYP),
        totalUSD === null ? null : absoluteMoney(totalUSD)
      ),
      emphasis: "primary",
    },
    {
      type: "row",
      label: "المبلغ المُعاد للزبون",
      value: dualMoneyLabel(
        absoluteMoney(paidSYP),
        paidUSD === null ? null : absoluteMoney(paidUSD)
      ),
    },
  ];

  if (compareMoney(debtSYP, "0") !== 0) {
    blocks.push({
      type: "row",
      label: "تسوية الدين (إلغاء)",
      value: dualMoneyLabel(
        absoluteMoney(debtSYP),
        debtUSD === null ? null : absoluteMoney(debtUSD)
      ),
      emphasis: "danger",
    });
  }

  blocks.push({
    type: "row",
    label: "سعر الصرف المعتمد (فاتورة البيع الأصلية)",
    value: exchangeRateUsed === null ? "—" : `${sypLabel(exchangeRateUsed)} / $`,
  });

  return blocks;
}

/** Shared tail: the sync notice a device-local invoice must carry. */
function syncNoticeBlocks(isSynced: boolean): ReceiptBlock[] {
  if (isSynced) return [];
  return [{ type: "notice", text: LOCAL_ONLY_NOTICE, tone: "warn" }];
}

function localItemsToBlocks(
  items: OfflineInvoiceItem[],
  resolveName: (item: OfflineInvoiceItem) => { productName: string; unitName: string }
): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];

  for (const item of items) {
    const { productName, unitName } = resolveName(item);
    const lineTotalSYP = absoluteMoney(multiplyMoney(item.quantity, item.unitPriceSYP));
    const lineTotalUSD =
      item.unitPriceUSD === null
        ? null
        : absoluteMoney(multiplyMoney(item.quantity, item.unitPriceUSD));

    blocks.push({
      type: "item",
      name: productName,
      // Rule 5: formatQuantityLabel turns a stored "-3" into "مرتجع: 3 <unit>".
      detail: `${formatQuantityLabel(item.quantity, unitName)} × ${sypLabel(
        absoluteMoney(item.unitPriceSYP)
      )}`,
      total: sypLabel(lineTotalSYP),
      sub: lineTotalUSD === null ? undefined : `≈ ${usdLabel(lineTotalUSD)}`,
      isReturn: compareMoney(item.quantity, "0") < 0,
    });
  }

  return blocks;
}

function serverItemsToBlocks(items: ServerReceiptDetailItem[]): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];

  for (const item of items) {
    const lineTotalSYP = absoluteMoney(multiplyMoney(item.quantity, item.unitPriceSYP));
    const lineTotalUSD =
      item.unitPriceUSD === null
        ? null
        : absoluteMoney(multiplyMoney(item.quantity, item.unitPriceUSD));

    blocks.push({
      type: "item",
      name: item.productName,
      detail: `${formatQuantityLabel(item.quantity, item.unitName)} × ${sypLabel(
        absoluteMoney(item.unitPriceSYP)
      )}`,
      total: sypLabel(lineTotalSYP),
      sub: lineTotalUSD === null ? undefined : `≈ ${usdLabel(lineTotalUSD)}`,
      isReturn: compareMoney(item.quantity, "0") < 0,
    });
  }

  return blocks;
}

function buildLocalModel(source: LocalReceiptSource): ReceiptModel {
  const { invoice, itemNames } = source;
  const kind: ReceiptDocumentKind = isVoidLocal(invoice) ? "VOID" : "SALE";
  const isSynced = invoice.status === "SYNCED";

  const blocks: ReceiptBlock[] = headerBlocks(
    kind,
    invoice.offlineId,
    invoice.createdAt,
    invoice.voidsOfflineInvoiceId ?? null
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
          invoice.totalUSD,
          invoice.paidAmountSYP,
          invoice.paidAmountUSD,
          invoice.debtAmountSYP,
          invoice.debtAmountUSD,
          invoice.exchangeRateUsed
        )
      : saleTotalBlocks(
          invoice.totalSYP,
          invoice.totalUSD,
          invoice.paidAmountSYP,
          invoice.paidAmountUSD,
          invoice.debtAmountSYP,
          invoice.debtAmountUSD,
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
    detail.voidsInvoiceId
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
          detail.totalUSD,
          detail.paidAmountSYP,
          detail.paidAmountUSD,
          detail.debtAmountSYP,
          detail.debtAmountUSD,
          detail.exchangeRateUsed
        )
      : saleTotalBlocks(
          detail.totalSYP,
          detail.totalUSD,
          detail.paidAmountSYP,
          detail.paidAmountUSD,
          detail.debtAmountSYP,
          detail.debtAmountUSD,
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

  return out;
}
