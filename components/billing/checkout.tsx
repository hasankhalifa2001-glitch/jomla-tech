"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { compressReceiptImage } from "@/lib/utils/compress-receipt";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  ImageIcon,
  Store,
  Hash,
  UploadCloud,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export type EffectiveStatus = "ACTIVE" | "GRACE" | "EXPIRED" | "PENDING";

export interface Plan {
  tier: string;
  label: string;
  priceUSD: string;
  durationDays: number;
  priceSYPPreview: string | null;
}

export interface OpenRequest {
  id: string;
  tier: string;
  amountSYP: string;
  amountUSD: string;
  referenceCode: string;
  status: string;
  hasReceipt: boolean;
  isOfferExpired: boolean;
  createdAt: string;
  expiresOfferAt: string | null;
}

export interface RecentRequest {
  id: string;
  tier: string;
  amountSYP: string;
  status: string;
  hasReceipt: boolean;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingStatus {
  status: EffectiveStatus;
  label: string;
  daysLeft: number | null;
  graceDaysLeft: number | null;
  expiresAt: string | null;
  graceDays: number;
  renewalWarningDays: number;
  rateAvailable: boolean;
  plans: Plan[];
  wallet: string;
  openRequest: OpenRequest | null;
  recentRequests: RecentRequest[];
}

const TIER_LABEL: Record<string, string> = { monthly: "شهري", yearly: "سنوي" };

const STYLE: Record<EffectiveStatus, { badge: string; ring: string }> = {
  ACTIVE: {
    badge:
      "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
    ring: "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30",
  },
  GRACE: {
    badge:
      "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
    ring: "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30",
  },
  EXPIRED: {
    badge:
      "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900",
    ring: "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30",
  },
  PENDING: {
    badge:
      "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
    ring: "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30",
  },
};

function fmtSYP(value: string | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat("ar-SY", { maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ar-SY", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Damascus",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function copyText(value: string, label: string) {
  const done = () => toast.success(`تم نسخ ${label}.`);
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(done, () => toast.error("تعذّر النسخ."));
    return;
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch {
    toast.error("تعذّر النسخ.");
  }
}

function useCountdown(targetIso: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!targetIso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [targetIso]);
  if (!targetIso) return null;
  const diff = new Date(targetIso).getTime() - now;
  if (!Number.isFinite(diff) || diff <= 0) return "انتهت المهلة";
  const h = Math.floor(diff / 3600e3);
  const m = Math.floor((diff % 3600e3) / 60e3);
  const s = Math.floor((diff % 60e3) / 1000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function BillingCheckout(props: {
  tenantName?: string | null;
  tenantSlug?: string | null;
  role?: string | null;
}) {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creatingTier, setCreatingTier] = useState<string | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/billing/status", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(data?.message || "تعذّر تحميل حالة الاشتراك.");
        return;
      }
      setBilling(data as BillingStatus);
      setLoadError(null);
    } catch {
      setLoadError("فشل الاتصال بالخادم.");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await refresh();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  const status: EffectiveStatus = billing?.status ?? "PENDING";
  const st = STYLE[status];
  const openRequest = billing?.openRequest ?? null;

  // A stale offer WITHOUT a receipt is system-rejected by the create route,
  // so the plans must stay selectable (otherwise the user is stuck).
  const showPlans =
    !openRequest || (openRequest.isOfferExpired && !openRequest.hasReceipt);
  const activeOffer = showPlans ? null : openRequest;
  const lastRequest = billing?.recentRequests?.[0] ?? null;
  const rejected = lastRequest?.status === "REJECTED" ? lastRequest : null;

  const countdown = useCountdown(activeOffer?.expiresOfferAt ?? null);
  const busy = creatingTier !== null || isUploading || isCompressing;

  const handleCreate = async (tier: string) => {
    setCreatingTier(tier);
    try {
      const res = await fetch("/api/billing/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.message || "حدث خطأ أثناء إنشاء طلب الاشتراك.");
        // e.g. an open request already exists: show the real state.
        await refresh();
        return;
      }
      toast.success("تم إنشاء طلب الاشتراك. أكمل الدفع وأرفق الإيصال.");
      await refresh();
    } catch {
      toast.error("فشل الاتصال بالخادم.");
    } finally {
      setCreatingTier(null);
    }
  };

  const handleFile = async (file: File | null) => {
    if (!file) {
      setReceiptFile(null);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    setIsCompressing(true);
    try {
      const result = await compressReceiptImage(file);
      if (!result.ok) {
        toast.error(
          result.reason === "UNREADABLE"
            ? "تعذّر قراءة الصورة، اختر صورة JPG أو PNG."
            : "الصورة كبيرة جداً، جرّب لقطة شاشة أصغر."
        );
        return;
      }
      if (result.overTarget) {
        toast.message("حجم الصورة أكبر من المستحسن لكنه مقبول.");
      }
      setReceiptFile(result.file);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(result.file);
      });
    } finally {
      setIsCompressing(false);
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOffer) {
      toast.error("أنشئ طلب اشتراك أولاً.");
      return;
    }
    if (!receiptFile) {
      toast.error("يرجى اختيار صورة الإيصال أولاً.");
      return;
    }
    setIsUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", receiptFile);
      const res = await fetch(`/api/billing/subscriptions/${activeOffer.id}/receipt`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        toast.success("تم رفع الإيصال. الطلب بانتظار المراجعة.");
        setReceiptFile(null);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        if (fileRef.current) fileRef.current.value = "";
        await refresh();
      } else {
        toast.error(data?.message || "حدث خطأ أثناء رفع الإيصال.");
        await refresh();
      }
    } catch {
      toast.error("فشل الاتصال بالخادم.");
    } finally {
      setIsUploading(false);
    }
  };

  const StatusIcon =
    status === "ACTIVE" ? CheckCircle2 : status === "EXPIRED" ? AlertTriangle : Clock;
  const hint =
    status === "ACTIVE" && billing?.expiresAt
      ? `الاشتراك نشط حتى ${fmtDate(billing.expiresAt)}.`
      : status === "ACTIVE"
        ? "الاشتراك مفعّل وكل صلاحيات المتجر متاحة."
        : status === "GRACE"
          ? (billing?.label ?? "انتهى اشتراكك.")
          : status === "EXPIRED"
            ? "انتهت صلاحية الاشتراك، الحساب في وضع القراءة فقط حتى يتم التجديد."
            : "بانتظار تفعيل حسابك.";

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-5 px-1 pb-10">
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 sm:text-2xl">
          الفوترة والاشتراك
        </h1>
        <p className="mt-1 text-xs text-slate-500 sm:text-sm">جاري تحميل حالة الاشتراك…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-1 pb-10 sm:space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 sm:text-2xl">
          الفوترة والاشتراك
        </h1>
        <p className="mt-1 text-xs text-slate-500 sm:text-sm">
          متابعة حالة اشتراك المنشأة، وتجديد الباقة، وإرفاق إيصالات التحويل.
        </p>
      </div>

      <div
        className={`flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 ${st.ring}`}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white shadow-sm dark:bg-slate-900">
            <StatusIcon className="h-4.5 w-4.5" />
          </span>
          <div className="space-y-0.5">
            <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
              {status === "ACTIVE" && billing?.expiresAt
                ? `اشتراك نشط حتى ${fmtDate(billing.expiresAt)}`
                : (billing?.label ?? hint)}
            </p>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">{hint}</p>
            {loadError && <p className="text-xs text-red-600">{loadError}</p>}
          </div>
        </div>
        <Badge
          className={`w-fit shrink-0 gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${st.badge}`}
        >
          <StatusIcon className="h-3.5 w-3.5" />
          {billing?.label ?? status}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5 lg:gap-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950 sm:p-5 lg:col-span-2">
          <div className="mb-4 flex items-center gap-2">
            <CreditCard className="h-4.5 w-4.5 text-emerald-600" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">بيانات المنشأة</h2>
          </div>
          <dl className="space-y-3 text-xs sm:text-sm">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 dark:border-slate-900">
              <dt className="flex items-center gap-1.5 text-slate-500">
                <Store className="h-3.5 w-3.5" />
                اسم المنشأة
              </dt>
              <dd className="font-semibold text-slate-900 dark:text-slate-100">
                {props.tenantName || "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-slate-500">
                <Hash className="h-3.5 w-3.5" />
                معرّف المتجر
              </dt>
              <dd className="font-mono text-slate-900 dark:text-slate-100" dir="ltr">
                {props.tenantSlug || "—"}
              </dd>
            </div>
          </dl>
        </section>

        <section className="space-y-5 lg:col-span-3">
          {billing && !billing.rateAvailable && showPlans && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-xs text-amber-800">
              سعر الصرف غير محدد حالياً، حاول لاحقاً.
            </div>
          )}

          {openRequest?.isOfferExpired && !openRequest.hasReceipt && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-xs text-amber-800">
              انتهت صلاحية العرض السابق، اختر باقة لإنشاء طلب جديد.
            </div>
          )}

