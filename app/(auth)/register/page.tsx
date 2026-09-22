/* app/(auth)/register/page.tsx */
"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Phone,
  Store,
  User,
} from "lucide-react";
import s from "@/components/auth/auth.module.css";
import { AuthShell } from "@/components/auth/auth-shell";

// Kept in sync with the server's RESERVED_SLUGS (app/api/auth/register/route.ts)
// so the client can reject/avoid these instantly instead of round-tripping
// to the server first. The server list stays the source of truth — this is
// purely a faster feedback loop, not a substitute for the server check.
const RESERVED_SLUGS = new Set([
  "login", "register", "admin", "api", "dashboard", "pos", "inventory",
  "ledger", "orders", "settings", "account-locked", "store", "www", "app",
]);

// Strips leading/trailing dashes too, and callers check the RESULT length
// rather than trusting any non-empty string.
function toSlug(val: string): string {
  return val
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Purely informational (the only enforced rule stays "at least 6 characters").
function passwordLevel(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 6) score++;
  if (pw.length >= 10) score++;
  if (/[a-zA-Z]/.test(pw) && /\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw) || (/[a-z]/.test(pw) && /[A-Z]/.test(pw))) score++;
  return Math.max(1, score) as 1 | 2 | 3 | 4;
}
const LEVEL_LABEL = ["", "ضعيفة", "متوسطة", "جيدة", "قوية"] as const;

const PANEL_POINTS = [
  {
    title: "سجّل متجرك",
    body: "ينشأ حساب المدير الأول، ويُجهَّز لك تلقائياً «زبون نقدي» للبيع النقدي السريع.",
  },
  {
    title: "حوّل قيمة الاشتراك",
    body: "اكتب رمز المرجع الذي يولّده النظام على الحوالة، وارفع صورة الإيصال.",
  },
  {
    title: "يُفعَّل حسابك",
    body: "بعد مطابقة الإيصال تفتح لك جميع الشاشات دون إعادة تسجيل دخول.",
  },
];

