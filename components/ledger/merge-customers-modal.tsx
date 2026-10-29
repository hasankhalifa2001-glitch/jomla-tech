"use client";

/**
 * [v4.5 — polish pass, presentation only] Header / scrolling body / footer
 * layout so the confirm button is never lost below the fold on a phone; the
 * two pickers and the side-by-side comparison stack on mobile (the comparison
 * was a forced 2-column grid before); the mandatory confirmation sits in an
 * amber card. State, the Survivor/Duplicate rules, the merge request and the
 * BroadcastChannel eviction are unchanged.
 *
 * [v6.1] The comparison cards also show how many balance adjustments
 * (previous debts / corrections) each account carries, and the copy and the
 * success toast mention them: a merge re-points those rows to the survivor
 * together with invoices and payments.
 *
 * NOTE: `sm:max-w-4xl` is deliberate — components/ui/dialog.tsx bakes in a
 * `sm:` max-width, and a bare `max-w-*` would lose to it in tailwind-merge.
 */

import { useState, useMemo, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Users,
  AlertTriangle,
  FileText,
  ClipboardList,
  CreditCard,
  Building2,
  Phone,
  UserCheck,
  UserX,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils/money";
import { broadcastCustomerMerged } from "@/lib/offline/customer-sync";
import { toast } from "sonner";

export interface CustomerSummaryItem {
  id: string;
  name: string;
  phone: string | null;
  shopName: string | null;
  cachedBalanceDebtSYP: string;
  cachedBalanceDebtUSD?: string;
  isSystemGenerated: boolean;
  invoiceCount?: number;
  paymentCount?: number;
  adjustmentCount?: number;
}

interface MergeCustomersModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  customers: CustomerSummaryItem[];
  onSuccess?: () => void;
}

const SELECT_CLASS =
  "h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-sm shadow-sm transition-shadow focus:outline-none focus:ring-2 sm:h-10";

/** One icon + label + value row of a comparison card. */
function InfoRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-zinc-400">{icon}</span>
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

function CompareCard({
  customer,
  tone,
  badge,
}: {
  customer: CustomerSummaryItem;
  tone: "keep" | "merge";
  badge: ReactNode;
}) {
  const keep = tone === "keep";
  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border-2 bg-white p-3.5 shadow-sm",
        keep ? "border-emerald-300" : "border-rose-300"
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-100 pb-2">
        <span
          className={cn("min-w-0 truncate text-sm font-extrabold", keep ? "text-emerald-800" : "text-rose-800")}
        >
          {customer.name}
        </span>
        {badge}
      </div>

      <div className="space-y-2 text-xs text-zinc-600">
        <InfoRow icon={<Phone className="size-3.5" aria-hidden />} label="الهاتف:">
          <span dir="ltr" className="font-mono font-semibold text-zinc-900 [unicode-bidi:isolate]">
            {customer.phone || "غير محدد"}
          </span>
        </InfoRow>
        <InfoRow icon={<Building2 className="size-3.5" aria-hidden />} label="المحل:">
          <span className="font-semibold text-zinc-900">{customer.shopName || "غير محدد"}</span>
        </InfoRow>
        <InfoRow icon={<CreditCard className="size-3.5" aria-hidden />} label="رصيد الدين:">
          <span className={cn("font-extrabold tabular-nums", keep ? "text-emerald-700" : "text-rose-700")}>
            {formatMoney(customer.cachedBalanceDebtSYP, "SYP")}
          </span>
        </InfoRow>
        <InfoRow icon={<FileText className="size-3.5" aria-hidden />} label="عدد الفواتير:">
          <span className="font-extrabold tabular-nums text-zinc-800">{customer.invoiceCount ?? 0}</span>
        </InfoRow>
        <InfoRow icon={<ClipboardList className="size-3.5" aria-hidden />} label="عدد تعديلات الرصيد:">
          <span className="font-extrabold tabular-nums text-zinc-800">{customer.adjustmentCount ?? 0}</span>
        </InfoRow>
      </div>
    </div>
  );
}

