import type { Metadata } from "next";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Boxes,
  Check,
  ChevronDown,
  Coins,
  Minus,
  Printer,
  Store,
  WifiOff,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import OfflineSection from "./OfflineSection";
import s from "./marketing.module.css";

/**
 * app/(marketing)/page.tsx
 * + app/(marketing)/marketing.module.css
 * + app/(marketing)/OfflineSection.tsx  (the only client component)
 *
 * Server component. Styling and motion live in marketing.module.css so the
 * layout does not depend on Tailwind's class generation. Colors follow the
 * platform design system (T2): emerald = SYP, purple = derived USD,
 * amber = debt / pending.
 *
 * All amounts, names and rates below are illustrative sample data.
 */

export const metadata: Metadata = {
  title: "جملة تك | نقطة بيع ودفتر ديون لتجار الجملة، تعمل بدون إنترنت",
  description:
    "نظام لإدارة تجارة الجملة: نقطة بيع تعمل بدون إنترنت، مخزون بالدفعات وتواريخ الصلاحية، دفتر ديون بالليرة السورية، ومتجر إلكتروني لتجار المفرّق.",
};

const delay = (seconds: number): CSSProperties => ({ animationDelay: `${seconds}s` });

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function TornEdge({ flip = false }: { flip?: boolean }) {
  const teeth = 24;
  const step = 12;
  const points = [
    "0,0",
    ...Array.from(
      { length: teeth },
      (_, i) => `${i * step + step / 2},8 ${(i + 1) * step},0`,
    ),
  ].join(" ");
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${teeth * step} 8`}
      preserveAspectRatio="none"
      className={flip ? `${s.tear} ${s.tearFlip}` : s.tear}
    >
      <polygon points={points} fill="#ffffff" />
    </svg>
  );
}

function Barcode() {
  const bars = [2, 1, 3, 1, 2, 1, 1, 3, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 3, 1];
  const total = bars.reduce((sum, w) => sum + w + 1, 0);
  const offsets = bars.map((_, i) =>
    bars.slice(0, i).reduce((sum, w) => sum + w + 1, 0),
  );
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${total} 28`}
      preserveAspectRatio="none"
      className={s.barcode}
    >
      {bars.map((w, i) => (
        <rect key={i} x={offsets[i]} y={0} width={w} height={28} fill="#1e293b" />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Hero visual: the printed receipt                                    */
/* ------------------------------------------------------------------ */

const receiptLines = [
  { name: "سكر أبيض، كيس 50 كغ", qty: "4", price: "650,000", total: "2,600,000" },
  { name: "زيت دوار الشمس، كرتونة", qty: "3", price: "750,000", total: "2,250,000" },
];

function Receipt() {
  return (
    <div className={s.receiptWrap}>
      {/* The stamp alternates between "saved locally" and "synced" (CSS only). */}
      <div className={s.stampSlot}>
        <div className={`${s.stamp} ${s.stampOffline}`}>
          <WifiOff size={14} aria-hidden />
          محفوظة على الجهاز، بانتظار المزامنة
        </div>
        <div aria-hidden className={`${s.stamp} ${s.stampSynced}`}>
          <Check size={14} aria-hidden />
          تمت المزامنة مع الخادم
        </div>
      </div>

      <div className={s.receiptPaper}>
        <TornEdge flip />
        <div className={s.receiptBody}>
          <div className={s.receiptHead}>
            <p className={s.shop}>مؤسسة الأمين للجملة</p>
            <p className={s.small}>فاتورة بيع رقم 1042</p>
            <p className={s.small}>الأحد، 2:32 مساءً</p>
          </div>

          <div className={s.dash} />

          <ul className={s.receiptLines}>
            {receiptLines.map((line) => (
              <li key={line.name} className={s.receiptLine}>
                <div>
                  <p className={s.lineName}>{line.name}</p>
                  <p className={`${s.small} ${s.num}`}>
                    {line.qty} × {line.price}
                  </p>
                </div>
                <p className={`${s.lineName} ${s.num}`}>{line.total}</p>
              </li>
            ))}
          </ul>

          <div className={s.dash} />

          <div className={s.totalRow}>
            <p className={s.small}>الإجمالي</p>
            <p className={`${s.totalSyp} ${s.num}`}>
              4,850,000
              <span className={s.cur}>ل.س</span>
            </p>
            <div className={s.usdRow}>
              <p className={s.usd}>
                ≈ <span dir="ltr">$373.08</span>
              </p>
              <p className={`${s.rate} ${s.num}`}>سعر الصرف 13,000</p>
            </div>
          </div>

          <div className={s.dash} />

          <dl className={s.facts}>
            <div className={s.fact}>
              <dt className={s.factLabel}>المدفوع</dt>
              <dd className={`${s.factValue} ${s.num}`}>2,000,000</dd>
            </div>
            <div className={s.fact}>
              <dt className={s.debtLabel}>الدين على الحساب</dt>
              <dd className={`${s.debtValue} ${s.num}`}>2,850,000</dd>
            </div>
            <div className={s.fact}>
              <dt className={s.factLabel}>الزبون</dt>
              <dd className={s.factValue}>متجر الأمل</dd>
            </div>
          </dl>

          <Barcode />
          <p className={s.thanks}>شكراً لتعاملكم معنا</p>
        </div>
        <TornEdge />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Marquee                                                             */
/* ------------------------------------------------------------------ */

const marqueeItems = [
  "نقطة بيع بدون إنترنت",
  "دفتر ديون وكشف حساب",
  "مخزون بالدفعات وتواريخ الصلاحية",
  "فاتورة بالليرة ومكافئ بالدولار",
  "متجر إلكتروني لتجار المفرّق",
  "طباعة حرارية 58 و80 مم",
  "كشف حساب عبر واتساب",
];

function Marquee() {
  // Two identical groups; the track moves by exactly one group width, so the
  // loop is seamless. Each group repeats the list so it is wider than the screen.
  const group = [...marqueeItems, ...marqueeItems];
  return (
    <div aria-hidden className={s.marquee}>
      <div className={s.marqueeTrack}>
        {[0, 1].map((g) => (
          <div key={g} className={s.marqueeGroup}>
            {group.map((text, i) => (
              <span key={i} className={s.marqueeItem}>
                {text}
                <i className={`${s.dot} ${s[`dot${i % 3}`]}`} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Features (ledger rows)                                              */
/* ------------------------------------------------------------------ */

type FeatureRow = {
  icon: LucideIcon;
  tone: "toneEmerald" | "tonePurple" | "toneAmber" | "toneSlate";
  title: string;
  body: string;
  extra?: ReactNode;
};

const featureRows: FeatureRow[] = [
  {
    icon: WifiOff,
    tone: "toneEmerald",
    title: "نقطة بيع لا تتوقف عند انقطاع الإنترنت",
    body: "يبيع الكاشير ويضيف زبوناً جديداً ويستلم الدفعات من ذاكرة الجهاز نفسه. تُحفظ كل فاتورة محلياً وتُرفع تلقائياً عندما يتوفر الاتصال.",
  },
  {
    icon: Coins,
    tone: "tonePurple",
    title: "فاتورة بالليرة ومكافئها بالدولار",
    body: "المبلغ الفعلي بالليرة السورية، ويظهر بجانبه المكافئ التقريبي بالدولار بسعر الصرف الذي كان ساري المفعول وقت البيع. الدولار للاطلاع فقط ولا يدخل في أي حساب.",
  },
  {
    icon: Boxes,
    tone: "toneSlate",
    title: "مخزون بالدفعات والوحدات",
    body: "بع الصنف بالقطعة أو العلبة أو الكرتونة، ويبقى رصيد المخزون دقيقاً دون كسور غريبة. يخرج الأقدم صلاحية أولاً، وتنبّهك الشاشة إلى الدفعات القريبة من الانتهاء والكميات التي تحتاج تسوية.",
  },
  {
    icon: BookOpen,
    tone: "toneAmber",
    title: "دفتر ديون وكشف حساب",
    body: "رصيد كل زبون يُحسب من فواتيره ودفعاته، ويمكنك إرسال كشف الحساب إليه عبر واتساب بضغطة واحدة. الفاتورة الملغاة تصفّر دينها تلقائياً.",
  },
  {
    icon: Store,
    tone: "toneEmerald",
    title: "متجر إلكتروني لتجار المفرّق",
    body: "رابط خاص بمتجرك يعرض أصنافك بأسعار الجملة. يرسل التاجر طلبه فيبقى بانتظار موافقتك، ولا يُخصم المخزون إلا عند الموافقة.",
    extra: (
      <p className={s.chip}>
        رابط متجرك
        <strong dir="ltr">/store/al-amin</strong>
      </p>
    ),
  },
  {
    icon: Printer,
    tone: "toneSlate",
    title: "طباعة حرارية ومشاركة",
    body: "أرسل الإيصال إلى طابعة حرارية مقاس 58 أو 80 مم عبر البلوتوث من متصفح Chrome، أو شاركه مع الزبون كرابط PDF على واتساب.",
  },
];

/* ------------------------------------------------------------------ */
/* Permissions table                                                   */
/* ------------------------------------------------------------------ */

type Cell = "yes" | "view" | "no";

const permissions: { action: string; cashier: Cell; admin: Cell }[] = [
  { action: "إنشاء فاتورة بيع وتسجيل زبون جديد", cashier: "yes", admin: "yes" },
  { action: "استعراض المخزون وتواريخ الصلاحية", cashier: "view", admin: "yes" },
  { action: "تعديل الأصناف وتسوية الكميات", cashier: "no", admin: "yes" },
  { action: "تسجيل تسديد دين", cashier: "no", admin: "yes" },
  { action: "إلغاء فاتورة", cashier: "no", admin: "yes" },
  { action: "اعتماد أو رفض طلبات الجملة", cashier: "view", admin: "yes" },
  { action: "تعديل سعر الصرف وإدارة الموظفين", cashier: "no", admin: "yes" },
];

function PermCell({ value }: { value: Cell }) {
  if (value === "yes") {
    return (
      <span className={s.permYes}>
        <Check size={20} aria-hidden />
        <span className={s.srOnly}>مسموح</span>
      </span>
    );
  }
  if (value === "view") {
    return <span className={s.permView}>عرض فقط</span>;
  }
  return (
    <span className={s.permNo}>
      <Minus size={20} aria-hidden />
      <span className={s.srOnly}>غير مسموح</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Steps + FAQ data                                                    */
/* ------------------------------------------------------------------ */

const steps = [
  {
    title: "سجّل متجرك",
    body: "ينشأ حساب المدير الأول، ويُجهَّز لك تلقائياً «زبون نقدي» للبيع النقدي السريع.",
  },
  {
    title: "حوّل قيمة الاشتراك",
    body: "عبر محفظة إلكترونية محلية أو حوالة بنكية. اكتب رمز المرجع الذي يولّده لك النظام على الحوالة، وارفع صورة الإيصال.",
  },
  {
    title: "يُفعَّل حسابك",
    body: "بعد مطابقة الإيصال مع رمز المرجع يُفعَّل الحساب، وتفتح لك جميع الشاشات دون إعادة تسجيل دخول.",
  },
];

const faqs = [
  {
    q: "هل أحتاج إلى الإنترنت أثناء البيع؟",
    a: "لا. تحتاجه مرة واحدة عند أول تشغيل على الجهاز لتنزيل أصنافك وزبائنك. بعدها يعمل البيع وتسجيل الزبائن والدفعات دون اتصال، وتُرفع الفواتير عند عودة الشبكة.",
  },
  {
    q: "على أي جهاز ومتصفح يعمل؟",
    a: "على الحاسوب والهاتف، بمتصفحات Chrome وEdge وOpera. متصفح Safari يدعم بقية المزايا، أما الطباعة الحرارية عبر البلوتوث فتحتاج متصفحاً مبنياً على Chromium.",
  },
  {
    q: "هل يتأثر دين الزبون بتغيّر سعر الصرف؟",
    a: "لا. الديون والدفعات مسجلة بالليرة السورية، والدولار يظهر للاطلاع فقط بسعر الصرف المثبّت وقت كل عملية.",
  },
  {
    q: "هل يستطيع تاجر آخر رؤية بياناتي؟",
    a: "لا. بيانات كل متجر معزولة عن غيره على مستوى النظام، ولا يصل إليها أي حساب يتبع متجراً آخر.",
  },
  {
    q: "كيف أستقبل طلبات تجار المفرّق؟",
    a: "تنشر الأصناف التي تريدها في متجرك الإلكتروني (يشترط أن يكون للصنف سعر مفرّق وصورة)، ويرسل التاجر طلبه من الرابط. يصلك الطلب في قائمة الانتظار، وعند موافقتك يتحول إلى فاتورة ويُخصم المخزون.",
  },
  {
    q: "ماذا يحدث إذا انتهى اشتراكي؟",
    a: "يتحول الحساب إلى وضع القراءة: لا تُسجَّل عمليات جديدة حتى التجديد، وتبقى بياناتك محفوظة. يُوجَّه المدير إلى صفحة الاشتراك، ويرى الكاشير رسالة توضيحية.",
  },
];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function MarketingPage() {
  return (
    <div className={s.page}>
      {/* Header */}
      <header className={s.header}>
        <div className={`${s.container} ${s.headerInner}`}>
          <Link href="/" className={s.brand}>
            <span aria-hidden className={s.brandMark}>ج</span>
            جملة تك
          </Link>

          <nav aria-label="أقسام الصفحة" className={s.nav}>
            <a href="#features">المزايا</a>
            <a href="#offline">العمل بدون إنترنت</a>
            <a href="#start">طريقة الاشتراك</a>
            <a href="#faq">الأسئلة الشائعة</a>
          </nav>

          <div className={s.headerActions}>
            <Link href="/login" className={s.linkBtn}>تسجيل الدخول</Link>
            <Link href="/register" className={`${s.btnPrimary} ${s.btnSm}`}>أنشئ حساباً</Link>
          </div>
        </div>
        <div aria-hidden className={s.progress} />
      </header>

      <main>
        {/* Hero */}
        <section className={s.hero}>
          <div aria-hidden className={s.heroRules} />
          <div aria-hidden className={`${s.orb} ${s.orbEmerald}`} />
          <div aria-hidden className={`${s.orb} ${s.orbPurple}`} />
          <div aria-hidden className={`${s.orb} ${s.orbAmber}`} />

          <div className={`${s.container} ${s.heroGrid}`}>
            <div>
              <h1 className={`${s.heroTitle} ${s.enter}`} style={delay(0.05)}>
                بيع، وسجّل الدين، واطبع الفاتورة،{" "}
                <span className={s.mark}>حتى لو انقطع الإنترنت</span>
              </h1>
              <p className={`${s.heroLead} ${s.enter}`} style={delay(0.2)}>
                جملة تك نظام لمحلات وتجار الجملة: نقطة بيع تعمل بدون اتصال، ومخزون بالدفعات وتواريخ الصلاحية، ودفتر ديون بالليرة السورية، ومتجر إلكتروني تستقبل منه طلبات تجار المفرّق.
              </p>
              <div className={`${s.heroActions} ${s.enter}`} style={delay(0.35)}>
                <Link href="/register" className={s.btnPrimary}>أنشئ حساب متجرك</Link>
                <a href="#offline" className={s.textLink}>كيف تعمل المزامنة؟</a>
              </div>
              <p className={`${s.heroNote} ${s.enter}`} style={delay(0.5)}>
                الاشتراك بتحويل محلي عبر محفظة إلكترونية أو حوالة بنكية، دون بطاقة بنكية.
              </p>
            </div>

            <Receipt />
          </div>
        </section>

        <Marquee />

        {/* Features */}
        <section id="features" className={`${s.bgWhite}`}>
          <div className={`${s.container} ${s.section}`}>
            <div className={`${s.headBlock} ${s.reveal}`}>
              <h2 className={s.h2}>كل ما يحتاجه محل الجملة في نظام واحد</h2>
              <p className={s.sectionLead}>
                من لحظة دخول البضاعة إلى المخزن حتى تحصيل آخر ليرة من دين الزبون.
              </p>
            </div>

            <ul className={s.rows}>
              {featureRows.map((row) => (
                <li key={row.title} className={`${s.row} ${s[row.tone]} ${s.reveal}`}>
                  <div className={s.rowHead}>
                    <span className={s.iconTile}>
                      <row.icon size={22} aria-hidden />
                    </span>
                    <h3 className={s.rowTitle}>{row.title}</h3>
                  </div>
                  <div>
                    <p className={s.rowBody}>{row.body}</p>
                    {row.extra}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Offline (client component: plays the sync story) */}
        <OfflineSection />

        {/* Currency */}
        <section className={s.borderBottom}>
          <div className={`${s.container} ${s.split}`}>
            <div className={s.reveal}>
              <h2 className={s.h2}>الليرة هي الحساب، والدولار للاطلاع فقط</h2>
              <p className={s.sectionLead}>
                تُسجَّل كل فاتورة ودين ودفعة بالليرة السورية. أما المكافئ بالدولار فيُحسب بسعر الصرف لحظة البيع ويبقى ثابتاً على تلك الفاتورة، فتغيير السعر لاحقاً لا يمسّ فواتيرك القديمة.
              </p>
            </div>

            <div>
              <div className={s.compare}>
                {[
                  { day: "فاتورة الأحد", rate: "13,000", usd: "$373.08" },
                  { day: "فاتورة الخميس", rate: "13,500", usd: "$359.26" },
                ].map((c) => (
                  <div key={c.day} className={`${s.compareCol} ${s.revealPop}`}>
                    <p className={s.compareDay}>{c.day}</p>
                    <p className={s.sypCell}>
                      4,850,000 <small>ل.س</small>
                    </p>
                    <p className={s.usdCell}>
                      ≈ <span dir="ltr">{c.usd}</span>
                    </p>
                    <p className={s.rateLine}>
                      سعر الصرف وقت البيع <span className={s.num}>{c.rate}</span>
                    </p>
                  </div>
                ))}
              </div>
              <p className={s.tableNote}>
                المبلغ نفسه بالليرة، وسعر الصرف تغيّر بين اليومين. كل فاتورة تحتفظ بسعرها.
              </p>
            </div>
          </div>
        </section>

        {/* Roles */}
        <section className={s.bgWhite}>
          <div className={`${s.container} ${s.split} ${s.splitRoles}`}>
            <div className={s.reveal}>
              <h2 className={s.h2}>المدير يقرر، والكاشير يبيع</h2>
              <p className={s.sectionLead}>
                تُفرض الصلاحيات من الخادم وليس بإخفاء الأزرار فقط، فلا يستطيع الكاشير تجاوزها حتى لو حاول.
              </p>
              <p className={s.para}>
                ولا تُعدَّل الفاتورة بعد إصدارها: يتم الإلغاء بقيد عكسي يعيد البضاعة إلى الدفعة نفسها ويصفّر الدين، ويبقى سجل ما جرى واضحاً لمن يراجعه.
              </p>
            </div>

            <div className={`${s.tableWrap} ${s.revealPop}`}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">الإجراء</th>
                    <th scope="col" className={`${s.center} ${s.narrow}`}>الكاشير</th>
                    <th scope="col" className={`${s.center} ${s.narrow}`}>المدير</th>
                  </tr>
                </thead>
                <tbody>
                  {permissions.map((p) => (
                    <tr key={p.action}>
                      <th scope="row">{p.action}</th>
                      <td className={s.center}><PermCell value={p.cashier} /></td>
                      <td className={s.center}><PermCell value={p.admin} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* How to start */}
        <section id="start" className={`${s.borderTop} ${s.borderBottom}`}>
          <div className={`${s.container} ${s.section}`}>
            <h2 className={`${s.h2} ${s.headBlock} ${s.reveal}`}>
              من التسجيل إلى أول فاتورة في ثلاث خطوات
            </h2>
            <ol className={s.stepsGrid}>
              {steps.map((step, i) => (
                <li key={step.title} className={`${s.stepCard} ${s.reveal}`}>
                  <span className={s.stepBadge}>{i + 1}</span>
                  <h3 className={s.stepTitle}>{step.title}</h3>
                  <p className={s.stepText}>{step.body}</p>
                </li>
              ))}
            </ol>
            <p className={`${s.notice} ${s.reveal}`}>
              يبقى الحساب في وضع الانتظار من لحظة التسجيل حتى مراجعة أول حوالة، ثم يُفعَّل مباشرة.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className={s.bgWhite}>
          <div className={`${s.container} ${s.section} ${s.faqGrid}`}>
            <h2 className={`${s.h2} ${s.reveal}`}>أسئلة يسألها التجار قبل الاشتراك</h2>
            <div className={s.faqList}>
              {faqs.map((item) => (
                <details key={item.q} className={s.faqItem}>
                  <summary className={s.faqSummary}>
                    {item.q}
                    <span className={s.faqChevron}>
                      <ChevronDown size={18} aria-hidden />
                    </span>
                  </summary>
                  <p className={s.faqAnswer}>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className={s.ctaSection}>
          <div className={s.container}>
            <div className={`${s.ctaBanner} ${s.revealPop}`}>
              <div aria-hidden className={`${s.ctaBubble} ${s.ctaBubble1}`} />
              <div aria-hidden className={`${s.ctaBubble} ${s.ctaBubble2}`} />
              <div className={s.ctaText}>
                <h2 className={s.ctaTitle}>جهّز متجرك قبل موسم الحركة القادم</h2>
                <p className={s.ctaLead}>سجّل الآن، وابدأ بإدخال أصنافك وزبائنك.</p>
              </div>
              <div className={s.ctaActions}>
                <Link href="/register" className={s.btnLight}>أنشئ حساب متجرك</Link>
                <Link href="/login" className={s.btnGhost}>تسجيل الدخول</Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className={s.footer}>
        <div className={`${s.container} ${s.footerInner}`}>
          <div className={s.footerBrand}>
            <span aria-hidden className={s.footerMark}>ج</span>
            جملة تك
          </div>
          <nav aria-label="روابط التذييل" className={s.footerNav}>
            <a href="#features">المزايا</a>
            <a href="#start">طريقة الاشتراك</a>
            <a href="#faq">الأسئلة الشائعة</a>
            <Link href="/login">تسجيل الدخول</Link>
          </nav>
          <p className={s.copy}>© {new Date().getFullYear()} جملة تك</p>
        </div>
      </footer>
    </div>
  );
}