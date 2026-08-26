import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight, ShoppingCart } from "lucide-react";

type StorefrontCartProps = {
  params: Promise<{ tenantSlug: string }>;
};

export default async function StorefrontCartPage({ params }: StorefrontCartProps) {
  const { tenantSlug } = await params;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col p-6 py-12">
      <div className="flex items-center gap-2 mb-6 text-sm text-zinc-500">
        <Link href={`/store/${tenantSlug}`} className="hover:underline flex items-center gap-1">
          <ArrowRight className="h-4 w-4" />
          <span>العودة للمتجر ({tenantSlug})</span>
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
          <ShoppingCart className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">سلة الطلبات الذاتية</h1>
          <p className="text-xs text-zinc-500">مراجعة المنتجات وإرسال الطلب المباشر للمتجر.</p>
        </div>
      </div>

      <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <ShoppingCart className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600" />
        <h2 className="mt-4 text-lg font-bold">السلة فارغة حالياً</h2>
        <p className="mt-1 text-xs text-zinc-500">قم بتصفح المنتجات في الكتالوج وإضافتها إلى السلة.</p>
        <Button asChild className="mt-6 bg-emerald-600 hover:bg-emerald-700 text-white">
          <Link href={`/store/${tenantSlug}`}>تصفح الكتالوج</Link>
        </Button>
      </div>
    </main>
  );
}
