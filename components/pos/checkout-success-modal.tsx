"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Printer,
  PlusCircle,
  CloudOff,
  User,
  Calendar,
} from "lucide-react";
import { getOfflineDb } from "@/lib/offline/db";
import { useLocalInvoiceSyncStatus } from "@/lib/receipts/use-local-invoice-status";
import type { OfflineInvoice, SelectedCustomer, CartLineItem } from "@/lib/offline";
import { compareMoney, multiplyMoney } from "@/lib/utils/money";
import { ReceiptActions } from "@/components/receipts/receipt-actions";
import {
  buildLocalReceiptSource,
  itemNamesFromCartLines,
} from "@/lib/receipts/local-receipt-source";
import type { LocalReceiptSource } from "@/lib/receipts/receipt-model";
import { fmtInt, fmtMoney, NUMBER_LOCALE } from "@/lib/utils/digits";
import { Money } from "./money";

interface CheckoutSuccessModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: OfflineInvoice | null;
  customer: SelectedCustomer | null;
  items: CartLineItem[];
  onStartNewSale: () => void;
  /**
   * [T4f] Opens pos-layout's printer settings popover when a thermal print fails
   * because this device has no confirmed printer width yet — so a first-time
   * printer setup is one click away from the receipt the cashier was printing.
   */
  onPrinterSetupRequired?: () => void;
}

