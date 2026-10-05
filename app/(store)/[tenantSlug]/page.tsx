// eslint-disable-next-line no-restricted-imports
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Store, Phone, ShoppingCart, DollarSign, PackageCheck, AlertCircle, ImageOff } from "lucide-react";
import { convertCurrency, formatMoney, toDecimal } from "@/lib/utils/money";

// [v4.6] Unit type has NO imageUrl anymore — the image moved to Product.
// This type describes only what the storefront needs per unit for PRICE
// display; everything image-related is read from StorefrontProduct below.
type StorefrontProductUnit = {
  id: string;
  unitName: string;
  conversionFactor: Prisma.Decimal | number;
  pricingCurrency: string;
  priceWholesale: Prisma.Decimal | number;
  // [v4.5] Deliberately NO barcode field here. ProductUnit.barcode no longer
  // exists (barcodes live in the separate ProductUnitBarcode model), and the
  // query below never `include`s that relation — so the public, anonymous
  // storefront cannot expose a unit's barcode values even by accident. That is
  // the intended behaviour, not an oversight: this page renders a product's
  // name, category, image and prices only.
  isActive?: boolean;
};

type StorefrontProduct = {
  id: string;
  name: string;
  category: string | null;
  // [v4.6] THE ONE image for this product (moved here from ProductUnit).
  // Every display that needs an image reads THIS field — no per-unit image
  // exists and no unit-to-product fallback is ever done.
  imageUrl: string | null;
  units: StorefrontProductUnit[];
};

type StorefrontPageProps = {
  params: Promise<{ tenantSlug: string }>;
};

// [v4.6] Picks the unit to display for PRICE purposes only — the image
// now lives on the product, not the unit, so this helper no longer needs
// to check for a per-unit imageUrl. Preference order:
//   1. base unit (conversionFactor === 1) that is active
//   2. any other active unit
//   3. first unit (last-resort fallback)
function pickDisplayUnit(units: StorefrontProductUnit[]): StorefrontProductUnit | undefined {
  return (
    units.find((u) => Number(u.conversionFactor) === 1 && u.isActive !== false) ??
    units.find((u) => u.isActive !== false) ??
    units[0]
  );
}

