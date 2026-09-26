"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { formatMoney, compareMoney, multiplyMoney } from "@/lib/utils/money";
import { ReceiptActions } from "@/components/receipts/receipt-actions";
import {
  buildLocalReceiptSource,
  itemNamesFromCartLines,
} from "@/lib/receipts/local-receipt-source";
import type { LocalReceiptSource } from "@/lib/receipts/receipt-model";

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
      <DialogContent
        className="sm:max-w-xl max-h-[90vh] overflow-y-auto"
        dir="rtl"
      >
        <DialogHeader>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-600 mb-2">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <DialogTitle className="text-center text-lg font-bold text-zinc-900 dark:text-zinc-100">
            تم حفظ الفاتورة محلياً بنجاح
          </DialogTitle>
          <DialogDescription className="text-center text-xs text-zinc-500">
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
          <div className="rounded-xl border border-emerald-300 bg-emerald-50/80 p-3 dark:border-emerald-900 dark:bg-emerald-950/40 space-y-1.5">
            <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 font-bold text-xs">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
              <span>تمت مزامنة الفاتورة مع السيرفر بنجاح</span>
            </div>
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 leading-relaxed">
              الفاتورة أصبحت مسجّلة على السيرفر المركزي، وزر مشاركة الإيصال
              (PDF) متاح الآن.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-300 bg-amber-50/80 p-3 dark:border-amber-900 dark:bg-amber-950/40 space-y-1.5">
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-bold text-xs">
              <CloudOff className="h-4 w-4 shrink-0 text-amber-600" />
              <span>حالة الفاتورة: محفوظة محلياً — بانتظار المزامنة (PENDING)</span>
            </div>
            <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
              ⚠️ تنبيه للكاشير: هذه الفاتورة{" "}
              <strong>مخزنة على هذا الجهاز فقط</strong> حالياً. ستتم المزامنة
              التلقائية مع السيرفر المركزي فور توفر اتصال بالإنترنت (T4c).
            </p>
          </div>
        )}

        {/* Invoice Summary Printable Card */}
        <div
          id="printable-receipt"
          className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 space-y-3 dark:border-zinc-800 dark:bg-zinc-900/60 text-xs"
        >
          {/* Top metadata */}
          <div className="grid grid-cols-2 gap-2 border-b border-zinc-200 pb-2.5 dark:border-zinc-800">
            <div>
              <span className="text-[10px] text-zinc-400 block">
                رقم الفاتورة المحلي (UUID)
              </span>
              <span className="font-mono text-[11px] font-bold text-zinc-800 dark:text-zinc-200 truncate block">
                {invoice.offlineId}
              </span>
            </div>

            <div className="text-left">
              <span className="text-[10px] text-zinc-400 block">
                التاريخ والوقت
              </span>
              <span className="text-[11px] text-zinc-600 dark:text-zinc-400 flex items-center justify-end gap-1">
                <Calendar className="h-3 w-3" />
                {new Date(invoice.createdAt).toLocaleTimeString("ar-SY", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <div>
              <span className="text-[10px] text-zinc-400 block">الزبون</span>
              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 flex items-center gap-1">
                <User className="h-3 w-3 text-zinc-400" />
                {customer ? customer.name : "زبون نقدي عام"}
              </span>
            </div>

            <div className="text-left">
              <span className="text-[10px] text-zinc-400 block">
                طريقة السداد
              </span>
              <Badge variant="outline" className="text-[10px] font-semibold">
                {paymentLabel}
              </Badge>
            </div>
          </div>

          {/* Items Summary Table */}
          <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
            <div className="grid grid-cols-12 text-[10px] font-bold text-zinc-400 pb-1 border-b border-zinc-200 dark:border-zinc-800">
              <span className="col-span-6">الصنف / الوحدة</span>
              <span className="col-span-2 text-center">الكمية</span>
              <span className="col-span-4 text-left">الإجمالي</span>
            </div>

            {items.map((item, idx) => {
              // [v3.6] FIX — was `multiplyMoney(item.unitPriceUSD, ...)`.
              // item.unitPriceUSD is `string | null` on CartLineItem
              // (pos-service.ts) — it is only ever null when the item was
              // added to the cart with no exchange rate cached yet. Calling
              // multiplyMoney on `null` throws a MoneyError inside
              // money.ts's toDecimal(), which would have crashed this
              // entire modal the moment such an item appeared in a
              // completed sale. item.unitPriceSYP is the always-present,
              // authoritative field and is used for the actual line total.
              //
              // [FIX — SYP-only] The USD line total (lineUSD) is no longer
              // computed at all — per product decision, no "≈ $X" appears
              // anywhere in this modal (matches receipt-model.ts's own fix
              // for the printed/shared receipt).
              const lineSYP = multiplyMoney(item.unitPriceSYP, item.quantity);
              return (
                <div
                  key={idx}
                  className="grid grid-cols-12 text-xs py-1 border-b border-zinc-100 dark:border-zinc-850"
                >
                  <div className="col-span-6 truncate">
                    <p className="font-semibold text-zinc-800 dark:text-zinc-200">
                      {item.product.name}
                    </p>
                    <p className="text-[10px] text-zinc-400">{item.unitName}</p>
                  </div>
                  <span className="col-span-2 text-center font-mono">
                    {item.quantity}
                  </span>
                  <div className="col-span-4 text-left font-mono">
                    <p className="font-bold text-zinc-800 dark:text-zinc-200">
                      {formatMoney(lineSYP, "SYP")} ل.س
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/*
            Financial Totals.
            [FIX — SYP-only] Per product decision, the "(≈ $X)" secondary
            USD figure is removed entirely from every row below (total,
            paid, debt). The exchange-rate row is kept — it is a reference
            rate, not a converted amount.
          */}
          <div className="space-y-1 pt-2 border-t border-zinc-200 dark:border-zinc-800">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-zinc-600 dark:text-zinc-400">
                إجمالي الفاتورة:
              </span>
              <span className="text-emerald-700 dark:text-emerald-400 font-extrabold font-mono">
                {formatMoney(invoice.totalSYP, "SYP")} ل.س
              </span>
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">سعر الصرف المعتمد:</span>
              <span className="font-mono text-zinc-600 dark:text-zinc-400">
                {invoice.exchangeRateUsed !== null
                  ? `${formatMoney(invoice.exchangeRateUsed, "SYP")} ل.س / $`
                  : "—"}
              </span>
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">المبلغ المدفوع:</span>
              <span className="font-bold text-emerald-600 font-mono">
                {formatMoney(invoice.paidAmountSYP, "SYP")} ل.س
              </span>
            </div>

            {isDebtPresent && (
              <div className="flex justify-between text-xs font-bold text-red-600 dark:text-red-400">
                <span>المتبقي على الحساب (دين):</span>
                <span className="font-mono">
                  {formatMoney(invoice.debtAmountSYP, "SYP")} ل.س
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="space-y-2 pt-2">
          {/*
            [T4f] Thermal ESC/POS printing (Web Bluetooth) + the gated PDF share.

            [FIX] `source` is now a THUNK (buildCurrentReceiptSource), not a
            static object — see that function's own comment above for why a
            static object silently baked in a stale PENDING status even
            after sync completed. receipt-actions.tsx already supports and
            calls a thunk-shaped `source` at print/share TIME.
          */}
          <ReceiptActions
            source={buildCurrentReceiptSource}
            offlineId={invoice.offlineId}
            serverInvoiceId={invoice.serverId ?? null}
            size="sm"
            onPrinterSetupRequired={onPrinterSetupRequired}
          />

          {/*
            [FIX] Responsive — was a fixed flex-row that squeezed both
            buttons onto one cramped line at 375px width (iPhone SE). Now
            stacks vertically on narrow screens, back to a row from sm: up.
          */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePrint}
              className="text-xs gap-1.5 w-full sm:w-auto"
              title="طباعة الإيصال عبر نافذة المتصفح — بديل عند عدم دعم Web Bluetooth (مثل iOS)"
            >
              <Printer className="h-4 w-4" />
              طباعة من المتصفح
            </Button>

            <Button
              type="button"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onStartNewSale();
              }}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold gap-1.5 px-6 w-full sm:w-auto"
            >
              <PlusCircle className="h-4 w-4" />
              فاتورة جديدة (جديد)
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}