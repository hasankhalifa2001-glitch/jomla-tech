import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [FIX] The raw, unscoped `prisma` client is only meant to be imported by a
// small documented allowlist of routes that legitimately run before any
// tenant/session context exists (registration, seed.ts, isPlatformAdmin-
// gated super-admin routes — see lib/db.ts's own header comment). This is
// an ordinary authenticated tenant route, not on that allowlist. It must go
// through `getTenantDb(tenantId)` instead, so every query on a
// tenant-scoped model gets `tenantId` injected automatically by the Prisma
// Client Extension rather than depending on every `where`/`data` clause in
// this file being hand-written correctly forever.
import { getTenantDb } from "@/lib/db/tenant-scope";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const unitSchema = z.object({
  unitName: z.string().min(1, "اسم الوحدة مطلوب"),
  conversionFactor: z.number().positive("معامل التحويل يجب أن يكون رقماً موجباً"),
  pricingCurrency: z.enum(["SYP", "USD"]).default("SYP"),
  // [FIX] `priceWholesale` is REQUIRED and must be strictly greater than
  // zero. The previous validator used `.min(0, ...)`, which — despite the
  // comment right above it explicitly saying "There is no legitimate case
  // where a merchant means to price a sellable unit at exactly 0" —
  // actually accepted 0 (and the Arabic message itself said "صفر أو
  // أكثر", contradicting the stated intent). `.positive()` is what the
  // comment always meant to enforce: a product being priced at zero is a
  // data bug, not a valid business state, and must be rejected with a
  // clear message rather than saved silently.
  priceWholesale: z.number().positive("سعر الجملة يجب أن يكون أكبر من صفر"),
  // [FIX — priceUSD removed] `ProductUnit.priceUSD` does not exist in
  // schema.prisma — it was removed in v3.1, replaced entirely by
  // `pricingCurrency` + `priceWholesale` + `priceRetail` (T1 acceptance
  // criteria: "No ProductUnit.priceUSD column exists anywhere in the
  // schema or generated client"). Accepting a `priceUSD` field from the
  // client and silently writing it into `priceWholesale` (as an earlier
  // version of this route did) reintroduces exactly the currency-mixup
  // risk already found and fixed in lib/inventory/csv-parser.ts: a unit
  // priced in SYP could have a raw USD-labeled number written straight
  // into its SYP-denominated price field with no conversion and no
  // warning, corrupting the price by orders of magnitude. There is no
  // legacy input path that still needs this field — it is removed, not
  // deprecated.
  priceRetail: z.number().min(0).optional().nullable(),
  barcode: z.string().optional().nullable(),
  barcodeSource: z.enum(["GS1", "INTERNAL"]).optional().nullable(),
  imageUrl: z.string().optional().nullable(),
});

