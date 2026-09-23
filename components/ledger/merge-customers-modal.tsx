"use client";

import { useState, useMemo } from "react";
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
  ArrowLeft,
  CheckCircle2,
  FileText,
  CreditCard,
  Building2,
  Phone,
  UserCheck,
  UserX,
} from "lucide-react";
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
}

interface MergeCustomersModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  customers: CustomerSummaryItem[];
  onSuccess?: () => void;
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
        description: `تم نقل ${data.repointedInvoicesCount ?? 0} فاتورة و${data.repointedPaymentsCount ?? 0} دفعة إلى حساب ${survivor.name}.`,
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
      <DialogContent dir="rtl" className="max-w-3xl sm:max-w-4xl text-right">
        <DialogHeader className="text-right">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-amber-100 text-amber-800">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-xl font-bold">دمج حسابات الزبائن المكررة</DialogTitle>
              <DialogDescription className="text-sm text-zinc-500 mt-1">
                نقل كافة الفواتير والدفعات من الحساب المكرر إلى الحساب الأساسي مع إيقاف الحساب المكرر نهائياً.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Selection Step */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 my-2">
          {/* Surviving Customer Picker */}
          <div className="space-y-2 p-3 rounded-lg border border-emerald-200 bg-emerald-50/50">
            <label className="text-sm font-semibold text-emerald-950 flex items-center gap-1.5">
              <UserCheck className="w-4 h-4 text-emerald-600" />
              1. الحساب الأساسي المستمر (Survivor)
            </label>
            <select
              aria-label="الحساب الأساسي المستمر"
              value={survivingCustomerId}
              onChange={(e) => {
                setSurvivingCustomerId(e.target.value);
                setIsConfirmed(false);
              }}
              className="w-full text-sm rounded-md border border-zinc-300 bg-white p-2.5 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
          <div className="space-y-2 p-3 rounded-lg border border-rose-200 bg-rose-50/50">
            <label className="text-sm font-semibold text-rose-950 flex items-center gap-1.5">
              <UserX className="w-4 h-4 text-rose-600" />
              2. الحساب المكرر المراد دمجه (To Merge & Deactivate)
            </label>
            <select
              aria-label="الحساب المكرر المراد دمجه"
              value={mergedCustomerId}
              onChange={(e) => {
                setMergedCustomerId(e.target.value);
                setIsConfirmed(false);
              }}
              className="w-full text-sm rounded-md border border-zinc-300 bg-white p-2.5 shadow-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
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
          <div className="border border-zinc-200 rounded-xl p-4 bg-zinc-50/80 space-y-4">
            <div className="flex items-center justify-between border-b pb-2">
              <h4 className="text-sm font-bold text-zinc-900 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                مقارنة تفصيلية قبل التأكيد
              </h4>
              <Badge variant="outline" className="text-xs">
                مراجعة إجبارية قبل التنفيذ
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Survivor Card */}
              <div className="bg-white rounded-lg border-2 border-emerald-300 p-3 shadow-sm space-y-2">
                <div className="flex items-center justify-between border-b pb-1.5">
                  <span className="font-bold text-emerald-800 text-sm">{survivor.name}</span>
                  <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white text-[10px]">
                    الحساب المستمر
                  </Badge>
                </div>

                <div className="space-y-1.5 text-xs text-zinc-600">
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-zinc-400" />
                    <span>الهاتف:</span>
                    <span className="font-mono font-medium text-zinc-900">
                      {survivor.phone || "غير محدد"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Building2 className="w-3.5 h-3.5 text-zinc-400" />
                    <span>المحل:</span>
                    <span className="font-medium text-zinc-900">
                      {survivor.shopName || "غير محدد"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CreditCard className="w-3.5 h-3.5 text-zinc-400" />
                    <span>رصيد الدين:</span>
                    <span className="font-bold text-emerald-700">
                      {formatMoney(survivor.cachedBalanceDebtSYP, "SYP")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-zinc-400" />
                    <span>عدد الفواتير:</span>
                    <span className="font-bold text-zinc-800">
                      {survivor.invoiceCount ?? 0}
                    </span>
                  </div>
                </div>
              </div>

              {/* Duplicate Card */}
              <div className="bg-white rounded-lg border-2 border-rose-300 p-3 shadow-sm space-y-2">
                <div className="flex items-center justify-between border-b pb-1.5">
                  <span className="font-bold text-rose-800 text-sm">{duplicate.name}</span>
                  <Badge variant="destructive" className="text-[10px]">
                    سيُلغى تنشيطه
                  </Badge>
                </div>

                <div className="space-y-1.5 text-xs text-zinc-600">
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-zinc-400" />
                    <span>الهاتف:</span>
                    <span className="font-mono font-medium text-zinc-900">
                      {duplicate.phone || "غير محدد"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Building2 className="w-3.5 h-3.5 text-zinc-400" />
                    <span>المحل:</span>
                    <span className="font-medium text-zinc-900">
                      {duplicate.shopName || "غير محدد"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CreditCard className="w-3.5 h-3.5 text-zinc-400" />
                    <span>رصيد الدين:</span>
                    <span className="font-bold text-rose-700">
                      {formatMoney(duplicate.cachedBalanceDebtSYP, "SYP")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-zinc-400" />
                    <span>عدد الفواتير:</span>
                    <span className="font-bold text-zinc-800">
                      {duplicate.invoiceCount ?? 0}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Mandatory Explicit Confirmation Checkbox */}
            <div className="pt-2 border-t flex items-start gap-3 bg-white p-3 rounded-lg border border-amber-200">
              <Checkbox
                id="merge-confirm-checkbox"
                checked={isConfirmed}
                onCheckedChange={(checked) => setIsConfirmed(Boolean(checked))}
                className="mt-0.5"
              />
              <label
                htmlFor="merge-confirm-checkbox"
                className="text-xs font-semibold text-zinc-800 leading-relaxed cursor-pointer"
              >
                أؤكد مراجعة بيانات الزبونين أعلاه، وأوافق على نقل كافة الفواتير والدفعات نهائياً إلى حساب{" "}
                <span className="text-emerald-700 font-bold underline">{survivor.name}</span> وإلغاء تنشيط حساب{" "}
                <span className="text-rose-700 font-bold underline">{duplicate.name}</span>.
              </label>
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between gap-2 border-t pt-3 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
            className="text-xs"
          >
            إلغاء
          </Button>

          <Button
            type="button"
            variant="default"
            disabled={!canSubmit}
            onClick={handleExecuteMerge}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4"
          >
            {isSubmitting ? "جارٍ تنفيذ الدمج..." : "تأكيد وتنفيذ دمج الحسابين"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
