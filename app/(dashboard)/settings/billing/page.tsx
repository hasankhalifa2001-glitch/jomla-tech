"use client";

import { useSession } from "next-auth/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CreditCard,
  UploadCloud,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Store,
  Hash,
  Wallet,
  ImageIcon,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type SubscriptionStatus = "ACTIVE" | "EXPIRED" | "PENDING";

const STATUS_CONFIG: Record<
  SubscriptionStatus,
  {
    label: string;
    badgeClass: string;
    icon: typeof CheckCircle2;
    accent: string;
  }
> = {
  ACTIVE: {
    label: "اشتراك نشط",
    badgeClass: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
    icon: CheckCircle2,
    accent: "emerald",
  },
  EXPIRED: {
    label: "اشتراك منتهي",
    badgeClass: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900",
    icon: AlertTriangle,
    accent: "red",
  },
  PENDING: {
    label: "قيد التفعيل",
    badgeClass: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
    icon: Clock,
    accent: "amber",
  },
};

export default function BillingSettingsPage() {
  const { data: session } = useSession();
  const subscriptionStatus: SubscriptionStatus =
    (session?.user?.subscriptionStatus as SubscriptionStatus) || "ACTIVE";

  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const status = STATUS_CONFIG[subscriptionStatus];
  const StatusIcon = status.icon;

  const handleFileChange = (file: File | null) => {
    setReceiptFile(file);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return file ? URL.createObjectURL(file) : null;
    });
  };

  const handleUploadReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiptFile) {
      toast.error("يرجى اختيار صورة الإيصال أولاً.");
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", receiptFile);
      formData.append("type", "receipt"); // يحدد النوع فيتخطى قفل الاشتراك

      const res = await fetch("/api/upload/receipt", {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => null);

      if (res.ok && data?.success) {
        toast.success("تم إرسال إيصال الدفع بنجاح. سيتم مراجعة الطلب وتفعيل الاشتراك في أقرب وقت.");
        handleFileChange(null);
      } else {
        toast.error(data?.message || "حدث خطأ أثناء رفع الإيصال.");
      }
    } catch (err) {
      console.error(err);
      toast.error("فشل الاتصال بالخادم.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-1 pb-10 sm:space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 sm:text-2xl">
          الفوترة والاشتراك
        </h1>
        <p className="mt-1 text-xs text-slate-500 sm:text-sm">
          متابعة حالة اشتراك المنشأة، وتجديد الباقة، وإرفاق إيصالات التحويل — الشام كاش أو الحوالة المباشرة.
        </p>
      </div>

      {/* Status ribbon — full width, the one place this page uses its accent color boldly */}
      <div
        className={`flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 ${subscriptionStatus === "ACTIVE"
            ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30"
            : subscriptionStatus === "EXPIRED"
              ? "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30"
              : "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30"
          }`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white shadow-sm dark:bg-slate-900 ${subscriptionStatus === "ACTIVE"
                ? "text-emerald-600"
                : subscriptionStatus === "EXPIRED"
                  ? "text-red-600"
                  : "text-amber-600"
              }`}
          >
            <StatusIcon className="h-4.5 w-4.5" />
          </span>
          <div className="space-y-0.5">
            <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{status.label}</p>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              {subscriptionStatus === "ACTIVE" &&
                "الاشتراك مفعّل وكل صلاحيات المتجر متاحة."}
              {subscriptionStatus === "EXPIRED" &&
                "انتهت صلاحية الاشتراك — الحساب في وضع القراءة فقط حتى يتم التجديد."}
              {subscriptionStatus === "PENDING" &&
                "الحساب قيد المراجعة من فريق الدعم. أرفق إيصال التحويل أدناه، أو تحقق من حالة الطلب إذا كنت قد أرسلته."}
            </p>
          </div>
        </div>
        <Badge className={`w-fit shrink-0 gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${status.badgeClass}`}>
          <StatusIcon className="h-3.5 w-3.5" />
          {status.label}
        </Badge>
      </div>

      {/* Two-up on desktop, stacked on mobile */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5 lg:gap-6">
        {/* Merchant details */}
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
                {session?.user?.tenantName || "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 dark:border-slate-900">
              <dt className="flex items-center gap-1.5 text-slate-500">
                <Hash className="h-3.5 w-3.5" />
                معرّف المتجر
              </dt>
              <dd className="font-mono text-slate-900 dark:text-slate-100" dir="ltr">
                {session?.user?.tenantSlug || "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-slate-500">
                <Wallet className="h-3.5 w-3.5" />
                سعر الاشتراك الشهري
              </dt>
              <dd className="font-bold text-emerald-600">$25.00</dd>
            </div>
          </dl>

          <p className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            صلاحيات حسابك الحالية:{" "}
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              {session?.user?.role === "ADMIN" ? "مدير المتجر" : "كاشير"}
            </span>
          </p>
        </section>

        {/* Receipt upload */}
        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950 sm:p-5 lg:col-span-3">
          <div className="mb-1 flex items-center gap-2">
            <UploadCloud className="h-4.5 w-4.5 text-emerald-600" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">إرفاق إيصال التحويل</h2>
          </div>
          <p className="mb-4 text-xs text-slate-500">
            حوّل قيمة الاشتراك عبر الشام كاش أو الحوالة المباشرة، وأرفق صورة الإيصال ليراجعها فريق الدعم.
          </p>

          <form onSubmit={handleUploadReceipt} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="receipt" className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                صورة الإيصال (PNG أو JPG)
              </Label>

              {!previewUrl ? (
                <label
                  htmlFor="receipt"
                  className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center transition-colors hover:border-emerald-300 hover:bg-emerald-50/40 dark:border-slate-800 dark:bg-slate-900/40"
                >
                  <ImageIcon className="h-6 w-6 text-slate-400" />
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    اضغط لاختيار صورة الإيصال
                  </span>
                  <span className="text-[11px] text-slate-400">PNG أو JPG</span>
                  <Input
                    id="receipt"
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                </label>
              ) : (
                <div className="relative flex items-center gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt="معاينة إيصال التحويل"
                    className="h-16 w-16 shrink-0 rounded-lg object-cover ring-1 ring-slate-200 dark:ring-slate-800"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
                      {receiptFile?.name}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {receiptFile ? `${(receiptFile.size / 1024).toFixed(0)} كيلوبايت` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleFileChange(null)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                    aria-label="إزالة الصورة"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            <Button
              type="submit"
              disabled={isUploading || !receiptFile}
              className="w-full bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700 sm:w-auto sm:px-6"
            >
              {isUploading ? "جاري الإرسال..." : "إرسال إيصال التحويل"}
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}