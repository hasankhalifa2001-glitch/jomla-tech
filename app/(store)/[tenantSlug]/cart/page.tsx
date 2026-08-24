import Link from "next/link";

type StoreCartPageProps = {
  params: Promise<{ tenantSlug: string }>;
};

export default async function StoreCartPage({ params }: StoreCartPageProps) {
  const { tenantSlug } = await params;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-12">
      <Link
        href={`/${tenantSlug}`}
        className="text-sm font-medium text-zinc-600 hover:text-zinc-900"
      >
        العودة إلى المتجر
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-zinc-900">سلة التسوق</h1>
      <p className="mt-2 text-sm text-zinc-600">
        إرسال طلب تجار التجزئة لـ {tenantSlug}.
      </p>
    </main>
  );
}
