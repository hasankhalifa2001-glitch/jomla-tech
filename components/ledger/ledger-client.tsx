"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Users,
  Search,
  RefreshCw,
  CreditCard,
  Building2,
  Phone,
  FileText,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils/money";
import { MergeCustomersModal, type CustomerSummaryItem } from "./merge-customers-modal";

interface LedgerClientProps {
  tenantId: string;
  isAdmin: boolean;
}

export function LedgerClient({ tenantId, isAdmin }: LedgerClientProps) {
  const [customers, setCustomers] = useState<CustomerSummaryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isMergeModalOpen, setIsMergeModalOpen] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchCustomers = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/customers");
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || "فشل جلب قائمة الزبائن.");
      }
      setCustomers(data.customers || []);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "حدث خطأ أثناء تحميل البيانات.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCustomers();
  }, [fetchCustomers]);

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
          {filteredCustomers.map((customer) => {
            const hasDebt = parseFloat(customer.cachedBalanceDebtSYP || "0") > 0;
            return (
              <div
                key={customer.id}
                className="bg-white border rounded-xl p-4 shadow-sm hover:shadow transition-shadow flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 border-b pb-2 mb-3">
                    <div>
                      <h3 className="font-bold text-zinc-900 text-base">{customer.name}</h3>
                      {customer.shopName && (
                        <p className="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                          <Building2 className="w-3.5 h-3.5 text-zinc-400" />
                          <span>{customer.shopName}</span>
                        </p>
                      )}
                    </div>

                    {customer.isSystemGenerated ? (
                      <Badge variant="secondary" className="text-[10px]">
                        نقدي عام
                      </Badge>
                    ) : hasDebt ? (
                      <Badge variant="destructive" className="text-[10px]">
                        مدين
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-emerald-700 bg-emerald-50 border-emerald-200">
                        مستوفى
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-1.5 text-xs text-zinc-600 mb-3">
                    {customer.phone && (
                      <div className="flex items-center gap-1.5">
                        <Phone className="w-3.5 h-3.5 text-zinc-400" />
                        <span className="font-mono text-zinc-800">{customer.phone}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-zinc-400" />
                      <span>عدد الفواتير:</span>
                      <span className="font-semibold text-zinc-800">
                        {customer.invoiceCount ?? (customer.isSystemGenerated ? 0 : 0)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t flex items-center justify-between">
                  <span className="text-xs text-zinc-500 flex items-center gap-1">
                    <CreditCard className="w-3.5 h-3.5 text-zinc-400" />
                    الرصيد:
                  </span>
                  <div className="text-left font-bold text-sm">
                    <span className={hasDebt ? "text-rose-700" : "text-emerald-700"}>
                      {formatMoney(customer.cachedBalanceDebtSYP, "SYP")}
                    </span>
                    {customer.cachedBalanceDebtUSD && (
                      <span className="block text-[11px] font-normal text-zinc-400">
                        ≈ {formatMoney(customer.cachedBalanceDebtUSD, "USD")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
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
