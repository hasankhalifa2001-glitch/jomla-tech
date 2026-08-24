import Link from "next/link";

export default function MarketingPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24">
      <div className="max-w-3xl text-center">
        <p className="text-sm font-medium uppercase tracking-wider text-zinc-500">
          جملة تك
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">
          منصة تجارة جملة برمجية متعددة المستأجرين للتجار العصريين
        </h1>
        <p className="mt-6 text-lg leading-8 text-zinc-600">
          نقطة بيع تعمل بدون إنترنت، دفتر ديون ذكي، متجر إلكتروني للجملة، وفواتير ثنائية العملة مصممة لنشاطات تجارة الجملة.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link
            href="/register"
            className="rounded-full bg-zinc-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-zinc-700"
          >
            بدء الانضمام
          </Link>
          <Link
            href="/login"
            className="rounded-full border border-zinc-300 px-6 py-3 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50"
          >
            تسجيل الدخول
          </Link>
        </div>
      </div>
    </main>
  );
}

