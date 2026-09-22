/* app/(auth)/login/page.tsx */
"use client";

import { useState, useCallback, Suspense } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn, getSession } from "next-auth/react";
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import s from "@/components/auth/auth.module.css";

// Demo quick-login accounts are dev/staging-only. Gated behind a dedicated
// flag rather than NODE_ENV alone — a staging environment can legitimately
// run with NODE_ENV=production while still wanting demo logins, and vice
// versa. Never rely on NODE_ENV !== "production" as the sole gate for
// something this sensitive (it silently reveals real merchant emails and
// the shared seed password to any visitor otherwise).
//
// DEPLOYMENT NOTE: NEXT_PUBLIC_* vars are inlined at BUILD time, not read
// at runtime in the browser. This gate only works if staging and
// production are built separately with different values for this
// variable — deploying one shared build artifact to both environments
// with a runtime env override does NOT change this flag's baked-in value.
const SHOW_DEMO_LOGINS = process.env.NEXT_PUBLIC_SHOW_DEMO_LOGINS === "true";

const DEMO_ACCOUNTS = [
  { label: "👑 أدمن البركة (نشط)", email: "admin@albaraka.com", tone: "demoPurple", wide: false },
  { label: "💳 كاشير البركة", email: "cashier@albaraka.com", tone: "demoBlue", wide: false },
  { label: "⚠️ أدمن النور (اشتراك منتهي)", email: "admin@alnoor.com", tone: "demoRed", wide: true },
] as const;

// FIX (open redirect): only ever trust callbackUrl if it's a same-app
// relative path. `callbackUrl` arrives via a query param the user's browser
// URL bar fully controls — not just via the middleware's own generation
// (see middleware.ts's `loginUrl.searchParams.set("callbackUrl", pathname)`,
// which is safe on its own, but nothing stops someone from sharing a
// hand-crafted `/login?callbackUrl=https://evil.example.com` link instead).
// A leading single "/" that is NOT a protocol-relative "//" is the standard
// safe-relative-path check.
//
// [FIX — ROLE-AWARE REDIRECT] Previously defaulted to "/dashboard" when no
// callbackUrl was present at all, meaning a CASHIER logging in directly
// from /login (the common case — no middleware ever redirected them here)
// would land on /dashboard first and only THEN get bounced to
// /dashboard/pos by middleware.ts's own CASHIER-landing-page check — an
// unnecessary extra redirect hop on every single CASHIER login. This now
// returns `null` (not a string) when no callbackUrl is present, so the
// caller can distinguish "no explicit destination was requested" (decide
// by role) from "middleware explicitly sent the user somewhere" (respect
// that destination as-is, e.g. returning to a page they were trying to
// reach before being bounced to /login).
function sanitizeCallbackUrl(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    return raw;
  }
  return null;
}

// Role-based default landing page, used only when no explicit callbackUrl
// was supplied — see sanitizeCallbackUrl's comment above. Mirrors T2b's
// Role Capability Matrix: CASHIER's default landing page is /dashboard/pos
// (analytics/KPIs at /dashboard is ADMIN-only), ADMIN's is /dashboard.
function defaultLandingPageForRole(role: string | undefined): string {
  return role === "CASHIER" ? "/pos" : "/dashboard";
}

function LoginFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const explicitCallbackUrl = sanitizeCallbackUrl(searchParams.get("callbackUrl"));
  // The register page sends users here with ?registered=true when its
  // automatic sign-in did not succeed.
  const justRegistered = searchParams.get("registered") === "true";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
          // FIX: auth.ts's rate-limit failure is a named CredentialsSignin
          // subclass with `code = "RateLimited"`. With `redirect: false`,
          // Auth.js surfaces that code verbatim as `res.error` — NOT the
          // original error message text — so this must match the code
          // exactly, not sniff for a substring of a message that no longer
          // exists. Any other error type (wrong password, inactive user,
          // missing user) falls through to the generic message, which is
          // intentional — Auth.js deliberately doesn't distinguish those
          // from each other to avoid leaking which part was wrong.
          const message =
            res.error === "RateLimited"
              ? "محاولات دخول كثيرة جداً. الرجاء الانتظار بضع دقائق قبل إعادة المحاولة."
              : "بيانات الدخول غير صحيحة. يرجى التثبت من البريد الإلكتروني وكلمة المرور.";
          setError(message);
          setIsLoading(false);
          return;
        }

        // [FIX — ROLE-AWARE REDIRECT] If the user arrived at /login with an
        // explicit callbackUrl (e.g. bounced here by middleware while
        // trying to reach a specific protected page), that destination is
        // always respected as-is — it's already the correct place for them
        // regardless of role. Only when there was NO explicit destination
        // do we decide where to send them, based on their actual role —
        // fetched fresh from the session that signIn() just established,
        // never assumed or hardcoded to "/dashboard" for everyone.
        let destination = explicitCallbackUrl;
        if (!destination) {
          const freshSession = await getSession();
          destination = defaultLandingPageForRole(freshSession?.user?.role);
        }

        router.push(destination);
        router.refresh();
      } catch (err) {
        console.error(err);
        setError("حدث خطأ أثناء الاتصال بالخادم.");
        setIsLoading(false);
      }
    },
    [explicitCallbackUrl, router]
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim();

    // The form uses noValidate so every message is Arabic (not the browser's).
    if (!cleanEmail || !password) {
      setError("يرجى إدخال البريد الإلكتروني وكلمة المرور.");
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) {
      setError("يرجى إدخال بريد إلكتروني صحيح.");
      return;
    }

    void performLogin(cleanEmail, password);
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
    <div className={s.card}>
      <h1 className={s.title}>تسجيل الدخول</h1>
      <p className={s.sub}>
        تسجيل الدخول الموحد لمدراء المتاجر والكاشير للوصول للوحة التحكم ونقطة البيع.
      </p>

      {justRegistered && !error && (
        <div role="status" className={s.success}>
          <Check size={18} aria-hidden />
          <span>تم إنشاء حسابك. سجّل الدخول للمتابعة.</span>
        </div>
      )}

      {error && (
        <div role="alert" className={s.alert}>
          <AlertCircle size={18} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className={s.form}>
        <div className={s.field}>
          <label htmlFor="email" className={s.label}>
            البريد الإلكتروني
          </label>
          <div className={s.control}>
            <Mail size={18} className={s.icon} aria-hidden />
            <input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              placeholder="name@merchant.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isLoading}
              className={`${s.input} ${s.inputLtr}`}
            />
          </div>
        </div>

        <div className={s.field}>
          <label htmlFor="password" className={s.label}>
            كلمة المرور
          </label>
          <div className={s.control}>
            <Lock size={18} className={s.icon} aria-hidden />
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoading}
              className={`${s.input} ${s.inputLtr} ${s.inputPw}`}
            />
            <button
              type="button"
              className={s.toggle}
              onClick={() => setShowPassword((v) => !v)}
              disabled={isLoading}
              aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
            </button>
          </div>
        </div>

        <button type="submit" disabled={isLoading} className={s.submit}>
          {isLoading ? (
            <>
              <Loader2 size={20} className={s.spin} aria-hidden />
              <span>جاري تسجيل الدخول...</span>
            </>
          ) : (
            <span>تسجيل الدخول</span>
          )}
        </button>
      </form>

      <p className={s.foot}>
        تاجر جديد؟ <Link href="/register">أنشئ حساب متجرك الآن</Link>
      </p>

      {/* Demo quick-login: dev/staging only, gated by NEXT_PUBLIC_SHOW_DEMO_LOGINS. */}
      {SHOW_DEMO_LOGINS && (
        <div className={s.demo}>
          <p className={s.demoTitle}>
            <ShieldCheck size={16} aria-hidden />
            <span>حسابات سريعة للتجربة (بيئة الاختبار فقط):</span>
          </p>
          <div className={s.demoGrid}>
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                disabled={isLoading}
                onClick={() => handleQuickLogin(account.email)}
                className={`${s.demoBtn} ${s[account.tone]} ${account.wide ? s.demoWide : ""}`}
              >
                {account.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LoginFallback() {
  return (
    <div className={s.card} aria-busy="true">
      <div className={s.skel}>
        <div className={s.skelBar} style={{ width: "45%", height: 28 }} />
        <div className={s.skelBar} style={{ width: "85%" }} />
        <div className={s.skelBar} style={{ height: 46, marginTop: 10 }} />
        <div className={s.skelBar} style={{ height: 46 }} />
        <div className={s.skelBar} style={{ height: 52 }} />
      </div>
      <span className={s.srOnlyText}>جاري تحميل الصفحة...</span>
    </div>
  );
}

const PANEL_POINTS = [
  {
    title: "بيع بدون إنترنت",
    body: "تُحفظ الفواتير على الجهاز وتُرفع تلقائياً عندما يعود الاتصال.",
  },
  {
    title: "الليرة هي الحساب",
    body: "الديون والدفعات بالليرة السورية، والدولار للاطلاع فقط.",
  },
  {
    title: "صلاحيات واضحة",
    body: "المدير يدير المخزون والديون، والكاشير يبيع من شاشة نقطة البيع.",
  },
];

export default function LoginPage() {
  return (
    <AuthShell
      numbered={false}
      panelTitle="أهلاً بعودتك إلى جملة تك"
      panelLead="أدر مبيعاتك ومخزونك وديون زبائنك من مكان واحد، حتى لو انقطع الإنترنت."
      points={PANEL_POINTS}
    >
      <Suspense fallback={<LoginFallback />}>
        <LoginFormContent />
      </Suspense>
    </AuthShell>
  );
}