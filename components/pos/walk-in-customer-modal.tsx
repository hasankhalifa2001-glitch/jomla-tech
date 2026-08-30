"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Search, UserPlus, Users, UserCheck, Phone, Store, AlertCircle } from "lucide-react";
import {
  getOfflineCustomers,
  createOfflineWalkInCustomer,
  type SelectedCustomer,
} from "@/lib/offline";

interface WalkInCustomerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCustomer: SelectedCustomer | null;
  onSelectCustomer: (customer: SelectedCustomer | null) => void;
}

export function WalkInCustomerModal({
  open,
  onOpenChange,
  selectedCustomer,
  onSelectCustomer,
}: WalkInCustomerModalProps) {
  const [tab, setTab] = useState<"existing" | "new">("existing");
  const [searchQuery, setSearchQuery] = useState("");
  const [customers, setCustomers] = useState<SelectedCustomer[]>([]);
  const [loading, setLoading] = useState(false);

  // New Walk-in form fields
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [shopName, setShopName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      loadCustomers(searchQuery);
      setFormError(null);
    }
  }, [open, searchQuery]);

  async function loadCustomers(query: string) {
    setLoading(true);
    try {
      const list = await getOfflineCustomers(query);
      setCustomers(list);
    } catch (err) {
      console.error("Failed to load customers from Dexie:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateWalkIn(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("يرجى إدخال اسم الزبون.");
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      const newCustomer = await createOfflineWalkInCustomer({
        name: name.trim(),
        phone: phone.trim() || undefined,
        shopName: shopName.trim() || undefined,
      });

      onSelectCustomer(newCustomer);
      setName("");
      setPhone("");
      setShopName("");
      onOpenChange(false);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "فشل إنشاء الزبون محلياً");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-bold text-zinc-900 dark:text-zinc-100">
            <Users className="h-5 w-5 text-emerald-600" />
            تحديد أو تسجيل الزبون
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            اختر زبوناً مسجلاً من الذاكرة المحلية أو سجل زبوناً نقدياً / مؤقتاً جديداً فوراً بدون مغادرة البيع.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "existing" | "new")} className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="existing" className="text-xs">
              <Users className="ml-1.5 h-3.5 w-3.5" />
              الزبائن المسجلون ({customers.length})
            </TabsTrigger>
            <TabsTrigger value="new" className="text-xs">
              <UserPlus className="ml-1.5 h-3.5 w-3.5" />
              تسجيل زبون جديد (سريع)
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: Existing Customers & Cash Walk-in */}
          <TabsContent value="existing" className="space-y-3 mt-3">
            {/* Quick General Walk-in Cash Option */}
            <div
              onClick={() => {
                onSelectCustomer(null);
                onOpenChange(false);
              }}
              className={`cursor-pointer rounded-xl border p-3 transition-all flex items-center justify-between ${
                !selectedCustomer
                  ? "border-emerald-600 bg-emerald-50/70 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200"
                  : "border-zinc-200 bg-zinc-50/50 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:bg-zinc-800"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                  <UserCheck className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-bold">زبون نقدي عام (بدون تسجيل حساب)</p>
                  <p className="text-[11px] text-zinc-500">مناسب للمبيعات النقدية الفورية المباشرة</p>
                </div>
              </div>
              {!selectedCustomer && (
                <Badge className="bg-emerald-600 text-[10px]">محدد حالياً</Badge>
              )}
            </div>

            {/* Search Input */}
            <div className="relative">
              <Search className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
              <Input
                placeholder="ابحث بالاسم، المحل، أو الهاتف..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pr-9 text-xs"
              />
            </div>

            {/* Customers List */}
            <div className="max-h-60 overflow-y-auto space-y-2 pr-0.5">
              {loading ? (
                <p className="text-center py-4 text-xs text-zinc-400">جاري قراءة البيانات المحلية...</p>
              ) : customers.length === 0 ? (
                <div className="text-center py-6 text-xs text-zinc-400">
                  لا يوجد زبائن يطابقون البحث في الذاكرة المحلية.
                </div>
              ) : (
                customers.map((c) => {
                  const isSelected = selectedCustomer?.id === c.id;
                  return (
                    <div
                      key={c.id}
                      onClick={() => {
                        onSelectCustomer(c);
                        onOpenChange(false);
                      }}
                      className={`cursor-pointer rounded-lg border p-2.5 transition-all flex items-center justify-between ${
                        isSelected
                          ? "border-emerald-600 bg-emerald-50/60 dark:bg-emerald-950/40"
                          : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                      }`}
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                            {c.name}
                          </span>
                          {c.type === "WALK_IN" && (
                            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/50">
                              محلي جديد
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                          {c.shopName && (
                            <span className="flex items-center gap-1">
                              <Store className="h-3 w-3" />
                              {c.shopName}
                            </span>
                          )}
                          {c.phone && (
                            <span className="flex items-center gap-1">
                              <Phone className="h-3 w-3" />
                              {c.phone}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-left">
                        {c.balanceDebtUSD !== undefined && c.balanceDebtUSD > 0 ? (
                          <div className="text-right">
                            <span className="text-[10px] text-zinc-400 block">الدين الحالي</span>
                            <span className="text-xs font-bold text-red-600 dark:text-red-400">
                              ${c.balanceDebtUSD.toFixed(2)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[11px] text-emerald-600">لا يوجد ديون</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </TabsContent>

          {/* TAB 2: Inline Walk-in Creation */}
          <TabsContent value="new" className="mt-3">
            <form onSubmit={handleCreateWalkIn} className="space-y-3">
              {formError && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300 border border-red-200">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="cust-name" className="text-xs font-semibold">
                  اسم الزبون <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="cust-name"
                  placeholder="مثال: أحمد عبد الله / بقالية السلام"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="text-xs"
                  autoFocus
                  required
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="cust-phone" className="text-xs font-semibold">
                  رقم الهاتف (اختياري)
                </Label>
                <Input
                  id="cust-phone"
                  placeholder="مثال: 0991234567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="cust-shop" className="text-xs font-semibold">
                  اسم المحل أو العنوان (اختياري)
                </Label>
                <Input
                  id="cust-shop"
                  placeholder="مثال: دمشق - الميدان"
                  value={shopName}
                  onChange={(e) => setShopName(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div className="rounded-lg bg-zinc-50 p-2.5 text-[11px] text-zinc-500 border border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800">
                💡 سيتم حفظ الزبون محلياً في قاعدة بيانات المتصفح وإرفاقه فوراً بهذه الفاتورة مع توليد معرف UUID فريد.
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  className="text-xs"
                >
                  إلغاء
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isSubmitting || !name.trim()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold"
                >
                  {isSubmitting ? "جاري الحفظ..." : "حفظ واختيار الزبون"}
                </Button>
              </div>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