          {rejected && showPlans && (
            <div className="rounded-2xl border border-red-200 bg-red-50/60 p-4">
              <p className="text-xs font-bold text-red-700">تم رفض الطلب السابق</p>
              <p className="mt-1 text-xs text-red-600">السبب: {rejected.rejectionReason || "—"}</p>
              <p className="mt-2 text-xs text-slate-600">اختر باقة لإنشاء طلب جديد.</p>
            </div>
          )}

          {showPlans && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {(billing?.plans ?? []).map((p) => (
                <div
                  key={p.tier}
                  className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950"
                >
                  <h3 className="text-sm font-bold">
                    {TIER_LABEL[p.tier] ?? p.label} — ${p.priceUSD}
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">{p.durationDays} يوم</p>
                  <p className="mt-2 text-sm font-bold text-emerald-600">
                    {p.priceSYPPreview ? `${fmtSYP(p.priceSYPPreview)} ل.س` : "—"}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    المبلغ النهائي بالليرة يُثبَّت عند إنشاء الطلب
                  </p>
                  <Button
                    className="mt-3 w-full bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700"
                    disabled={busy || !billing?.rateAvailable || p.priceSYPPreview == null}
                    onClick={() => handleCreate(p.tier)}
                  >
                    {creatingTier === p.tier
                      ? "جاري الإنشاء…"
                      : `اختيار ${TIER_LABEL[p.tier] ?? p.label}`}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {activeOffer && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950 sm:p-5">
              <div className="mb-1 flex items-center gap-2">
                <Wallet className="h-4.5 w-4.5 text-emerald-600" />
                <h2 className="text-sm font-bold">إتمام الدفع</h2>
              </div>

              {activeOffer.hasReceipt && (
                <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800">
                  تم استلام الإيصال، الطلب بانتظار المراجعة. يمكنك استبداله بإيصال آخر.
                </p>
              )}

              <dl className="mt-3 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-slate-500">رقم الشام كاش</dt>
                  <dd className="flex items-center gap-2 font-mono font-bold" dir="ltr">
                    {billing?.wallet ?? "…"}
                    <button
                      type="button"
                      aria-label="نسخ رقم المحفظة"
                      onClick={() => copyText(billing?.wallet ?? "", "رقم المحفظة")}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-slate-500">المبلغ المطلوب</dt>
                  <dd className="font-bold text-emerald-600">
                    {fmtSYP(activeOffer.amountSYP)} ل.س
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-slate-500">رقم المرجع</dt>
                  <dd className="flex items-center gap-2 font-mono font-bold" dir="ltr">
                    {activeOffer.referenceCode}
                    <button
                      type="button"
                      aria-label="نسخ رقم المرجع"
                      onClick={() => copyText(activeOffer.referenceCode, "رقم المرجع")}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </dd>
                </div>
                {activeOffer.expiresOfferAt && (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500">ينتهي العرض خلال</dt>
                    <dd className="flex items-center gap-1 font-bold" dir="ltr">
                      <Clock className="h-3.5 w-3.5" />
                      {countdown ?? "—"}
                    </dd>
                  </div>
                )}
              </dl>
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                اكتب رقم المرجع في ملاحظة التحويل
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950 sm:p-5">
            <div className="mb-1 flex items-center gap-2">
              <UploadCloud className="h-4.5 w-4.5 text-emerald-600" />
              <h2 className="text-sm font-bold">إرفاق إيصال التحويل</h2>
            </div>
            {!activeOffer ? (
              <p className="text-xs text-slate-500">
                أنشئ طلب اشتراك أولاً لتتمكن من إرفاق الإيصال.
              </p>
            ) : (
              <form onSubmit={handleUpload} className="mt-3 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="receipt" className="text-xs font-semibold">
                    صورة الإيصال (JPEG أو PNG أو WEBP)
                  </Label>
                  {!previewUrl ? (
                    <label
                      htmlFor="receipt"
                      className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center"
                    >
                      <ImageIcon className="h-6 w-6 text-slate-400" />
                      <span className="text-xs font-medium text-slate-600">
                        {isCompressing ? "جاري ضغط الصورة…" : "اضغط لاختيار صورة الإيصال"}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        ضغط تلقائي تحت 300 كيلوبايت
                      </span>
                      <Input
                        id="receipt"
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(e) => handleFile(e.target.files?.[0] || null)}
                        className="hidden"
                      />
                    </label>
                  ) : (
                    <div className="flex items-center gap-3 rounded-xl border border-slate-200 p-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={previewUrl}
                        alt="معاينة إيصال التحويل"
                        className="h-16 w-16 rounded-lg object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">{receiptFile?.name}</p>
                        <p className="text-[11px] text-slate-400">
                          {receiptFile ? `${(receiptFile.size / 1024).toFixed(0)} كيلوبايت` : ""}
                        </p>
                      </div>
                      <button type="button" onClick={() => handleFile(null)} aria-label="إزالة الصورة">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
                <Button
                  type="submit"
                  disabled={isUploading || isCompressing || !receiptFile}
                  className="w-full bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700 sm:w-auto sm:px-6"
                >
                  {isUploading
                    ? "جاري الإرسال..."
                    : isCompressing
                      ? "جاري الضغط..."
                      : "إرسال إيصال التحويل"}
                </Button>
                <p className="text-[11px] text-slate-400">بعد الرفع: بانتظار المراجعة.</p>
              </form>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}