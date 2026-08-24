type StorefrontPageProps = {
  params: Promise<{ tenantSlug: string }>;
};

export default async function StorefrontPage({ params }: StorefrontPageProps) {
  const { tenantSlug } = await params;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-12">
      <p className="text-sm uppercase tracking-wider text-zinc-500">المتجر الإلكتروني</p>
      <h1 className="mt-2 text-3xl font-semibold text-zinc-900">{tenantSlug}</h1>
      <p className="mt-4 text-sm text-zinc-600">
        كتالوج رقمي على مدار الساعة لطلبات تجار التجزئة الذاتية.
      </p>
    </main>
  );
}