export default async function StorefrontPage({ params }: StorefrontPageProps) {
  const { tenantSlug } = await params;

  // [NOTE] Raw `prisma` is intentional and required here — this route runs
  // with no session/tenantId (public storefront, visited by anonymous
  // retailers), so getTenantDb(tenantId) is not callable until AFTER the
  // Tenant is found by slug. `Tenant` itself is not in
  // TENANT_SCOPED_MODELS (it's the tenant registry, not a tenant-scoped
  // row), and `products` below is fetched via a relation `include` nested
  // under one specific Tenant row — Prisma can only return rows that
  // actually belong to that Tenant via the FK relation, so this is safe
  // despite using the unscoped client. Add "app/(store)/**" to the
  // no-restricted-imports allowlist in eslint.config.mjs alongside
  // registration/seed/admin routes.
  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    include: {
      products: {
        // [FIX] Added `isActive: true` — a soft-deleted product that was
        // previously isPublic must never remain visible on the public
        // storefront just because isPublic was never explicitly reset.
        where: { isPublic: true, isActive: true },
        select: {
          id: true,
          name: true,
          category: true,
          // [v4.6] Product-level image — the ONE image for the product card.
          imageUrl: true,
          units: {
            where: { isActive: true },
            select: {
              id: true,
              unitName: true,
              conversionFactor: true,
              pricingCurrency: true,
              priceWholesale: true,
              isActive: true,
            },
          },
        },
        // [FIX] Removed `take: 12`. A hard cap silently hid the rest of a
        // tenant's catalog with no pagination UI to reach it, and the
        // "N منتج متاح" badge below then reported the capped count (12)
        // as if it were the tenant's full public catalog size — actively
        // misleading for any tenant with more than 12 published products.
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

  // [FIX] Routed through toDecimal(...).toNumber() instead of a bare
  // Number(...) — a genuinely corrupted dailyExchangeRate now fails
  // loudly (caught below) instead of silently becoming NaN and quietly
  // breaking every price conversion on the page with no error surfaced.
  let exchangeRate: number | null = null;
  if (tenant.dailyExchangeRate) {
    try {
      exchangeRate = toDecimal(tenant.dailyExchangeRate.toString()).toNumber();
    } catch {
      exchangeRate = null;
    }
  }

  const products = (tenant.products as unknown as StorefrontProduct[]).filter(
    (product) => product.units && product.units.length > 0 && pickDisplayUnit(product.units)
  );

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
                <span>سعر الصرف اليومي: {formatMoney(exchangeRate, "SYP", 0)} ل.س / $</span>
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
            {products.length} منتج متاح
          </Badge>
        </div>

        {products.length === 0 ? (
          <Card className="p-12 text-center border-dashed">
            <PackageCheck className="mx-auto h-12 w-12 text-zinc-400" />
            <h3 className="mt-4 text-base font-semibold">لا توجد منتجات معروضة حالياً</h3>
            <p className="mt-1 text-xs text-zinc-500">
              لم يقم المتاجر بنشر أي منتجات في الكتالوج العام بعد.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => {
              const displayUnit = pickDisplayUnit(product.units);

              if (!displayUnit) {
                return null;
              }

              const currency = displayUnit.pricingCurrency || "SYP";
              const rawPriceStr = displayUnit.priceWholesale.toString();

              // [FIX] Currency conversion now goes through
              // lib/utils/money.ts's convertCurrency/formatMoney instead
              // of native +/-/*// on Number(Decimal) — same precision
              // discipline the rest of the system enforces for stored
              // money, applied here for display. Wrapped in try/catch
              // because convertCurrency throws (by design) on a zero/
              // negative rate — shown as "unavailable" rather than
              // silently displaying $0.00.
              let priceUSDDisplay: string | null = null;
              let priceSYPDisplay: string | null = null;
              try {
                if (currency === "USD") {
                  priceUSDDisplay = formatMoney(rawPriceStr, "USD");
                  if (exchangeRate) {
                    priceSYPDisplay = formatMoney(
                      convertCurrency(rawPriceStr, exchangeRate, "USD", "SYP"),
                      "SYP"
                    );
                  }
                } else {
                  priceSYPDisplay = formatMoney(rawPriceStr, "SYP");
                  if (exchangeRate) {
                    priceUSDDisplay = formatMoney(
                      convertCurrency(rawPriceStr, exchangeRate, "SYP", "USD"),
                      "USD"
                    );
                  }
                }
              } catch {
                // exchangeRate was invalid — leave conversion null, show
                // the base-currency price only rather than a wrong number.
              }

              return (
                <Card
                  key={product.id}
                  className="flex flex-col justify-between border-zinc-200 dark:border-zinc-800 hover:shadow-lg transition-shadow overflow-hidden"
                >
                  {/* [v4.6] Product image — one image per product, read from
                      product.imageUrl. No per-unit imageUrl exists anymore. */}
                  <div className="aspect-square w-full bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center overflow-hidden">
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageOff className="h-10 w-10 text-zinc-300" />
                    )}
                  </div>

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
                      الوحدة: {displayUnit.unitName}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="pb-4 space-y-1">
                    <div className="flex items-baseline gap-2">
                      {priceUSDDisplay ? (
                        <span className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400">
                          ${priceUSDDisplay}
                        </span>
                      ) : (
                        <span className="text-sm font-semibold text-zinc-400">السعر غير متاح حالياً</span>
                      )}
                      {priceSYPDisplay && (
                        <span className="text-xs font-semibold text-zinc-500">({priceSYPDisplay} ل.س)</span>
                      )}
                    </div>
                  </CardContent>

                  <CardFooter className="border-t border-zinc-100 dark:border-zinc-900 pt-3 mt-auto">
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs gap-2 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300"
                    >
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