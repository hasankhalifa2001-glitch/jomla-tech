"use client";

import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
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
import {
  Search,
  UserPlus,
  Users,
  UserCheck,
  Phone,
  Store,
  AlertCircle,
  AlertTriangle,
  Check,
} from "lucide-react";
import {
  getOfflineCustomers,
  createOfflineWalkInCustomer,
  findMatchingCustomerByPhone,
  getSystemCashCustomer,
  isSystemCashCustomer,
  normalizeCustomerPhone,
  type SelectedCustomer,
  type DuplicatePhoneMatch,
} from "@/lib/offline";

interface WalkInCustomerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCustomer: SelectedCustomer | null;
  onSelectCustomer: (customer: SelectedCustomer | null) => void;
  tenantId?: string;
  allowSystemCustomer?: boolean;
}

export function WalkInCustomerModal({
  open,
  onOpenChange,
  selectedCustomer,
  onSelectCustomer,
  tenantId,
  allowSystemCustomer = true,
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

  // [v3.4] Soft Duplicate-Phone Check state
  const [duplicateMatch, setDuplicateMatch] = useState<DuplicatePhoneMatch | null>(null);
  const [ignoredDuplicatePhone, setIgnoredDuplicatePhone] = useState<string | null>(null);
  const [isCheckingPhone, setIsCheckingPhone] = useState(false);
  const phoneDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // [FIX] Centralized helper so every close/success path clears the same
  // way — a bare `clearTimeout` call site can't accidentally forget to
  // also null out the ref (leaving a stale, already-fired timer handle
  // behind), and any future call site added later gets the same guarantee
  // for free instead of having to remember both steps itself.
  const clearPhoneDebounce = useCallback(() => {
    if (phoneDebounceRef.current) {
      clearTimeout(phoneDebounceRef.current);
      phoneDebounceRef.current = null;
    }
  }, []);

  const loadCustomers = useCallback(
    async (query: string) => {
      setLoading(true);
      try {
        const list = await getOfflineCustomers(tenantId, query);
        setCustomers(list);
      } catch (err) {
        console.error("Failed to load customers from Dexie:", err);
      } finally {
        setLoading(false);
      }
    },
    [tenantId]
  );

  // [FIX] `loadCustomers` is async and calls `setLoading(true)` as its very
  // first statement — that runs SYNCHRONOUSLY (before any `await`), which
  // means calling it directly here executes a setState call synchronously
  // within this effect's body. React flags that ("Calling setState
  // synchronously within an effect can trigger cascading renders") because
  // an effect is meant to either update an external system or subscribe to
  // one and setState from ITS callback — not setState directly, inline,
  // during the effect's own execution. Deferring via `setTimeout(0)` moves
  // the call into a macrotask callback (an "external system" callback, in
  // the same sense a subscription callback would be), which is the pattern
  // React's effect model expects, and gives the same next-tick behavior
  // without changing when the fetch actually happens from the user's
  // perspective. The `cleared` guard prevents a call to `loadCustomers` (and
  // therefore setState) after the effect has already been cleaned up — e.g.
  // `open`/`searchQuery` changing again, or the modal unmounting, before the
  // deferred callback fires.
  useEffect(() => {
    if (!open) return;
    let cleared = false;
    const timeoutId = setTimeout(() => {
      if (!cleared) {
        void loadCustomers(searchQuery);
      }
    }, 0);
    return () => {
      cleared = true;
      clearTimeout(timeoutId);
    };
  }, [open, searchQuery, loadCustomers]);

  // [FIX] Clears any pending debounced phone-check timer on unmount (e.g.
  // the modal's parent unmounts while the 250ms debounce from the last
  // keystroke is still pending) — without this, the timer's callback can
  // still fire after unmount and call setDuplicateMatch/setIsCheckingPhone
  // on a component that's gone, producing a React "state update on an
  // unmounted component" warning (and, in edge cases, a leaked timer).
  useEffect(() => {
    return () => {
      clearPhoneDebounce();
    };
  }, [clearPhoneDebounce]);

  // [FIX] Covers the dialog-chrome close path (X button, outside click,
  // Escape) — the ONLY path that actually routes through this wrapper.
  // Success paths below (handleCreateWalkIn, handleAcceptDuplicate) call
  // the `onOpenChange` prop directly rather than this wrapper, so each of
  // those also clears the timer itself — see the [FIX] notes there. All
  // three call sites are necessary; none of them is redundant with the
  // others.
  function handleDialogOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      clearPhoneDebounce();
      setFormError(null);
      setDuplicateMatch(null);
      setIgnoredDuplicatePhone(null);
    }
    onOpenChange(nextOpen);
  }

  // Soft duplicate-phone check on phone input change
  function handlePhoneChange(newPhone: string) {
    setPhone(newPhone);
    setDuplicateMatch(null);

    clearPhoneDebounce();

    const trimmed = newPhone.trim();
    if (
      !trimmed ||
      trimmed.length < 4 ||
      (ignoredDuplicatePhone &&
        normalizeCustomerPhone(trimmed) === normalizeCustomerPhone(ignoredDuplicatePhone))
    ) {
      return;
    }

    phoneDebounceRef.current = setTimeout(async () => {
      setIsCheckingPhone(true);
      try {
        const match = await findMatchingCustomerByPhone(tenantId, trimmed);
        if (
          match &&
          match.customer.phone &&
          normalizeCustomerPhone(match.customer.phone) === normalizeCustomerPhone(trimmed)
        ) {
          setDuplicateMatch(match);
        }
      } catch (err) {
        console.error("Duplicate phone check failed:", err);
      } finally {
        setIsCheckingPhone(false);
      }
    }, 250);
  }

  // Cashier accepts the duplicate match (default action)
  function handleAcceptDuplicate() {
    if (!duplicateMatch) return;
    // [FIX] This path closes the modal via the `onOpenChange` prop
    // directly (below), not via handleDialogOpenChange — so it must clear
    // the debounce timer itself. Without this, a keystroke-triggered timer
    // queued just before the cashier clicked "استخدام الزبون الحالي" can
    // still fire ~250ms later and call setDuplicateMatch on a modal that's
    // already closed and reset.
    clearPhoneDebounce();
    onSelectCustomer(duplicateMatch.customer);
    setName("");
    setPhone("");
    setShopName("");
    setDuplicateMatch(null);
    onOpenChange(false);
  }

  // Cashier chooses to proceed with new customer despite duplicate phone
  function handleIgnoreDuplicate() {
    if (duplicateMatch?.customer.phone) {
      setIgnoredDuplicatePhone(duplicateMatch.customer.phone);
    }
    setDuplicateMatch(null);
  }

  // [FIX] `React.FormEvent` -> imported `FormEvent` type. The file never
  // imports `React` as a namespace (only named hooks), so referencing the
  // `React.*` namespace directly for a type can fail to compile depending
  // on tsconfig's `esModuleInterop`/global JSX type settings. Importing
  // the type by name avoids depending on an ambient `React` namespace
  // being available at all.
  async function handleCreateWalkIn(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("يرجى إدخال اسم الزبون.");
      return;
    }

    if (duplicateMatch) {
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      const trimmedPhone = phone.trim();
      if (
        trimmedPhone &&
        normalizeCustomerPhone(trimmedPhone) !==
        (ignoredDuplicatePhone ? normalizeCustomerPhone(ignoredDuplicatePhone) : "")
      ) {
        const match = await findMatchingCustomerByPhone(tenantId, trimmedPhone);
        if (match) {
          setDuplicateMatch(match);
          setIsSubmitting(false);
          return;
        }
      }
      const newCustomer = await createOfflineWalkInCustomer(tenantId, {
        name: name.trim(),
        phone: phone.trim() || undefined,
        shopName: shopName.trim() || undefined,
      });

      // [FIX] Same reasoning as handleAcceptDuplicate above — this path
      // also closes via the `onOpenChange` prop directly, bypassing
      // handleDialogOpenChange, so it must clear the timer itself here.
      clearPhoneDebounce();

      onSelectCustomer(newCustomer);
      setName("");
      setPhone("");
      setShopName("");
      setDuplicateMatch(null);
      setIgnoredDuplicatePhone(null);
      onOpenChange(false);
    } catch (err: unknown) {
      setFormError(
        err instanceof Error ? err.message : "فشل إنشاء الزبون محلياً"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const isSystemSelected = isSystemCashCustomer(selectedCustomer);

  async function handleSelectCashCustomer() {
    if (!allowSystemCustomer) return;
    const fromList = customers.find((c) => isSystemCashCustomer(c));
    const system = fromList ?? (await getSystemCashCustomer(tenantId));
    if (!system) {
      setFormError(
        "لا يوجد زبون نقدي نظامي في الذاكرة المحلية. يرجى مزامنة بيانات الزبائن أو تحميل البيانات التجريبية."
      );
      return;
    }
    // [FIX] Same reasoning as the other direct onOpenChange(false) call
    // sites — this path bypasses handleDialogOpenChange too.
    clearPhoneDebounce();
    onSelectCustomer(system);
    onOpenChange(false);
  }

  // [FIX] The tab badge previously showed `customers.length` (which
  // includes the system-generated "زبون نقدي عام" row), while the list
  // below it filters that row out — the count and what's actually shown
  // disagreed by one. Computed once here and reused in both places so
  // they can never drift apart again.
  const realCustomers = customers.filter((c) => !c.isSystemGenerated);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-bold text-zinc-900 dark:text-zinc-100">
            <Users className="h-5 w-5 text-emerald-600" />
            تحديد أو تسجيل الزبون
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            اختر زبوناً مسجلاً من الذاكرة المحلية أو سجل زبوناً نقدياً / مؤقتاً
            جديداً فوراً بدون مغادرة نقطة البيع.
          </DialogDescription>
        </DialogHeader>

        {formError && tab === "existing" && (
          <div className="flex items-center gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300 border border-red-200">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "existing" | "new")}
          className="mt-2"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="existing" className="text-xs">
              <Users className="ml-1.5 h-3.5 w-3.5" />
              الزبائن المسجلون ({realCustomers.length})
            </TabsTrigger>
            <TabsTrigger value="new" className="text-xs">
              <UserPlus className="ml-1.5 h-3.5 w-3.5" />
              تسجيل زبون جديد (سريع)
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: Existing Customers & Cash Walk-in Shortcut */}
          <TabsContent value="existing" className="space-y-3 mt-3">
            {/* Quick One-Tap Cash Walk-in Option ("زبون نقدي") */}
            <div
              onClick={() => {
                void handleSelectCashCustomer();
              }}
              className={`rounded-xl border p-3 transition-all flex items-center justify-between ${!allowSystemCustomer
                  ? "cursor-not-allowed opacity-50 border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/50"
                  : isSystemSelected
                    ? "cursor-pointer border-emerald-600 bg-emerald-50/80 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-100 font-semibold shadow-xs"
                    : "cursor-pointer border-zinc-200 bg-zinc-50/50 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:bg-zinc-800"
                }`}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300">
                  <UserCheck className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-bold">زبون نقدي عام (زبون نقدي)</p>
                  <p className="text-[11px] text-zinc-500">
                    {allowSystemCustomer
                      ? "اختصار بنقرة واحدة للمبيعات النقدية الفورية المباشرة (سداد 100% كاش)"
                      : "غير متاح مع البيع على الحساب أو الدفع الجزئي — اختر زبوناً حقيقياً أو سجّل زبوناً جديداً"}
                  </p>
                </div>
              </div>
              {isSystemSelected && allowSystemCustomer && (
                <Badge className="bg-emerald-600 text-white text-[10px]">
                  محدد حالياً
                </Badge>
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
                <p className="text-center py-4 text-xs text-zinc-400">
                  جاري قراءة البيانات المحلية...
                </p>
              ) : realCustomers.length === 0 ? (
                <div className="text-center py-6 text-xs text-zinc-400">
                  لا يوجد زبائن يطابقون البحث في الذاكرة المحلية.
                </div>
              ) : (
                realCustomers.map((c) => {
                  const isSelected = selectedCustomer?.id === c.id;
                  return (
                    <div
                      key={c.id}
                      onClick={() => {
                        // [FIX] Same reasoning as the other direct
                        // onOpenChange(false) call sites in this file.
                        clearPhoneDebounce();
                        onSelectCustomer(c);
                        onOpenChange(false);
                      }}
                      className={`cursor-pointer rounded-lg border p-2.5 transition-all flex items-center justify-between ${isSelected
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
                            <Badge
                              variant="outline"
                              className="text-[10px] text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/50"
                            >
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
                        {c.balanceDebtUSD !== undefined &&
                          c.balanceDebtUSD > 0 ? (
                          <div className="text-right">
                            <span className="text-[10px] text-zinc-400 block">
                              الدين الحالي
                            </span>
                            <span className="text-xs font-bold text-red-600 dark:text-red-400">
                              ${c.balanceDebtUSD.toFixed(2)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[11px] text-emerald-600">
                            لا يوجد ديون
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </TabsContent>

          {/* TAB 2: Inline Walk-in Creation with Soft Duplicate Check */}
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
                <Label htmlFor="cust-phone" className="text-xs font-semibold flex items-center justify-between">
                  <span>رقم الهاتف (اختياري)</span>
                  {isCheckingPhone && (
                    <span className="text-[10px] text-zinc-400 font-normal">
                      جاري التحقق من الرقم...
                    </span>
                  )}
                </Label>
                <Input
                  id="cust-phone"
                  placeholder="مثال: 0991234567"
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  className="text-xs"
                />
              </div>

              {/* [v3.4] Soft Duplicate-Phone Prompt */}
              {duplicateMatch && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/60 text-xs space-y-2 animate-in fade-in-50 duration-200">
                  <div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold">
                        في زبون مسجّل بنفس الرقم: {duplicateMatch.customer.name}
                        {duplicateMatch.customer.shopName
                          ? ` (${duplicateMatch.customer.shopName})`
                          : ""}
                      </p>
                      <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
                        تستخدمه ولا تنشئ زبون جديد؟
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-amber-200 dark:border-amber-900/80">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleIgnoreDuplicate}
                      className="text-xs h-7 text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/50"
                    >
                      إنشاء زبون جديد بهذا الرقم
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleAcceptDuplicate}
                      className="text-xs h-7 bg-emerald-600 hover:bg-emerald-700 text-white font-bold gap-1 shadow-xs"
                    >
                      <Check className="h-3.5 w-3.5" />
                      استخدام الزبون الحالي (المسجّل)
                    </Button>
                  </div>
                </div>
              )}

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
                💡 سيتم حفظ الزبون محلياً في قاعدة بيانات المتصفح وإرفاقه فوراً
                بهذه الفاتورة مع توليد معرف UUID فريد.
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // [FIX] Same debounce-timer leak as the other close
                    // paths — this button also calls the `onOpenChange`
                    // prop directly, bypassing handleDialogOpenChange, so
                    // a pending phone-check timer must be cleared here too.
                    clearPhoneDebounce();
                    onOpenChange(false);
                  }}
                  className="text-xs"
                >
                  إلغاء
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isSubmitting || !name.trim() || !!duplicateMatch || isCheckingPhone}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold"
                >
                  {isSubmitting
                    ? "جاري الحفظ..."
                    : duplicateMatch
                      ? "اختر استخدام الزبون المسجّل أو إنشاء زبون جديد"
                      : "حفظ واختيار الزبون"}
                </Button>
              </div>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}