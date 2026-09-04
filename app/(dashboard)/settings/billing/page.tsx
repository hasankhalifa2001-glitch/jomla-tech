"use client";

import { useSession } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, CreditCard, UploadCloud, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function BillingSettingsPage() {
  const { data: session } = useSession();
  const subscriptionStatus = session?.user?.subscriptionStatus || "ACTIVE";

  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

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

      const res = await fetch("/api/upload/receipt", { // تأكد هاد هو المسار الفعلي
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => null);

      if (res.ok && data?.success) {
        toast.success("تم إرسال إيصال الدفع بنجاح. سيتم مراجعة الطلب وتفعيل الاشتراك في أقرب وقت.");
        setReceiptFile(null);
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
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">إعدادات الفوترة والاشتراك</h1>
        <p className="text-xs text-zinc-500">
          متابعة حالة اشتراك المنشأة، وتجديد الباقة، وإرفاق إيصالات التحويل الشام المحمول / الهرم.
        </p>
      </div>

      {/* Subscription Status Overview Card */}
      <Card className="border-zinc-200 shadow-xs dark:border-zinc-800">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-emerald-600" />
              <CardTitle className="text-base font-bold">حالة الاشتراك الحالي</CardTitle>
            </div>
            {subscriptionStatus === "ACTIVE" && (
              <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 gap-1.5 px-3 py-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                <span>اشتراك نشط</span>
              </Badge>
            )}
            {subscriptionStatus === "EXPIRED" && (
              <Badge className="bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 gap-1.5 px-3 py-1">
                <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
                <span>اشتراك منتهي</span>
              </Badge>
            )}
            {subscriptionStatus === "PENDING" && (
              <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 gap-1.5 px-3 py-1">
                <Clock className="h-3.5 w-3.5 text-amber-600" />
                <span>قيد التفعيل</span>
              </Badge>
            )}
          </div>
          <CardDescription className="text-xs">
            صلاحيات الحساب الحالية: {session?.user?.role === "ADMIN" ? "مدير المتجر (ADMIN)" : "كاشير"}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-0">
          {subscriptionStatus === "EXPIRED" && (
            <div className="rounded-xl border border-red-200 bg-red-50/50 p-4 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              <p className="font-bold mb-1 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                <span>تنبيه هائم: الحساب في وضع القراءة فقط!</span>
              </p>
              <p>
                انتهت الفترة التجريبية أو الاشتراك الشهري لمتجرك. يرجى سداد قيمة الاشتراك المحددة وإرفاق إيصال التحويل أدناه لإعادة تفعيل كامل الصلاحيات وتفادي إيقاف الخدمات.
              </p>
            </div>
          )}

          <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 space-y-2 text-xs">
            <div className="flex justify-between border-b border-zinc-200 pb-2 dark:border-zinc-800">
              <span className="text-zinc-500">اسم المنشأة:</span>
              <span className="font-bold text-zinc-900 dark:text-zinc-100">{session?.user?.tenantName}</span>
            </div>
            <div className="flex justify-between border-b border-zinc-200 pb-2 dark:border-zinc-800">
              <span className="text-zinc-500">معرف المتجر (Slug):</span>
              <span className="font-mono text-zinc-900 dark:text-zinc-100">{session?.user?.tenantSlug}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">سعر الاشتراك الشهري:</span>
              <span className="font-bold text-emerald-600">$25.00 USD</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Upload Renewal Receipt Card */}
      <Card className="border-zinc-200 shadow-xs dark:border-zinc-800">
        <CardHeader>
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-emerald-600" />
            <span>إرفاق إيصال تجديد الاشتراك</span>
          </CardTitle>
          <CardDescription className="text-xs">
            قم بتحويل مبلغ الاشتراك ورفع صورة إيصال التحويل ليتم مراجعته من فريق الدعم الفني.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUploadReceipt} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="receipt" className="text-xs font-semibold">
                صورة الإيصال (PNG, JPG)
              </Label>
              <Input
                id="receipt"
                type="file"
                accept="image/*"
                onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                className="text-xs cursor-pointer"
              />
            </div>

            <Button
              type="submit"
              disabled={isUploading || !receiptFile}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold"
            >
              {isUploading ? "جاري الرفع..." : "إرسال إيصال التحويل"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