export function CheckoutSuccessModal({
  open,
  onOpenChange,
  invoice,
  customer,
  items,
  onStartNewSale,
  onPrinterSetupRequired,
}: CheckoutSuccessModalProps) {
  /**
   * [FIX] Same live sync-status source of truth as ReceiptActions' own
   * share-gate — not a second, independent Dexie subscription. The banner
   * below and the share button inside <ReceiptActions> now react to the
   * exact same status value at the exact same moment sync-worker.ts flips
   * this row to SYNCED. Called unconditionally, before the `!invoice`
   * early return below, because hooks cannot be conditional (same rule
   * receipt-actions.tsx's own header comment calls out).
   */
  const localStatus = useLocalInvoiceSyncStatus(invoice?.offlineId ?? null);
  const isSynced = localStatus.status === "SYNCED";

  if (!invoice) return null;

  function handlePrint() {
    window.print();
  }

  const paymentMethodLabels: Record<string, string> = {
    CASH: "نقداً (كاش)",
    SHAM_CASH: "شام كاش (Sham Cash)",
    SYRIATEL_CASH: "سيرياتيل كاش (Syriatel)",
    BANK_TRANSFER: "تحويل بنكي / مكتب",
    OTHER: "وسيلة أخرى",
  };

  const currentMethod = invoice.paymentMethod;
  const paymentLabel = currentMethod
    ? paymentMethodLabels[currentMethod] || currentMethod
    : "على الحساب بالكامل (دين)";

  /**
   * [FIX — real bug, confirmed via screenshot] `invoice` prop is a snapshot
   * from the moment this modal opened and never updates its own `status`
   * field. A static LocalReceiptSource therefore kept reporting the invoice
   * as PENDING to buildReceiptModel() forever — even after
   * useLocalInvoiceSyncStatus (the same live query the share button's gate
   * uses) correctly reported SYNCED and unlocked the button. This thunk
   * re-reads the live Dexie row and delegates to buildLocalReceiptSource()
   * — the single shared builder that also resolves the tenant's business
   * name from CachedSession, so print/share always reflects the invoice's
   * TRUE current state, not the state at modal-open time.
   *
   * [FIX] `db` was never an export of "@/lib/offline/db" — that module only
   * exports the singleton accessor `getOfflineDb()`. Also corrected the table
   * name (`offlineInvoices`, not `invoices`) and the lookup itself: the
   * table's primary key is the numeric auto-increment `id`
   * (`++id, &offlineId, ...`), not the string `offlineId`, so a plain
   * `.get(offlineIdString)` would look up the wrong key. `offlineId` is only
   * a unique secondary index, so it must be queried via `.where(...).equals(...)`.
   */
  async function buildCurrentReceiptSource(): Promise<LocalReceiptSource> {
    const dbInstance = getOfflineDb();
    const liveInvoice =
      (await dbInstance.offlineInvoices
        .where("offlineId")
        .equals(invoice!.offlineId)
        .first()) ?? invoice!;

    return buildLocalReceiptSource({
      tenantId: liveInvoice.tenantId,
      invoice: liveInvoice,
      customerName: customer ? customer.name : "",
      knownItemNames: itemNamesFromCartLines(
        items.map((line) => ({
          productId: line.product.id,
          productName: line.product.name,
          unitId: line.unitId,
          unitName: line.unitName,
        }))
      ),
    });
  }

  // [v3.6] FIX — was checking debtAmountUSD (derived/informational).
  // debtAmountSYP is the authoritative field on OfflineInvoice
  // (pos-service.ts / db.ts) — the check that actually decides whether
  // any debt exists must run on it, not on the USD figure derived from it.
  const isDebtPresent = compareMoney(invoice.debtAmountSYP, 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" dir="rtl">
        <DialogHeader>
          {/* Answers the cashier's action: a quick pop, once, when the sale lands. */}
          <div className="mx-auto mb-1 flex size-14 animate-in items-center justify-center rounded-full bg-emerald-100 text-emerald-600 ring-8 ring-emerald-50 duration-300 zoom-in-50 motion-reduce:animate-none">
            <CheckCircle2 className="size-7" aria-hidden />
          </div>
          <DialogTitle className="text-center text-lg font-extrabold text-slate-900">
            تم حفظ الفاتورة محلياً بنجاح
          </DialogTitle>
          <DialogDescription className="text-center text-xs text-slate-500">
            تم تسجيل الفاتورة في قاعدة بيانات المتصفح (Dexie) وحفظها في طابور
            المزامنة المحلي.
          </DialogDescription>
        </DialogHeader>

        {/*
          [FIX] Sync-status banner driven by the same
          useLocalInvoiceSyncStatus(offlineId) hook ReceiptActions uses for its
          share-button gate. Once the row flips to SYNCED, this switches to the
          emerald "synced" state at the exact same moment the share button
          unlocks itself — no reload, no second source of truth.
        */}
        {isSynced ? (
          <div className="space-y-1 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
            <div className="flex items-center gap-2 text-xs font-extrabold text-emerald-800">
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden />
              <span>تمت مزامنة الفاتورة مع السيرفر بنجاح</span>
            </div>
            <p className="text-[11px] leading-relaxed text-emerald-700">
              الفاتورة أصبحت مسجّلة على السيرفر المركزي، وزر مشاركة الإيصال (PDF) متاح الآن.
            </p>
          </div>
        ) : (
          <div className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <div className="flex items-center gap-2 text-xs font-extrabold text-amber-800">
              <CloudOff className="size-4 shrink-0 text-amber-600" aria-hidden />
              <span>محفوظة محلياً — بانتظار المزامنة</span>
            </div>
            <p className="text-[11px] leading-relaxed text-amber-700">
              هذه الفاتورة <strong>مخزنة على هذا الجهاز فقط</strong> حالياً. ستتم المزامنة
              التلقائية مع السيرفر المركزي فور توفر اتصال بالإنترنت.
            </p>
          </div>
        )}

        {/* Invoice summary — also the printable card (id is used by print CSS). */}
        <div
          id="printable-receipt"
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-sm"
        >
          {/* Top metadata */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 border-b border-slate-100 pb-3">
            <div className="min-w-0">
              <span className="block text-[11px] text-slate-500">رقم الفاتورة المحلي</span>
              <span dir="ltr" className="block truncate text-start font-mono text-[11px] font-bold text-slate-800">
                {invoice.offlineId}
              </span>
            </div>

            <div>
              <span className="block text-[11px] text-slate-500">الوقت</span>
              <span className="flex items-center gap-1 text-[12px] font-semibold tabular-nums text-slate-700">
                <Calendar className="size-3 text-slate-400" aria-hidden />
                {new Date(invoice.createdAt).toLocaleTimeString(NUMBER_LOCALE, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <div className="min-w-0">
              <span className="block text-[11px] text-slate-500">الزبون</span>
              <span className="flex items-center gap-1 text-[13px] font-extrabold text-slate-900">
                <User className="size-3 shrink-0 text-slate-400" aria-hidden />
                <span className="truncate">{customer ? customer.name : "زبون نقدي عام"}</span>
              </span>
            </div>

            <div>
              <span className="block text-[11px] text-slate-500">طريقة السداد</span>
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                {paymentLabel}
              </span>
            </div>
          </div>

          {/* Items */}
          <div className="max-h-40 space-y-0.5 overflow-y-auto">
            <div className="grid grid-cols-12 border-b border-slate-100 pb-1 text-[11px] font-bold text-slate-500">
              <span className="col-span-6">الصنف / الوحدة</span>
              <span className="col-span-2 text-center">الكمية</span>
              <span className="col-span-4 text-end">الإجمالي</span>
            </div>

            {items.map((item, idx) => {
              // [v3.6] item.unitPriceSYP is the always-present, authoritative
              // field and is used for the line total. (item.unitPriceUSD is
              // `string | null` — multiplyMoney(null, …) would throw inside
              // money.ts's toDecimal() and crash this whole modal.)
              // [FIX — SYP-only] No "≈ $X" appears anywhere in this modal
              // (matches receipt-model.ts's own fix for the printed receipt).
              const lineSYP = multiplyMoney(item.unitPriceSYP, item.quantity);
              return (
                <div
                  key={idx}
                  className="grid grid-cols-12 items-center border-b border-slate-50 py-1.5 text-xs last:border-0"
                >
                  <div className="col-span-6 min-w-0">
                    <p className="truncate font-bold text-slate-900">{item.product.name}</p>
                    <p className="text-[11px] text-slate-500">{item.unitName}</p>
                  </div>
                  <span className="col-span-2 text-center font-bold tabular-nums text-slate-700">
                    {fmtInt(item.quantity)}
                  </span>
                  <span className="col-span-4 text-end font-extrabold text-slate-900">
                    <Money value={lineSYP} compact />
                  </span>
                </div>
              );
            })}
          </div>

          {/*
            Financial totals. The "(≈ $X)" secondary USD figure stays removed
            from every row (total, paid, debt). The exchange-rate row is kept —
            it is a reference rate, not a converted amount.
          */}
          <div className="space-y-1.5 border-t border-slate-100 pt-3">
            <div className="flex items-end justify-between">
              <span className="text-xs font-bold text-slate-600">إجمالي الفاتورة</span>
              <Money value={invoice.totalSYP} className="text-xl font-extrabold text-emerald-700" />
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-slate-500">سعر الصرف المعتمد</span>
              <span className="font-semibold tabular-nums text-slate-600">
                {invoice.exchangeRateUsed !== null
                  ? `${fmtMoney(invoice.exchangeRateUsed, "SYP")} ل.س / $`
                  : "—"}
              </span>
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-slate-500">المبلغ المدفوع</span>
              <Money value={invoice.paidAmountSYP} compact className="font-bold text-emerald-700" />
            </div>

            {isDebtPresent && (
              <div className="flex justify-between rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-extrabold text-red-700">
                <span>المتبقي على الحساب (دين)</span>
                <Money value={invoice.debtAmountSYP} compact unitClassName="text-red-500" />
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-2 pt-1">
          {/*
            [T4f] Thermal ESC/POS printing (Web Bluetooth) + the gated PDF share.

            [FIX] `source` is a THUNK (buildCurrentReceiptSource), not a static
            object — see that function's own comment above for why a static
            object silently baked in a stale PENDING status even after sync
            completed. receipt-actions.tsx already supports and calls a
            thunk-shaped `source` at print/share TIME.
          */}
          <ReceiptActions
            source={buildCurrentReceiptSource}
            offlineId={invoice.offlineId}
            serverInvoiceId={invoice.serverId ?? null}
            size="sm"
            onPrinterSetupRequired={onPrinterSetupRequired}
          />

          {/* Stacked on narrow screens, a row from sm: up. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={handlePrint}
              className="h-11 w-full gap-1.5 border-slate-200 text-xs font-semibold text-slate-700 sm:w-auto"
              title="طباعة الإيصال عبر نافذة المتصفح — بديل عند عدم دعم Web Bluetooth (مثل iOS)"
            >
              <Printer className="size-4" aria-hidden />
              طباعة من المتصفح
            </Button>

            <Button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onStartNewSale();
              }}
              className="h-11 w-full gap-1.5 bg-emerald-600 px-6 text-sm font-extrabold text-white shadow-sm shadow-emerald-900/20 hover:bg-emerald-700 sm:w-auto"
            >
              <PlusCircle className="size-4" aria-hidden />
              فاتورة جديدة
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}