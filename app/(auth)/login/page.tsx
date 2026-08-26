"use client";

import { useState, useCallback, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Store, Lock, Mail, Loader2, AlertCircle, ShieldCheck } from "lucide-react";

// Demo quick-login accounts are dev/staging-only. Gated behind a dedicated
// flag rather than NODE_ENV alone — a staging environment can legitimately
// run with NODE_ENV=production while still wanting demo logins, and vice
// versa. Never rely on NODE_ENV !== "production" as the sole gate for
// something this sensitive (it silently reveals real merchant emails and
// the shared seed password to any visitor otherwise).
const SHOW_DEMO_LOGINS = process.env.NEXT_PUBLIC_SHOW_DEMO_LOGINS === "true";

const DEMO_ACCOUNTS = [
  {
    label: "👑 أدمن البركة (نشط)",
    email: "admin@albaraka.com",
    className:
      "border-purple-200 text-purple-700 hover:bg-purple-50 dark:border-purple-900 dark:text-purple-300 dark:hover:bg-purple-950/40",
  },
  {
    label: "💳 كاشير البركة",
    email: "cashier@albaraka.com",
    className:
      "border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-300 dark:hover:bg-blue-950/40",
  },
  {
    label: "⚠️ أدمن النور (اشتراك منتهي)",
    email: "admin@alnoor.com",
    className:
      "col-span-2 border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40",
  },
] as const;

function LoginFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const performLogin = useCallback(
    async (loginEmail: string, loginPassword: string) => {
      setError(null);
      setIsLoading(true);

      try {
        const res = await signIn("credentials", {
          email: loginEmail,
          password: loginPassword,
          redirect: false,
        });

        if (res?.error) {
          // authorize() throws a distinct "Too many login attempts" message
          // when the Upstash rate limiter trips (see auth.ts) — surface that
          // specifically, or a rate-limited user sees "wrong password" and
          // has no idea they should just wait instead of retrying, which
          // only extends their own lockout window.
          const message = res.error.toLowerCase().includes("too many")
            ? "محاولات دخول كثيرة جداً. الرجاء الانتظار بضع دقائق قبل إعادة المحاولة."
            : "بيانات الدخول غير صحيحة. يرجى التثبت من البريد الإلكتروني وكلمة المرور.";
          setError(message);
          setIsLoading(false);
          return;
        }

        router.push(callbackUrl);
        router.refresh();
      } catch (err) {
        console.error(err);
        setError("حدث خطأ أثناء الاتصال بالخادم.");
        setIsLoading(false);
      }
    },
    [callbackUrl, router]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void performLogin(email, password);
  };

  // Logs straight in rather than just filling the fields — a "quick login"
  // that still makes you press Submit yourself isn't actually quick, and
  // demo buttons only exist to save testers a step.
  const handleQuickLogin = (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword("password123");
    void performLogin(demoEmail, "password123");
  };

  return (
    <Card className="w-full max-w-md border-zinc-200 shadow-xl dark:border-zinc-800 bg-white dark:bg-zinc-950">
      <CardHeader className="space-y-2 text-center pb-6 border-b border-zinc-100 dark:border-zinc-900">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-500/20">
          <Store className="h-7 w-7" />
        </div>
        <CardTitle className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          منصة جملة تك
        </CardTitle>
        <CardDescription className="text-xs text-zinc-500 dark:text-zinc-400">
          تسجيل الدخول الموحد لمدراء المتاجر والكاشير للوصول للوحة التحكم ونقطة البيع.
        </CardDescription>
      </CardHeader>

      <CardContent className="pt-6 space-y-4">
        {error && (
          <Alert
            variant="destructive"
            className="bg-red-50 text-red-800 border-red-200 dark:bg-red-950/50 dark:border-red-900 dark:text-red-200 text-xs"
          >
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              البريد الإلكتروني
            </Label>
            <div className="relative">
              <Mail className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
              <Input
                id="email"
                type="email"
                placeholder="name@merchant.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                className="pr-10 text-sm font-sans"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              كلمة المرور
            </Label>
            <div className="relative">
              <Lock className="absolute right-3 top-2.5 h-4 w-4 text-zinc-400" />
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                className="pr-10 text-sm font-mono"
              />
            </div>
          </div>

          <Button
            type="submit"
            disabled={isLoading}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold h-10 shadow-md shadow-emerald-600/20"
          >
            {isLoading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>جاري تسجيل الدخول...</span>
              </div>
            ) : (
              <span>تسجيل الدخول</span>
            )}
          </Button>
        </form>

        <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
          تاجر جديد؟{" "}
          <Link
            href="/register"
            className="font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
          >
            أنشئ حساب متجرك الآن
          </Link>
        </p>

        {/* Demo quick-login: dev/staging only, gated by NEXT_PUBLIC_SHOW_DEMO_LOGINS. */}
        {SHOW_DEMO_LOGINS && (
          <div className="mt-6 border-t border-zinc-100 dark:border-zinc-900 pt-4">
            <p className="text-[11px] font-semibold text-zinc-500 mb-2 flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              <span>حسابات سريعة للتجربة (بيئة الاختبار فقط):</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((account) => (
                <Button
                  key={account.email}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isLoading}
                  onClick={() => handleQuickLogin(account.email)}
                  className={`text-xs justify-start ${account.className}`}
                >
                  {account.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="justify-center border-t border-zinc-100 dark:border-zinc-900 py-4 bg-zinc-50/50 dark:bg-zinc-900/30">
        <p className="text-xs text-zinc-500">
          نظام جملة تك © 2026 - إدارة التجارة المتعددة المستأجرين
        </p>
      </CardFooter>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-6">
      <Suspense fallback={<div className="text-sm text-zinc-500">جاري تحميل الصفحة...</div>}>
        <LoginFormContent />
      </Suspense>
    </main>
  );
}