export function MergeCustomersModal({
  open,
  onOpenChange,
  tenantId,
  customers,
  onSuccess,
}: MergeCustomersModalProps) {
  const [survivingCustomerId, setSurvivingCustomerId] = useState<string>("");
  const [mergedCustomerId, setMergedCustomerId] = useState<string>("");
  const [isConfirmed, setIsConfirmed] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Eligible customers (exclude system-generated walk-in cash customer)
  const eligibleCustomers = useMemo(() => {
    return customers.filter((c) => !c.isSystemGenerated);
  }, [customers]);

  const survivor = useMemo(() => {
    return eligibleCustomers.find((c) => c.id === survivingCustomerId) || null;
  }, [eligibleCustomers, survivingCustomerId]);

  const duplicate = useMemo(() => {
    return eligibleCustomers.find((c) => c.id === mergedCustomerId) || null;
  }, [eligibleCustomers, mergedCustomerId]);

  // Reset state when closed
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setSurvivingCustomerId("");
      setMergedCustomerId("");
      setIsConfirmed(false);
      setError(null);
    }
    onOpenChange(newOpen);
  };

  const canSubmit = Boolean(
    survivor &&
    duplicate &&
    survivor.id !== duplicate.id &&
    isConfirmed &&
    !isSubmitting
  );

  async function handleExecuteMerge() {
    if (!survivor || !duplicate || survivor.id === duplicate.id || !isConfirmed) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/ledger/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          survivingCustomerId: survivor.id,
          mergedCustomerId: duplicate.id,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "فشلت عملية دمج الحسابات.");
      }

      // Live multi-tab cache eviction via BroadcastChannel
      await broadcastCustomerMerged(tenantId, duplicate.id, survivor.id);

      toast.success("تم دمج حسابات الزبائن بنجاح", {
        description: `تم نقل ${data.repointedInvoicesCount ?? 0} فاتورة و${data.repointedPaymentsCount ?? 0} دفعة و${data.repointedAdjustmentsCount ?? 0} تعديل رصيد إلى حساب ${survivor.name}.`,
      });

      handleOpenChange(false);
      onSuccess?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "حدث خطأ غير متوقع أثناء الدمج.";
      setError(msg);
      toast.error("خطأ أثناء الدمج", { description: msg });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        dir="rtl"
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl border-zinc-200 p-0 text-start sm:max-w-4xl [&>*]:min-w-0"
      >
        <DialogHeader className="gap-0 border-b border-zinc-100 bg-linear-to-b from-amber-50/70 to-white px-4 pb-3 pt-4 pe-14 text-start sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-800">
              <Users className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base font-extrabold text-zinc-900 sm:text-lg">
                دمج حسابات الزبائن المكررة
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                نقل كافة الفواتير والدفعات وتعديلات الرصيد (الديون السابقة) من الحساب المكرر إلى الحساب الأساسي مع إيقاف الحساب المكرر نهائياً.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {/* Selection Step */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* Surviving Customer Picker */}
            <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5">
              <label className="flex items-center gap-1.5 text-sm font-bold text-emerald-950">
                <UserCheck className="size-4 text-emerald-600" aria-hidden />
                1. الحساب الأساسي المستمر (Survivor)
              </label>
              <select
                aria-label="الحساب الأساسي المستمر"
                value={survivingCustomerId}
                onChange={(e) => {
                  setSurvivingCustomerId(e.target.value);
                  setIsConfirmed(false);
                }}
                className={cn(SELECT_CLASS, "focus:ring-emerald-500")}
              >
                <option value="">-- اختر الحساب الأساسي --</option>
                {eligibleCustomers.map((c) => (
                  <option
                    key={c.id}
                    value={c.id}
                    disabled={c.id === mergedCustomerId}
                  >
                    {c.name} {c.shopName ? `(${c.shopName})` : ""} {c.phone ? `- ${c.phone}` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-emerald-800">هذا الحساب سيبقى نشطاً وتُنقل إليه كل السجلات.</p>
            </div>

            {/* Merged Customer Picker */}
            <div className="space-y-2 rounded-xl border border-rose-200 bg-rose-50/50 p-3.5">
              <label className="flex items-center gap-1.5 text-sm font-bold text-rose-950">
                <UserX className="size-4 text-rose-600" aria-hidden />
                2. الحساب المكرر المراد دمجه (To Merge &amp; Deactivate)
              </label>
              <select
                aria-label="الحساب المكرر المراد دمجه"
                value={mergedCustomerId}
                onChange={(e) => {
                  setMergedCustomerId(e.target.value);
                  setIsConfirmed(false);
                }}
                className={cn(SELECT_CLASS, "focus:ring-rose-500")}
              >
                <option value="">-- اختر الحساب المكرر --</option>
                {eligibleCustomers.map((c) => (
                  <option
                    key={c.id}
                    value={c.id}
                    disabled={c.id === survivingCustomerId}
                  >
                    {c.name} {c.shopName ? `(${c.shopName})` : ""} {c.phone ? `- ${c.phone}` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-rose-800">سيتم إيقاف هذا الحساب وتحويل أي عمليات مستقبلية عنه.</p>
            </div>
          </div>

          {/* Side-by-Side Comparison Screen (Mandatory UX Gate) */}
          {survivor && duplicate && (
            <div className="space-y-4 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-4 motion-safe:animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-2.5">
                <h4 className="flex items-center gap-2 text-sm font-extrabold text-zinc-900">
                  <AlertTriangle className="size-4 text-amber-600" aria-hidden />
                  مقارنة تفصيلية قبل التأكيد
                </h4>
                <Badge variant="outline" className="border-amber-200 bg-amber-50 text-xs font-bold text-amber-800">
                  مراجعة إجبارية قبل التنفيذ
                </Badge>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <CompareCard
                  customer={survivor}
                  tone="keep"
                  badge={
                    <Badge className="shrink-0 bg-emerald-600 text-[10px] text-white hover:bg-emerald-600">
                      الحساب المستمر
                    </Badge>
                  }
                />
                <CompareCard
                  customer={duplicate}
                  tone="merge"
                  badge={
                    <Badge variant="destructive" className="shrink-0 text-[10px]">
                      سيُلغى تنشيطه
                    </Badge>
                  }
                />
              </div>

              {/* Mandatory Explicit Confirmation Checkbox */}
              <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-white p-3.5">
                <Checkbox
                  id="merge-confirm-checkbox"
                  checked={isConfirmed}
                  onCheckedChange={(checked) => setIsConfirmed(Boolean(checked))}
                  className="mt-0.5"
                />
                <label
                  htmlFor="merge-confirm-checkbox"
                  className="cursor-pointer text-xs font-semibold leading-relaxed text-zinc-800"
                >
                  أؤكد مراجعة بيانات الزبونين أعلاه، وأوافق على نقل كافة الفواتير والدفعات وتعديلات الرصيد نهائياً إلى حساب{" "}
                  <span className="font-bold text-emerald-700 underline">{survivor.name}</span> وإلغاء تنشيط حساب{" "}
                  <span className="font-bold text-rose-700 underline">{duplicate.name}</span>.
                </label>
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700"
            >
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 border-t border-zinc-100 bg-white px-4 py-3 sm:justify-between sm:px-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
            className="h-11 w-full rounded-xl text-xs font-bold transition-transform active:scale-[0.98] sm:h-10 sm:w-auto sm:px-6"
          >
            إلغاء
          </Button>

          <Button
            type="button"
            variant="default"
            disabled={!canSubmit}
            onClick={handleExecuteMerge}
            className="h-11 w-full gap-1.5 rounded-xl bg-emerald-600 text-xs font-bold text-white shadow-sm shadow-emerald-600/25 transition-all hover:bg-emerald-700 active:scale-[0.98] sm:h-10 sm:w-auto sm:px-6"
          >
            {isSubmitting && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {isSubmitting ? "جارٍ تنفيذ الدمج..." : "تأكيد وتنفيذ دمج الحسابين"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}