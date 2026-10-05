"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Users, Search, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MergeCustomersModal, type CustomerSummaryItem } from "./merge-customers-modal";
import { usePendingRepaymentTotals, useFailedOfflineRepayments } from "@/lib/offline/pending-offline-payments";
import { CustomerCard, type RepaymentAppliedResult } from "./customer-card";

interface LedgerClientProps {
  tenantId: string;
  isAdmin: boolean;
}

/**
 * Pure network helper: no React state is touched here, so it can be called from
 * an effect without triggering a synchronous setState.
 */
async function requestCustomers(): Promise<CustomerSummaryItem[]> {
  const res = await fetch("/api/customers");
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.message || "فشل جلب قائمة الزبائن.");
  }
  return data.customers || [];
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "حدث خطأ أثناء تحميل البيانات.";
}

export function LedgerClient({ tenantId, isAdmin }: LedgerClientProps) {
  const [customers, setCustomers] = useState<CustomerSummaryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isMergeModalOpen, setIsMergeModalOpen] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Live view of repayments queued on this device but not yet synced (Dexie).
  const pendingRepaymentTotals = usePendingRepaymentTotals(tenantId);
  const failedRepayments = useFailedOfflineRepayments(tenantId);

  /**
   * T4e — in-place balance update after a repayment: the modal hands back the
   * server-computed balance (online) or the locally computed balance − amount
   * (offline; the same arithmetic the server re-derives at sync time), so the
   * card re-renders immediately without a refetch. The secondary USD figure is
   * cleared rather than left stale; the next /api/customers fetch restores it.
   */
  const handleRepaymentApplied = useCallback((result: RepaymentAppliedResult) => {
    setCustomers((prev) =>
      prev.map((c) =>
        c.id === result.customerId
          ? { ...c, cachedBalanceDebtSYP: result.balanceSYP, cachedBalanceDebtUSD: undefined }
          : c
      )
    );
  }, []);

  /**
   * Manual refresh (refresh button, merge modal onSuccess). Called from event
   * handlers only, so setting the loading state synchronously here is fine.
   */
  const fetchCustomers = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      setCustomers(await requestCustomers());
    } catch (err) {
      setFetchError(toErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load. `isLoading` already starts as true and `fetchError` as null,
  // so nothing needs to be set synchronously: state is only updated from the
  // async callbacks below. `cancelled` guards against unmount / StrictMode's
  // double-invoked effect.
  useEffect(() => {
    let cancelled = false;
    requestCustomers()
      .then((list) => {
        if (!cancelled) setCustomers(list);
      })
      .catch((err) => {
        if (!cancelled) setFetchError(toErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredCustomers = useMemo(() => {
    if (!searchQuery.trim()) return customers;
    const q = searchQuery.trim().toLowerCase();
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.phone && c.phone.includes(q)) ||
        (c.shopName && c.shopName.toLowerCase().includes(q))
    );
  }, [customers, searchQuery]);

  return (
    <div dir="rtl" className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">دفتر الديون</h1>
          <p className="mt-1 text-sm text-zinc-600">
            تتبع ديون العملاء وسجل الدفعات غير القابل للتعديل وإدارة الحسابات.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button
              variant="default"
              onClick={() => setIsMergeModalOpen(true)}
              className="bg-zinc-900 hover:bg-zinc-800 text-white flex items-center gap-2 text-sm"
            >
              <Users className="w-4 h-4" />
              <span>دمج حسابات مكررة</span>
            </Button>
          )}

          <Button
            variant="outline"
            size="icon"
            onClick={fetchCustomers}
            disabled={isLoading}
            title="تحديث البيانات"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input
            placeholder="البحث بالاسم، المحل، أو رقم الهاتف..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pr-9 text-sm"
          />
        </div>
        <span className="text-xs text-zinc-500">
          إجمالي الزبائن: {filteredCustomers.length}
        </span>
      </div>

      {/* Error state */}
      {fetchError && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{fetchError}</span>
        </div>
      )}

      {/* Customers List / Grid */}
      {isLoading ? (
        <div className="p-8 text-center text-sm text-zinc-500">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-zinc-400" />
          جارٍ تحميل بيانات دفتر الديون...
        </div>
      ) : filteredCustomers.length === 0 ? (
        <div className="p-12 text-center border-2 border-dashed border-zinc-200 rounded-xl">
          <Users className="w-10 h-10 mx-auto text-zinc-300 mb-2" />
          <p className="text-sm font-medium text-zinc-600">لا يوجد زبائن مطابقين</p>
          <p className="text-xs text-zinc-400 mt-1">
            لم يتم العثور على أي زبون بناءً على معايير البحث الحالية.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCustomers.map((customer) => (
            <CustomerCard
              key={customer.id}
              tenantId={tenantId}
              customer={customer}
              isAdmin={isAdmin}
              pendingRepaymentSYP={pendingRepaymentTotals[customer.id]}
              failedRepayments={failedRepayments.filter((row) => row.customerId === customer.id)}
              onRepaymentApplied={handleRepaymentApplied}
            />
          ))}
        </div>
      )}

      {/* Customer Merge Confirmation Modal */}
      {isAdmin && (
        <MergeCustomersModal
          open={isMergeModalOpen}
          onOpenChange={setIsMergeModalOpen}
          tenantId={tenantId}
          customers={customers}
          onSuccess={fetchCustomers}
        />
      )}
    </div>
  );
}