export default function RegisterPage() {
  const router = useRouter();

  const [tenantName, setTenantName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [slugTouchedManually, setSlugTouchedManually] = useState(false);
  const [phone, setPhone] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  // Bring the error into view (the form is long on small screens).
  useEffect(() => {
    if (errorMessage) {
      alertRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [errorMessage]);

  const handleSlugChange = (val: string) => {
    setSlugTouchedManually(true);
    setTenantSlug(toSlug(val));
  };

  // For an Arabic business name every character maps to "-", collapsing to
  // nothing usable. Only auto-fill when the derived slug is usable (>= 2
  // chars after stripping edge dashes); otherwise leave the field for the
  // merchant to fill in with a Latin identifier. Never overwrite a slug the
  // merchant already edited by hand (tracked via slugTouchedManually).
  const handleNameChange = (val: string) => {
    setTenantName(val);
    if (slugTouchedManually) return;
    const suggested = toSlug(val);
    if (suggested.length >= 2) {
      setTenantSlug(suggested);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
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

    if (RESERVED_SLUGS.has(tenantSlug)) {
      setErrorMessage("معرف المتجر هذا محجوز، الرجاء اختيار معرف آخر.");
      return;
    }

    // The form uses noValidate (so every message is Arabic), hence this check.
    if (!/^\S+@\S+\.\S+$/.test(adminEmail)) {
      setErrorMessage("يرجى إدخال بريد إلكتروني صحيح.");
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
        // Straight to billing: middleware would bounce a PENDING ADMIN there
        // anyway (see middleware.ts §3), this only skips one redirect hop.
        // The middleware stays the real enforcement point.
        router.push("/settings/billing?reason=pending");
        router.refresh();
      }
    } catch (err) {
      console.error("Registration error:", err);
      setErrorMessage("حدث خطأ في الاتصال أثناء التسجيل. يرجى المحاولة لاحقاً.");
      setIsLoading(false);
    }
  };

  // Live feedback for the slug field (does not replace the submit checks).
  const slugStatus: "empty" | "short" | "reserved" | "ok" = !tenantSlug
    ? "empty"
    : tenantSlug.length < 2
      ? "short"
      : RESERVED_SLUGS.has(tenantSlug)
        ? "reserved"
        : "ok";

  const level = passwordLevel(password);

  return (
    <AuthShell
      panelTitle="جهّز متجرك قبل موسم الحركة القادم"
      panelLead="يبقى الحساب في وضع الانتظار من لحظة التسجيل حتى مراجعة أول حوالة، ثم يُفعَّل مباشرة."
      points={PANEL_POINTS}
    >
      <div className={s.card}>
        <h1 className={s.title}>تسجيل تجار الجملة</h1>
        <p className={s.sub}>
          أنشئ مساحة العمل الخاصة بمنشأتك وادعُ فريق العمل لإدارة المبيعات والمخزون.
        </p>

        {errorMessage && (
          <div ref={alertRef} role="alert" className={s.alert}>
            <AlertCircle size={18} aria-hidden />
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className={s.form}>
          {/* 1. Business */}
          <fieldset className={s.group}>
            <p className={s.groupTitle}>
              <span className={s.groupNum}>1</span>
              بيانات المنشأة والمتجر
            </p>

            <div className={s.field}>
              <label htmlFor="tenantName" className={s.label}>
                اسم المتجر / الشركة<span className={s.req}>*</span>
              </label>
              <div className={s.control}>
                <Store size={18} className={s.icon} aria-hidden />
                <input
                  id="tenantName"
                  name="organization"
                  autoComplete="organization"
                  placeholder="مثال: تجارة البركة بالجملة"
                  value={tenantName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  className={s.input}
                  required
                />
              </div>
            </div>

            <div className={s.field}>
              <label htmlFor="tenantSlug" className={s.label}>
                معرف المتجر بالإنجليزية (Slug)<span className={s.req}>*</span>
              </label>
              <div className={s.slugGroup}>
                <span className={s.slugPrefix} aria-hidden>/store/</span>
                <input
                  id="tenantSlug"
                  name="slug"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="al-baraka"
                  value={tenantSlug}
                  onChange={(e) => handleSlugChange(e.target.value)}
                  className={s.slugInput}
                  aria-describedby="slugHint"
                  aria-invalid={slugStatus === "reserved" || slugStatus === "short"}
                  required
                />
              </div>
              <p
                id="slugHint"
                className={`${s.hint} ${slugStatus === "ok" ? s.hintOk : slugStatus === "reserved" ? s.hintErr : ""
                  }`}
              >
                {slugStatus === "ok" && (
                  <>
                    <Check size={14} aria-hidden />
                    <span>
                      رابط متجركم: <span dir="ltr" className={s.mono}>/store/{tenantSlug}</span>
                    </span>
                  </>
                )}
                {slugStatus === "reserved" && (
                  <>
                    <AlertCircle size={14} aria-hidden />
                    <span>هذا المعرف محجوز، اختر معرفاً آخر.</span>
                  </>
                )}
                {slugStatus === "short" && <span>معرف المتجر يجب أن يكون حرفين على الأقل.</span>}
                {slugStatus === "empty" && (
                  <span>
                    {tenantName
                      ? "الاسم العربي لا يُحوَّل تلقائياً، اكتب المعرف بأحرف إنجليزية (مثال: al-baraka)."
                      : "أحرف إنجليزية صغيرة وأرقام وشرطات فقط. سيكون رابط متجركم /store/المعرف."}
                  </span>
                )}
              </p>
            </div>

            <div className={s.field}>
              <label htmlFor="phone" className={s.label}>
                رقم الهاتف (اختياري)
              </label>
              <div className={s.control}>
                <Phone size={18} className={s.icon} aria-hidden />
                <input
                  id="phone"
                  name="tel"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+963 911 223 344"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={`${s.input} ${s.inputLtr}`}
                />
              </div>
            </div>
          </fieldset>

          {/* 2. Admin account */}
          <fieldset className={s.group}>
            <p className={s.groupTitle}>
              <span className={s.groupNum}>2</span>
              حساب مدير المتجر (Admin)
            </p>

            <div className={s.field}>
              <label htmlFor="adminName" className={s.label}>
                اسم المدير المسؤول<span className={s.req}>*</span>
              </label>
              <div className={s.control}>
                <User size={18} className={s.icon} aria-hidden />
                <input
                  id="adminName"
                  name="name"
                  autoComplete="name"
                  placeholder="مثال: أحمد خليل"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  className={s.input}
                  required
                />
              </div>
            </div>

            <div className={s.field}>
              <label htmlFor="adminEmail" className={s.label}>
                البريد الإلكتروني<span className={s.req}>*</span>
              </label>
              <div className={s.control}>
                <Mail size={18} className={s.icon} aria-hidden />
                <input
                  id="adminEmail"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  placeholder="admin@example.com"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  className={`${s.input} ${s.inputLtr}`}
                  required
                />
              </div>
            </div>

            <div className={s.field}>
              <label htmlFor="password" className={s.label}>
                كلمة المرور<span className={s.req}>*</span>
              </label>
              <div className={s.control}>
                <Lock size={18} className={s.icon} aria-hidden />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${s.input} ${s.inputLtr} ${s.inputPw}`}
                  aria-describedby="pwHint"
                  required
                />
                <button
                  type="button"
                  className={s.toggle}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
                </button>
              </div>
              <div className={s.meter} data-level={level} aria-hidden>
                <i />
                <i />
                <i />
                <i />
              </div>
              <p id="pwHint" className={s.meterText}>
                {level === 0 ? "6 أحرف على الأقل." : `قوة كلمة المرور: ${LEVEL_LABEL[level]}`}
              </p>
            </div>
          </fieldset>

          <button type="submit" disabled={isLoading} className={s.submit}>
            {isLoading ? (
              <>
                <Loader2 size={20} className={s.spin} aria-hidden />
                <span>جاري إنشاء الحساب والمساحة...</span>
              </>
            ) : (
              <span>إنشاء متجر جديد للشركة</span>
            )}
          </button>
        </form>

        <p className={s.foot}>
          لديك حساب مسجل بالفعل؟ <Link href="/login">تسجيل الدخول</Link>
        </p>
      </div>
    </AuthShell>
  );
}