const createProductSchema = z.object({
  name: z.string().min(1, "اسم المنتج مطلوب"),
  category: z.string().optional().nullable(),
  isPublic: z.boolean().optional().default(false),
  units: z.array(unitSchema).min(1, "يجب تقديم وحدة قياس واحدة على الأقل"),
  initialBatch: z
    .object({
      unitIndex: z.number().default(0),
      batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
      quantity: z.number(), // Can be negative for initial reconciliation
      expiryDate: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

// Narrow, honestly-named type for what this route actually reads back from
// Prisma before reshaping it for the response. Avoids the previous file's
// blanket `any` on every mapped row, which silently hid shape mistakes
// (e.g. the dead `u.priceUSD` read below that this fix removes).
type ProductUnitRow = {
  id: string;
  unitName: string;
  conversionFactor: Prisma.Decimal | number;
  pricingCurrency: string;
  priceWholesale: Prisma.Decimal | number;
  priceRetail: Prisma.Decimal | number | null;
  barcode: string | null;
  barcodeSource: string | null;
  imageUrl: string | null;
};

type ProductBatchRow = {
  id: string;
  batchNumber: string;
  quantity: Prisma.Decimal | number;
  unitId: string;
  expiryDate: Date | null;
  unit: { unitName: string; conversionFactor: Prisma.Decimal | number } | null;
};

type ProductRow = {
  id: string;
  name: string;
  category: string | null;
  isPublic: boolean;
  isActive: boolean;
  createdAt: Date;
  units: ProductUnitRow[];
  batches: ProductBatchRow[];
};

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const filter = searchParams.get("filter") || "all";

    // NOTE: `where: { isActive: true }` here is intentionally NOT paired
    // with `tenantId` — `getTenantDb(tenantId)` injects that automatically
    // on every call against a tenant-scoped model (Product included). See
    // lib/db/tenant-scope.ts's `WHERE_SCOPED_READ_OPS` handling.
    const products = (await db.product.findMany({
      where: {
        isActive: true,
      },
      include: {
        units: true,
        batches: {
          include: {
            unit: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    })) as unknown as ProductRow[];

    const now = new Date();

    const processedProducts = products.map((product) => {
      const baseUnit = product.units.find((u) => Number(u.conversionFactor) === 1) || product.units[0];
      const baseFactor = baseUnit ? Number(baseUnit.conversionFactor) : 1;

      let totalBaseStock = 0;
      let hasExpiringSoonBatch = false;
      let hasNegativeStockBatch = false;

      const processedBatches = product.batches.map((batch) => {
        const batchUnitFactor = batch.unit ? Number(batch.unit.conversionFactor) : 1;
        const batchQty = Number(batch.quantity);
        totalBaseStock += batchQty * batchUnitFactor;

        if (batchQty < 0) {
          hasNegativeStockBatch = true;
        }

        let daysToExpiry: number | null = null;
        let expiryStatus: "RED" | "YELLOW" | "NORMAL" = "NORMAL";

        if (batch.expiryDate) {
          const exp = new Date(batch.expiryDate);
          const diffMs = exp.getTime() - now.getTime();
          daysToExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

          if (daysToExpiry < 30) {
            expiryStatus = "RED";
          } else if (daysToExpiry < 60) {
            expiryStatus = "YELLOW";
          }

          if (daysToExpiry < 60) {
            hasExpiringSoonBatch = true;
          }
        }

        return {
          id: batch.id,
          batchNumber: batch.batchNumber,
          quantity: batchQty,
          unitId: batch.unitId,
          unitName: batch.unit?.unitName || "",
          expiryDate: batch.expiryDate,
          daysToExpiry,
          expiryStatus,
          isNegative: batchQty < 0,
        };
      });

      const totalStockInBase = totalBaseStock / baseFactor;
      // [FIX] Removed the dead `if (totalStockInBase < 0) hasNegativeStockBatch = true;`
      // that used to sit here — a sum of non-negative per-batch base
      // quantities can never itself come out negative unless a negative
      // batch already flipped `hasNegativeStockBatch` inside the loop
      // above, so that check could never actually fire. No behavior
      // change; just removing an unreachable branch.
      const isOutOfStock = totalStockInBase <= 0;

      return {
        id: product.id,
        name: product.name,
        category: product.category,
        isPublic: product.isPublic,
        isActive: product.isActive,
        createdAt: product.createdAt,
        units: product.units.map((u) => ({
          id: u.id,
          unitName: u.unitName,
          conversionFactor: Number(u.conversionFactor),
          pricingCurrency: u.pricingCurrency || "SYP",
          // [FIX] `u.priceUSD` removed — that column does not exist on
          // ProductUnit (see T1 acceptance criteria), so this fallback was
          // always dead code silently resolving to `undefined`.
          // `priceWholesale` is the only, always-present source of truth.
          priceWholesale: Number(u.priceWholesale ?? 0),
          priceRetail: u.priceRetail !== null && u.priceRetail !== undefined ? Number(u.priceRetail) : null,
          barcode: u.barcode,
          barcodeSource: u.barcodeSource,
          imageUrl: u.imageUrl,
        })),
        batches: processedBatches,
        totalStockInBase,
        baseUnitName: baseUnit?.unitName || "قطعة",
        hasExpiringSoonBatch,
        hasNegativeStockBatch,
        isOutOfStock,
      };
    });

    let filtered = processedProducts;

    if (q) {
      const lowerQ = q.toLowerCase();
      filtered = filtered.filter((p) => {
        const barcodeMatch = p.units.some((u) => u.barcode && u.barcode.toLowerCase().includes(lowerQ));
        const nameMatch = p.name.toLowerCase().includes(lowerQ);
        const categoryMatch = p.category && p.category.toLowerCase().includes(lowerQ);
        return barcodeMatch || nameMatch || categoryMatch;
      });

      filtered.sort((a, b) => {
        const aExactBarcode = a.units.some((u) => u.barcode && u.barcode.toLowerCase() === lowerQ);
        const bExactBarcode = b.units.some((u) => u.barcode && u.barcode.toLowerCase() === lowerQ);
        if (aExactBarcode && !bExactBarcode) return -1;
        if (!aExactBarcode && bExactBarcode) return 1;
        return 0;
      });
    }

    if (filter === "public") {
      filtered = filtered.filter((p) => p.isPublic);
    } else if (filter === "expiring") {
      filtered = filtered.filter((p) => p.hasExpiringSoonBatch);
    } else if (filter === "out_of_stock") {
      filtered = filtered.filter((p) => p.isOutOfStock);
    } else if (filter === "needs_reconciliation") {
      // [FIX] Dropped the redundant "reconcile" alias — the client now
      // sends exactly one value ("needs_reconciliation", matching the
      // FilterTab type in InventoryClient.tsx) for this filter, so there
      // is no longer a second accepted spelling to keep in sync here.
      filtered = filtered.filter((p) => p.hasNegativeStockBatch);
    }

    return NextResponse.json({
      success: true,
      products: filtered,
    });
  } catch (error) {
    console.error("Error fetching inventory products:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب المنتجات." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // ADMIN-only: creating a catalog product is a pricing/catalog decision,
    // not a day-to-day operational task a cashier performs.
    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "إضافة منتجات جديدة متاحة لمدير المتجر فقط." },
        { status: 403 }
      );
    }

    // [v3.5] Locked out identically for EXPIRED and PENDING — a tenant
    // awaiting first Super-Admin approval has no more write access than one
    // whose subscription has lapsed.
    if (session.user.subscriptionStatus === "EXPIRED" || session.user.subscriptionStatus === "PENDING") {
      return NextResponse.json(
        { error: "SUBSCRIPTION_LOCKED", message: "اشتراكك منتهي أو معلق. لا يمكنك إضافة منتجات جديدة." },
        { status: 403 }
      );
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    const body = await req.json();
    const validation = createProductSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "البيانات المدخلة غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { name, category, isPublic, units, initialBatch } = validation.data;

    // PUBLISHING GATE RULE: [FIX] block isPublic = true unless imageUrl is
    // filled in on at least one unit. `priceWholesale` is already required
    // and strictly positive on every unit (see unitSchema above), so a
    // real, charge-able price is guaranteed by construction and never
    // needs to be re-checked here. `priceRetail` is a separate, optional
    // "suggested resale price" hint shown to a buying retailer on the
    // storefront (see ProductUnit.priceRetail in schema.prisma) — it is
    // NEVER itself charged on any sale, POS or storefront alike, and must
    // not be a precondition for publishing: a wholesaler listing plain
    // wholesale-priced cartons with no suggested retail number attached
    // must be able to.
    if (isPublic) {
      const isPublishable = units.some(
        (u) =>
          u.imageUrl !== undefined &&
          u.imageUrl !== null &&
          u.imageUrl.trim().length > 0
      );
      if (!isPublishable) {
        return NextResponse.json(
          {
            error: "PUBLISH_GATE_BLOCKED",
            message: "لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج على الأقل.",
          },
          { status: 400 }
        );
      }
    }

    // [NOTE] This pre-check still uses the tenant-scoped `db`, so
    // `tenantId` is injected automatically into the `findUnique` lookup
    // via the compound key below — it does not need to be passed a second
    // time inside `where`.
    for (const unit of units) {
      if (unit.barcode) {
        const existingBarcode = await db.productUnit.findUnique({
          where: {
            tenantId_barcode: {
              tenantId,
              barcode: unit.barcode,
            },
          },
        });
        if (existingBarcode) {
          return NextResponse.json(
            { error: "BARCODE_EXISTS", message: `الباركود (${unit.barcode}) مستخدم بالفعل لمنتج آخر.` },
            { status: 400 }
          );
        }
      }
    }

    // [FIX] `tx: any` removed. The blanket `any` on this callback (and on
    // every row mapped from it) erased type checking for the entire
    // transaction body — the same category of problem documented and
    // fixed in lib/inventory/fifo.ts, where a hand-rolled client alias
    // silently forced unsafe casts everywhere it was used.
    //
    // [FIX — corrected from an earlier, wrong assumption] `tx`'s type is
    // deliberately left to TypeScript's inference here rather than
    // annotated as `Prisma.TransactionClient`. `getTenantDb(tenantId)`
    // returns an EXTENDED client, and calling `$transaction(...)` on an
    // extended client hands the callback a `tx` that is itself the
    // extended client's own transaction shape (`DynamicClientExtensionThis<...>`),
    // not the plain `Prisma.TransactionClient` type — forcing that
    // annotation produces a real type error, since the two shapes are not
    // assignable to each other. Letting TypeScript infer `tx`'s type from
    // `db.$transaction` is what makes a typo like `tx.productUnti.create(...)`
    // fail to compile instead of failing at runtime, without fighting the
    // extended client's actual generic type.
    //
    // Practical consequence: because `tx` here carries the SAME tenant-
    // scoping query extension as `db` (Prisma applies `$extends` query
    // interceptors inside interactive transactions too, not just at the
    // top level), every `tx.<tenantScopedModel>.create/update/...` call
    // below already has `tenantId` auto-injected by the extension, exactly
    // like calls made directly on `db`. The explicit `tenantId` fields
    // still written into `data` below are therefore redundant with what
    // the extension would inject on its own — but they are kept
    // deliberately, as defense-in-depth: they cost nothing (the extension
    // simply overwrites `tenantId` with the same closed-over value), and
    // they mean this code stays correct even if a future Prisma version
    // or refactor changes whether the extension propagates into `tx`.
    const createdProduct = await db.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          tenantId,
          name,
          category: category || null,
          isPublic: !!isPublic,
        },
      });

      const unitIds: string[] = [];
      const createdUnits: ProductUnitRow[] = [];
      for (const u of units) {
        // [FIX] `u.priceUSD` fallback removed — `priceWholesale` is now a
        // required, strictly-positive field on the validated input (see
        // unitSchema above), so there is no ambiguity or fallback needed
        // here at all.
        const createdUnit = await tx.productUnit.create({
          data: {
            tenantId,
            productId: product.id,
            unitName: u.unitName,
            conversionFactor: u.conversionFactor,
            pricingCurrency: u.pricingCurrency || "SYP",
            priceWholesale: u.priceWholesale,
            priceRetail: u.priceRetail !== undefined ? u.priceRetail : null,
            barcode: u.barcode || null,
            barcodeSource: u.barcodeSource || null,
            imageUrl: u.imageUrl || null,
          },
        });
        unitIds.push(createdUnit.id);
        createdUnits.push(createdUnit as unknown as ProductUnitRow);

        // GS1 shared catalog registration/update
        if (u.barcodeSource === "GS1" && u.barcode?.trim()) {
          const barcodeTrim = u.barcode.trim();
          const existingCatalog = await tx.productCatalogEntry.findUnique({
            where: { barcode: barcodeTrim },
          });
          if (!existingCatalog) {
            await tx.productCatalogEntry.create({
              data: {
                barcode: barcodeTrim,
                name,
                category: category || null,
                imageUrl: u.imageUrl || null,
                addedByTenantId: tenantId,
              },
            });
          } else if (existingCatalog.addedByTenantId === tenantId) {
            await tx.productCatalogEntry.update({
              where: { barcode: barcodeTrim },
              data: {
                name,
                category: category || null,
                imageUrl: u.imageUrl || existingCatalog.imageUrl,
              },
            });
          }
        }
      }

      if (initialBatch) {
        const selectedUnitId = unitIds[initialBatch.unitIndex] ?? unitIds[0];
        await tx.productBatch.create({
          data: {
            tenantId,
            productId: product.id,
            unitId: selectedUnitId,
            batchNumber: initialBatch.batchNumber,
            quantity: initialBatch.quantity,
            expiryDate: initialBatch.expiryDate ? new Date(initialBatch.expiryDate) : null,
          },
        });
      }

      return { ...product, units: createdUnits };
    });

    // [FIX] Every Decimal-typed field coming back from Prisma
    // (conversionFactor, priceWholesale, priceRetail) is explicitly
    // unwrapped with `Number(...)` before being serialized into the JSON
    // response. Prisma.Decimal instances survive `NextResponse.json(...)`
    // via their own `toJSON()` (which returns a STRING, not a number) —
    // silently changing the wire type a frontend consumer receives
    // depending on which code path produced the object. The GET handler
    // above already does this correctly for its own response; POST's
    // response previously did not, returning raw Decimal-serialized
    // strings for a freshly created product while GET returned numbers for
    // the exact same fields.
    const responseProduct = {
      ...createdProduct,
      units: createdProduct.units.map((u) => ({
        ...u,
        conversionFactor: Number(u.conversionFactor),
        priceWholesale: Number(u.priceWholesale),
        priceRetail: u.priceRetail !== null && u.priceRetail !== undefined ? Number(u.priceRetail) : null,
      })),
    };

    return NextResponse.json({
      success: true,
      product: responseProduct,
      message: "تم إنشاء المنتج بنجاح.",
    });
  } catch (error) {
    // A unique-constraint violation on (tenantId, barcode) can still slip
    // through the pre-check above under concurrent requests (two identical
    // imports/submissions racing each other) — surface it as the same
    // friendly Arabic message instead of a generic 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "BARCODE_EXISTS", message: "أحد الباركودات المدخلة مستخدم بالفعل لمنتج آخر." },
        { status: 400 }
      );
    }
    console.error("Error creating product:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إضافة المنتج." }, { status: 500 });
  }
}