"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Users, Search, RefreshCw, AlertCircle, BookOpen, X, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MergeCustomersModal, type CustomerSummaryItem } from "./merge-customers-modal";
import { usePendingRepaymentTotals, useFailedOfflineRepayments } from "@/lib/offline/pending-offline-payments";
import { CustomerCard, type RepaymentAppliedResult } from "./customer-card";

interface LedgerClientProps {
  tenantId: string;
  isAdmin: boolean;
}

/**
 * URL of the ADMIN-only previous-debts entry screen. It is a sibling folder of
 * the existing ledger page (app/(dashboard)/ledger/previous-debts), so its URL
 * is "<ledger URL>/previous-debts". Route groups such as (dashboard) never
 * appear in a URL, so with the ledger at app/(dashboard)/ledger/page.tsx this
 * is "/ledger/previous-debts". If the real ledger URL differs (a rewrite, a
 * basePath, or a "/dashboard" prefix), change ONLY this constant.
 * The page itself rejects a CASHIER server-side; this button is just the
 * entry point and is absent (not disabled) for a CASHIER.
 */
const PREVIOUS_DEBTS_HREF = "/ledger/previous-debts";

/**
 * [v4.5 — polish pass, presentation only] Gradient icon tile header, a search
 * field with a clear button and a count pill, mirrored skeleton cards while
 * loading, a retryable error banner, and a light staggered entrance for the
 * cards. Every fetch, state transition and prop passed to CustomerCard /
 * MergeCustomersModal below is unchanged.
 *
 * [v6.1] The ADMIN-only "إضافة ديون سابقة" button lives in the header next to
 * the merge button (both are ADMIN-only management actions) and navigates
 * client-side with next/link. This component remounts on every visit, so the
 * initial fetch below always shows balances that include a debt that was just
 * entered on the previous-debts screen.
 */

/** Gentle entrance; the delay is capped so long lists don't feel slow. */
const CARD_ENTER =
  "motion-safe:animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-backwards";
const cardStyle = (i: number) => ({ animationDelay: `${Math.min(i, 8) * 50}ms` });

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

/** Placeholder card that mirrors CustomerCard's rough silhouette. */
function CardSkeleton() {
  return (
    <div className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-4" aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-10 w-full rounded-xl" />
    </div>
  );
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
    <div dir="rtl" className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col items-stretch justify-between gap-4 border-b border-zinc-100 pb-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-linear-to-br from-emerald-500 to-emerald-700 text-white shadow-sm shadow-emerald-600/25">
            <BookOpen className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-zinc-900 sm:text-2xl">دفتر الديون</h1>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 sm:text-sm">
              تتبع ديون العملاء وسجل الدفعات غير القابل للتعديل وإدارة الحسابات.
            </p>
          </div>
        </div>

        {/* flex-wrap: with two ADMIN buttons + the refresh icon, a 375px screen
            wraps them onto a second line instead of overflowing. */}
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Button
              asChild
              className="h-10 flex-1 gap-2 rounded-xl bg-emerald-600 text-sm font-bold text-white shadow-sm shadow-emerald-600/25 transition-all hover:bg-emerald-700 active:scale-[0.98] sm:flex-none"
            >
              <Link href={PREVIOUS_DEBTS_HREF}>
                <PlusCircle className="size-4" aria-hidden />
                <span>إضافة ديون سابقة</span>
              </Link>
            </Button>
          )}

          {isAdmin && (
            <Button
              variant="default"
              onClick={() => setIsMergeModalOpen(true)}
              className="h-10 flex-1 gap-2 rounded-xl bg-zinc-900 text-sm font-bold text-white transition-all hover:bg-zinc-800 active:scale-[0.98] sm:flex-none"
            >
              <Users className="size-4" aria-hidden />
              <span>دمج حسابات مكررة</span>
            </Button>
          )}

          <Button
            variant="outline"
            size="icon"
            onClick={fetchCustomers}
            disabled={isLoading}
            title="تحديث البيانات"
            aria-label="تحديث البيانات"
            className="size-10 shrink-0 rounded-xl border-zinc-200 text-zinc-600 transition-all hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 active:scale-95"
          >
            <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search
            className="pointer-events-none absolute inset-e-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400"
            aria-hidden
          />
          <Input
            placeholder="البحث بالاسم، المحل، أو رقم الهاتف..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-11 rounded-xl border-zinc-200 pe-10 ps-10 text-sm transition-shadow focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20 sm:h-10"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label="مسح البحث"
              className="absolute inset-s-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-bold text-zinc-600">
          إجمالي الزبائن
          <span className="tabular-nums text-emerald-700">{filteredCustomers.length}</span>
        </span>
      </div>

      {/* Error state */}
      {fetchError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700 motion-safe:animate-in fade-in slide-in-from-top-1 duration-200"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 font-semibold">{fetchError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={fetchCustomers}
            disabled={isLoading}
            className="h-8 gap-1.5 rounded-lg border-red-200 bg-white text-xs font-bold text-red-700 hover:bg-red-50"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            إعادة المحاولة
          </Button>
        </div>
      )}

      {/* Customers List / Grid */}
      {isLoading ? (
        <div role="status" aria-label="جارٍ تحميل بيانات دفتر الديون">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      ) : filteredCustomers.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-zinc-200 bg-zinc-50/40 px-4 py-14 text-center motion-safe:animate-in fade-in duration-300">
          <div className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-white text-zinc-300 ring-1 ring-zinc-200">
            <Users className="size-7" aria-hidden />
          </div>
          <p className="text-sm font-bold text-zinc-700">لا يوجد زبائن مطابقين</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            لم يتم العثور على أي زبون بناءً على معايير البحث الحالية.
          </p>
          {searchQuery && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSearchQuery("")}
              className="mt-4 h-9 rounded-xl text-xs font-bold"
            >
              مسح البحث
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredCustomers.map((customer, i) => (
            <div key={customer.id} style={cardStyle(i)} className={`min-w-0 ${CARD_ENTER}`}>
              <CustomerCard
                tenantId={tenantId}
                customer={customer}
                isAdmin={isAdmin}
                pendingRepaymentSYP={pendingRepaymentTotals[customer.id]}
                failedRepayments={failedRepayments.filter((row) => row.customerId === customer.id)}
                onRepaymentApplied={handleRepaymentApplied}
              />
            </div>
          ))}
        </div>
      )}

      {/* Customer Merge Confirmation Modal.
          `customers` is passed whole, so each item's adjustmentCount (from
          GET /api/customers) reaches the comparison cards unchanged. */}
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