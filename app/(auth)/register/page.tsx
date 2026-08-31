"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Store, User, Mail, Lock, Phone, Loader2, AlertCircle } from "lucide-react";

export default function RegisterPage() {
  const router = useRouter();

  const [tenantName, setTenantName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [phone, setPhone] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSlugChange = (val: string) => {
    const sanitized = val
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-");
    setTenantSlug(sanitized);
  };

  const handleNameChange = (val: string) => {
    setTenantName(val);
    if (!tenantSlug || tenantSlug === tenantName.toLowerCase().replace(/[^a-z0-9-]/g, "-")) {
      const suggested = val.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
      setTenantSlug(suggested);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!tenantName || !tenantSlug || !adminName || !adminEmail || !password) {
      setErrorMessage("يرجى تعبئة جميع الحقول المطلوبة.");
      return;
    }

    if (tenantSlug.length < 2) {
      setErrorMessage("معرف المتجر يجب أن يكون حرفين على الأقل.");
      return;
    }

    if (password.length < 6) {
      setErrorMessage("كلمة المرور يجب أن تكون 6 أحرف على الأقل.");
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantName,
          tenantSlug,
          phone: phone || null,
          adminName,
          adminEmail,
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.message || "فشل تسجيل المتجر. يرجى التثبت من البيانات.");
        setIsLoading(false);
        return;
      }

      const loginRes = await signIn("credentials", {
        email: adminEmail,
        password,
        redirect: false,
      });

      if (loginRes?.error) {
        router.push("/login?registered=true");
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err) {
      console.error("Registration error:", err);
      setErrorMessage("حدث خطأ في الاتصال أثناء التسجيل. يرجى المحاولة لاحقاً.");
      setIsLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4 py-12 font-sans">
      <Card className="w-full max-w-lg border-zinc-200 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <CardHeader className="space-y-1 text-center pb-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-600/20 mb-2">
            <Store className="h-7 w-7" />
          </div>
          <CardTitle className="text-2xl font-extrabold text-zinc-900 dark:text-zinc-100">
            تسجيل تجار الجملة
          </CardTitle>
          <CardDescription className="text-xs text-zinc-500 dark:text-zinc-400">
            أنشئ مساحة العمل الخاصة بمنشأتك وادعُ فريق العمل لإدارة المبيعات والمخزون.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {errorMessage && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Store Info Section */}
            <div className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50/50 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/50">
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 block">
                1. بيانات المنشأة والمتجر
              </span>

              <div className="space-y-1.5">
                <Label htmlFor="tenantName" className="text-xs font-semibold">
                  اسم المتجر / الشركة <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <Store className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
                  <Input
                    id="tenantName"
                    placeholder="مثال: تجارة البركة بالجملة"
                    value={tenantName}
                    onChange={(e) => handleNameChange(e.target.value)}
                    className="pr-9 text-xs"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tenantSlug" className="text-xs font-semibold">
                  معرف المتجر بالإنجليزية (Slug) <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <Input
                    id="tenantSlug"
                    placeholder="al-baraka"
                    value={tenantSlug}
                    onChange={(e) => handleSlugChange(e.target.value)}
                    className="text-xs font-mono ltr text-left"
                    required
                  />
                </div>
                <p className="text-[11px] text-zinc-500">
                  سيكون رابط متجركم: <code className="font-mono text-emerald-600">/store/{tenantSlug || "slug"}</code>
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="phone" className="text-xs font-semibold">
                  رقم الهاتف (اختياري)
                </Label>
                <div className="relative">
                  <Phone className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
                  <Input
                    id="phone"
                    placeholder="+963 911 223 344"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="pr-9 text-xs ltr text-left"
                  />
                </div>
              </div>
            </div>

            {/* Admin Info Section */}
            <div className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50/50 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/50">
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 block">
                2. حساب مدير المتجر (Admin)
              </span>

              <div className="space-y-1.5">
                <Label htmlFor="adminName" className="text-xs font-semibold">
                  اسم المدير المسؤول <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <User className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
                  <Input
                    id="adminName"
                    placeholder="مثال: أحمد خليل"
                    value={adminName}
                    onChange={(e) => setAdminName(e.target.value)}
                    className="pr-9 text-xs"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="adminEmail" className="text-xs font-semibold">
                  البريد الإلكتروني <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <Mail className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
                  <Input
                    id="adminEmail"
                    type="email"
                    placeholder="admin@example.com"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    className="pr-9 text-xs ltr text-left"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-semibold">
                  كلمة المرور <span className="text-red-500">*</span>
                </Label>
                <div className="relative">
                  <Lock className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-9 text-xs ltr text-left"
                    required
                  />
                </div>
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs h-10 gap-2 shadow-md shadow-emerald-600/20"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>جاري إنشاء الحساب والمساحة...</span>
                </>
              ) : (
                <span>إنشاء متجر جديد للشركة</span>
              )}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="flex flex-col items-center gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-4 bg-zinc-50/50 dark:bg-zinc-900/30">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            لديك حساب مسجل بالفعل؟{" "}
            <Link
              href="/login"
              className="font-bold text-emerald-700 hover:underline dark:text-emerald-400"
            >
              تسجيل الدخول
            </Link>
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
