import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Store, Phone, ShoppingCart, DollarSign, PackageCheck, AlertCircle } from "lucide-react";

type StorefrontPageProps = {
  params: Promise<{ tenantSlug: string }>;
};

export default async function StorefrontPage({ params }: StorefrontPageProps) {
  const { tenantSlug } = await params;

  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    include: {
      products: {
        where: { isPublic: true },
        include: { units: true },
        take: 12,
      },
    },
  });

  if (!tenant) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center p-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 text-amber-600 mb-4">
          <AlertCircle className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">المتجر غير موجود</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          لم يتم العثور على أي متجر مسجل تحت الرابط ({tenantSlug}). يرجى التثبت من الرابط وإعادة المحاولة.
        </p>
        <Button asChild className="mt-6 bg-emerald-600 hover:bg-emerald-700">
          <Link href="/">العودة للرئيسية</Link>
        </Button>
      </main>
    );
  }

  const exchangeRate = tenant.dailyExchangeRate ? Number(tenant.dailyExchangeRate) : null;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans text-zinc-900 dark:text-zinc-100">
      {/* Store Header */}
      <header className="border-b border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-white font-bold shadow-md shadow-emerald-600/20">
              <Store className="h-7 w-7" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-extrabold tracking-tight">{tenant.name}</h1>
                <Badge variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-400 text-xs">
                  متجر جملة معتمد
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span>كتالوج رقمي متاح للطلبات المباشرة</span>
                {tenant.phone && (
                  <span className="flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    {tenant.phone}
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Daily Exchange Rate Badge */}
          <div className="flex items-center gap-3">
            {exchangeRate ? (
              <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200 px-3 py-1.5 text-xs font-semibold gap-1.5">
                <DollarSign className="h-3.5 w-3.5 text-emerald-600" />
                <span>سعر الصرف اليومي: {exchangeRate.toLocaleString("ar-SY")} ل.س / $</span>
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">
                سعر الصرف: غير محدد
              </Badge>
            )}

            <Button asChild size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
              <Link href={`/store/${tenantSlug}/cart`}>
                <ShoppingCart className="h-4 w-4" />
                <span>سلة الطلبات</span>
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Main Catalog View */}
      <main className="mx-auto max-w-6xl p-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-xl font-bold">المنتجات المتوفرة للجملة</h2>
            <p className="text-xs text-zinc-500">اختر الكميات واضغط لإضافة المنتجات لسلة الشراء المباشر.</p>
          </div>
          <Badge variant="secondary" className="text-xs">
            {tenant.products.length} منتج متاح
          </Badge>
        </div>

        {tenant.products.length === 0 ? (
          <Card className="p-12 text-center border-dashed">
            <PackageCheck className="mx-auto h-12 w-12 text-zinc-400" />
            <h3 className="mt-4 text-base font-semibold">لا توجد منتجات معروضة حالياً</h3>
            <p className="mt-1 text-xs text-zinc-500">
              لم يقم المتاجر بنشر أي منتجات في الكتالوج العام بعد.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {tenant.products.map((product) => {
              const primaryUnit = product.units[0];
              const priceUSD = primaryUnit ? Number(primaryUnit.priceUSD) : 0;
              const priceSYP = exchangeRate ? priceUSD * exchangeRate : null;

              return (
                <Card key={product.id} className="flex flex-col justify-between border-zinc-200 dark:border-zinc-800 hover:shadow-lg transition-shadow">
                  <CardHeader className="pb-3">
                    {product.category && (
                      <Badge variant="outline" className="w-fit text-[10px] mb-1">
                        {product.category}
                      </Badge>
                    )}
                    <CardTitle className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                      {product.name}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      الوحدة الأساسية: {primaryUnit?.unitName || "قطعة"}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="pb-4">
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400">
                        ${priceUSD.toFixed(2)}
                      </span>
                      {priceSYP && (
                        <span className="text-xs font-semibold text-zinc-500">
                          ({priceSYP.toLocaleString("ar-SY")} ل.س)
                        </span>
                      )}
                    </div>
                  </CardContent>

                  <CardFooter className="pt-0 border-t border-zinc-100 dark:border-zinc-900 pt-3 mt-auto">
                    <Button size="sm" variant="outline" className="w-full text-xs gap-2 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300">
                      <ShoppingCart className="h-3.5 w-3.5" />
                      <span>إضافة للطلب</span>
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
