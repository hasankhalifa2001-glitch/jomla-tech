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
import { cn } from "@/lib/utils";
import { fmtInt } from "@/lib/utils/digits";
import { Money } from "./money";

interface WalkInCustomerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCustomer: SelectedCustomer | null;
  onSelectCustomer: (customer: SelectedCustomer | null) => void;
  tenantId?: string;
  allowSystemCustomer?: boolean;
}

/** Inline error row used by both tabs. */
function ErrorRow({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs font-semibold text-red-700"
    >
      <AlertCircle className="mt-px size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <Users className="size-4.5" aria-hidden />
            </span>
            تحديد أو تسجيل الزبون
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            اختر زبوناً مسجلاً من الذاكرة المحلية أو سجل زبوناً نقدياً / مؤقتاً
            جديداً فوراً بدون مغادرة نقطة البيع.
          </DialogDescription>
        </DialogHeader>

        {formError && tab === "existing" && <ErrorRow message={formError} />}

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "existing" | "new")}
          className="mt-1"
        >
          <TabsList className="grid h-10 w-full grid-cols-2 bg-slate-100">
            <TabsTrigger
              value="existing"
              className="gap-1.5 text-xs font-bold data-[state=active]:bg-white data-[state=active]:text-emerald-800 data-[state=active]:shadow-sm"
            >
              <Users className="size-3.5" aria-hidden />
              الزبائن المسجلون ({fmtInt(realCustomers.length)})
            </TabsTrigger>
            <TabsTrigger
              value="new"
              className="gap-1.5 text-xs font-bold data-[state=active]:bg-white data-[state=active]:text-emerald-800 data-[state=active]:shadow-sm"
            >
              <UserPlus className="size-3.5" aria-hidden />
              زبون جديد (سريع)
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: Existing Customers & Cash Walk-in Shortcut */}
          <TabsContent value="existing" className="mt-3 space-y-3">
            {/* Quick one-tap cash walk-in option ("زبون نقدي") */}
            <button
              type="button"
              disabled={!allowSystemCustomer}
              onClick={() => {
                void handleSelectCashCustomer();
              }}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-start transition-all duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
                !allowSystemCustomer
                  ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-60"
                  : isSystemSelected
                    ? "border-emerald-600 bg-emerald-50 shadow-sm"
                    : "border-slate-200 bg-slate-50 hover:border-emerald-300 hover:bg-emerald-50/60"
              )}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                  <UserCheck className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-extrabold text-slate-900">زبون نقدي عام</span>
                  <span className="block text-[11px] leading-snug text-slate-600">
                    {allowSystemCustomer
                      ? "اختصار بنقرة واحدة للمبيعات النقدية الفورية (سداد 100% كاش)"
                      : "غير متاح مع البيع على الحساب أو الدفع الجزئي — اختر زبوناً حقيقياً أو سجّل زبوناً جديداً"}
                  </span>
                </span>
              </span>
              {isSystemSelected && allowSystemCustomer && (
                <span className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-extrabold text-white">
                  محدد حالياً
                </span>
              )}
            </button>

            {/* Search Input */}
            <div className="relative">
              <Search
                className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <Input
                placeholder="ابحث بالاسم، المحل، أو الهاتف..."
                aria-label="بحث عن زبون"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-10 border-slate-200 bg-white ps-9 text-sm focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20"
              />
            </div>

            {/* Customers List */}
            <div className="max-h-60 space-y-2 overflow-y-auto pe-0.5">
              {loading ? (
                <p className="py-4 text-center text-xs text-slate-500">جاري قراءة البيانات المحلية...</p>
              ) : realCustomers.length === 0 ? (
                <div className="py-6 text-center text-xs text-slate-500">
                  لا يوجد زبائن يطابقون البحث في الذاكرة المحلية.
                </div>
              ) : (
                realCustomers.map((c) => {
                  const isSelected = selectedCustomer?.id === c.id;
                  return (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => {
                        // [FIX] Same reasoning as the other direct
                        // onOpenChange(false) call sites in this file.
                        clearPhoneDebounce();
                        onSelectCustomer(c);
                        onOpenChange(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-xl border p-2.5 text-start transition-all duration-150",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
                        isSelected
                          ? "border-emerald-600 bg-emerald-50 shadow-sm"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                      )}
                    >
                      <span className="min-w-0 space-y-0.5">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-extrabold text-slate-900">{c.name}</span>
                          {c.type === "WALK_IN" && (
                            <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-bold text-amber-700 ring-1 ring-amber-200">
                              محلي جديد
                            </span>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                          {c.shopName && (
                            <span className="flex items-center gap-1">
                              <Store className="size-3" aria-hidden />
                              {c.shopName}
                            </span>
                          )}
                          {c.phone && (
                            <span className="flex items-center gap-1">
                              <Phone className="size-3" aria-hidden />
                              <bdi dir="ltr">{c.phone}</bdi>
                            </span>
                          )}
                        </span>
                      </span>

                      {/*
                        [v3.6] SelectedCustomer's `balanceDebtSYP` is the
                        authoritative field (pos-service.ts) — the
                        debt/no-debt decision and the primary figure shown are
                        based on it. balanceDebtUSD (when present) is a
                        guarded, secondary "≈" figure only.
                      */}
                      <span className="shrink-0 text-end">
                        {c.balanceDebtSYP !== undefined && c.balanceDebtSYP > 0 ? (
                          <span className="block">
                            <span className="block text-[10px] text-slate-500">الدين الحالي</span>
                            <Money
                              value={c.balanceDebtSYP}
                              compact
                              className="text-xs font-extrabold text-red-600"
                              unitClassName="text-red-500"
                            />
                            {c.balanceDebtUSD !== undefined && (
                              <span dir="ltr" className="block text-[10px] text-red-400">
                                ≈ ${c.balanceDebtUSD.toFixed(2)}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[11px] font-semibold text-emerald-600">لا يوجد ديون</span>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </TabsContent>

          {/* TAB 2: Inline Walk-in Creation with Soft Duplicate Check */}
          <TabsContent value="new" className="mt-3">
            <form onSubmit={handleCreateWalkIn} className="space-y-3">
              {formError && <ErrorRow message={formError} />}

              <div className="space-y-1">
                <Label htmlFor="cust-name" className="text-xs font-bold text-slate-700">
                  اسم الزبون <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="cust-name"
                  placeholder="مثال: أحمد عبد الله / بقالية السلام"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-10 border-slate-200 text-sm focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20"
                  autoFocus
                  required
                />
              </div>

              <div className="space-y-1">
                <Label
                  htmlFor="cust-phone"
                  className="flex items-center justify-between text-xs font-bold text-slate-700"
                >
                  <span>رقم الهاتف (اختياري)</span>
                  {isCheckingPhone && (
                    <span className="text-[11px] font-normal text-slate-500">جاري التحقق من الرقم...</span>
                  )}
                </Label>
                <Input
                  id="cust-phone"
                  inputMode="tel"
                  placeholder="مثال: 0991234567"
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  className="h-10 border-slate-200 text-sm focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20"
                />
              </div>

              {/* [v3.4] Soft Duplicate-Phone Prompt */}
              {duplicateMatch && (
                <div className="animate-in space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs duration-200 fade-in-0 motion-reduce:animate-none">
                  <div className="flex items-start gap-2 text-amber-900">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
                    <div>
                      <p className="font-extrabold">
                        في زبون مسجّل بنفس الرقم: {duplicateMatch.customer.name}
                        {duplicateMatch.customer.shopName ? ` (${duplicateMatch.customer.shopName})` : ""}
                      </p>
                      <p className="mt-0.5 text-[11px] text-amber-700">تستخدمه ولا تنشئ زبون جديد؟</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-amber-200 pt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleIgnoreDuplicate}
                      className="h-8 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                    >
                      إنشاء زبون جديد بهذا الرقم
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleAcceptDuplicate}
                      className="h-8 gap-1 bg-emerald-600 text-xs font-bold text-white shadow-sm hover:bg-emerald-700"
                    >
                      <Check className="size-3.5" aria-hidden />
                      استخدام الزبون الحالي
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="cust-shop" className="text-xs font-bold text-slate-700">
                  اسم المحل أو العنوان (اختياري)
                </Label>
                <Input
                  id="cust-shop"
                  placeholder="مثال: دمشق - الميدان"
                  value={shopName}
                  onChange={(e) => setShopName(e.target.value)}
                  className="h-10 border-slate-200 text-sm focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20"
                />
              </div>

              <p className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-600">
                سيتم حفظ الزبون محلياً في قاعدة بيانات المتصفح وإرفاقه فوراً بهذه الفاتورة مع
                توليد معرف UUID فريد.
              </p>

              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    // [FIX] Same debounce-timer leak as the other close
                    // paths — this button also calls the `onOpenChange`
                    // prop directly, bypassing handleDialogOpenChange, so
                    // a pending phone-check timer must be cleared here too.
                    clearPhoneDebounce();
                    onOpenChange(false);
                  }}
                  className="h-11 w-full border-slate-200 text-sm font-semibold text-slate-700 sm:w-auto"
                >
                  إلغاء
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitting || !name.trim() || !!duplicateMatch || isCheckingPhone}
                  className="h-11 w-full bg-emerald-600 px-6 text-sm font-extrabold text-white shadow-sm shadow-emerald-900/20 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none sm:w-auto"
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