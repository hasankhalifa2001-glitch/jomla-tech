import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
import { validatePackagingUnits } from "@/lib/inventory/conversions";
import { Prisma } from "@prisma/client";
import { z } from "zod";

// [FIX] Every field below backed by a Prisma Decimal(18,4) column
// (conversionFactor, priceWholesale, priceRetail, and initialBatch.quantity
// further down) is now accepted as a validated decimal STRING, never a
// native JS `number`. Same reasoning as the standalone batch-creation
// route's `quantity` fix: a JS double cannot exactly represent every value
// a Decimal(18,4) column can hold, and this project's decimal.js-everywhere
// rule (T1) exists precisely to keep numbers like these from ever passing
// through an IEEE-754 float on their way into a Decimal column. Prisma
// accepts a numeric string directly for a Decimal field and constructs an
// exact Prisma.Decimal from it with no float in between.
const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;

const positiveDecimalString = (message: string) =>
  z
    .string()
    .regex(DECIMAL_STRING_REGEX, message)
    .refine((val) => Number(val) > 0, { message });

const nonNegativeDecimalString = (message: string) =>
  z
    .string()
    .regex(DECIMAL_STRING_REGEX, message)
    .refine((val) => Number(val) >= 0, { message });

const unitSchema = z
  .object({
    unitName: z.string().min(1, "اسم الوحدة مطلوب"),
    conversionFactor: positiveDecimalString("معامل التحويل يجب أن يكون رقماً موجباً"),
    pricingCurrency: z.enum(["SYP", "USD"]).default("SYP"),
    priceWholesale: positiveDecimalString("سعر الجملة يجب أن يكون أكبر من صفر"),
    priceRetail: nonNegativeDecimalString("سعر التجزئة يجب أن يكون صفراً أو أكثر")
      .optional()
      .nullable(),
    barcode: z.string().optional().nullable(),
    barcodeSource: z.enum(["GS1", "INTERNAL"]).optional().nullable(),
    imageUrl: z.string().optional().nullable(),
    isActive: z.boolean().optional().default(true),
  })
  .refine(
    (u) => {
      if (u.barcode && u.barcode.trim().length > 0) {
        return u.barcodeSource === "GS1" || u.barcodeSource === "INTERNAL";
      }
      return true;
    },
    {
      message: "يجب تحديد مصدر الباركود (GS1 أو INTERNAL) عند إدخال باركود للوحدة.",
      path: ["barcodeSource"],
    }
  );

const createProductSchema = z.object({
  name: z.string().min(1, "اسم المنتج مطلوب"),
  category: z.string().optional().nullable(),
  isPublic: z.boolean().optional().default(false),
  units: z.array(unitSchema).min(1, "يجب تقديم وحدة قياس واحدة على الأقل"),
  initialBatch: z
    .object({
      unitIndex: z.number().default(0),
      batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
      // [FIX] was z.number() — see the file-header note.
      quantity: nonNegativeDecimalString("الكمية يجب أن تكون صفراً أو أكثر"),
      expiryDate: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

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
  isActive: boolean;
};

type ProductAdjustmentRow = {
  id: string;
  quantityDelta: Prisma.Decimal | number;
  reason: string;
  createdAt: Date;
  adjustedByUser?: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

type ProductBatchRow = {
  id: string;
  batchNumber: string;
  quantity: Prisma.Decimal | number;
  unitId: string;
  expiryDate: Date | null;
  unit: { unitName: string; conversionFactor: Prisma.Decimal | number } | null;
  adjustments?: ProductAdjustmentRow[];
  _count?: {
    invoiceItems: number;
    adjustments: number;
  };
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
    const status = searchParams.get("status");

    const whereClause: Prisma.ProductWhereInput = {};
    if (status === "active") {
      whereClause.isActive = true;
    } else if (status === "inactive" || filter === "inactive_products") {
      whereClause.isActive = false;
    }
    // NOTE (still flagged, unresolved — left as-is pending a product
    // decision, not a bug fix): unlike an earlier version of this route,
    // an omitted `status` param no longer defaults to "active" — a bare
    // GET now returns products regardless of isActive. Whether the
    // inventory screen's default (no filter selected) should show active
    // products only or everything is a product decision, not something
    // this pass changes unilaterally.

    const products = (await db.product.findMany({
      where: whereClause,
      include: {
        units: true,
        batches: {
          include: {
            unit: true,
            adjustments: {
              include: {
                adjustedByUser: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                  },
                },
              },
              orderBy: {
                createdAt: "desc",
              },
            },
            _count: {
              select: {
                invoiceItems: true,
                adjustments: true,
              },
            },
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
        // [NOTE] `batchQty` (a native number) is used ONLY for this route's
        // own internal, display-oriented arithmetic below (total base
        // stock, out-of-stock/expiry-badge derivation) — none of which is
        // itself a value persisted anywhere or fed back into a Decimal
        // column. It is deliberately kept separate from the `quantity`
        // field actually returned in the JSON response (see [FIX] below),
        // which must stay a decimal string all the way to the client.
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
          // [FIX — critical, closes the cache-refresh.ts contract gap]
          // Previously returned `batchQty` (a native `number`, derived via
          // `Number(batch.quantity)` above). ProductBatch.quantity is a
          // Decimal(18,4) column — converting it to a JS double here, before
          // it ever leaves the server, is exactly the precision-loss path
          // T1's decimal.js-everywhere rule exists to prevent, and directly
          // contradicts lib/offline/cache-refresh.ts's documented contract
          // for ServerProductBatch.quantity ("Expected as a decimal string
          // from the server... never a native JS number"). refreshProductCache()
          // reads this exact field into `createCachedProductRecord`, so a
          // `number` here meant the precision was already lost by the time
          // it reached the offline cache — no downstream fix could recover
          // it. `.toString()` on the raw Prisma Decimal preserves the exact
          // stored value with no float round-trip.
          quantity: batch.quantity.toString(),
          unitId: batch.unitId,
          unitName: batch.unit?.unitName || "",
          expiryDate: batch.expiryDate,
          daysToExpiry,
          expiryStatus,
          isNegative: batchQty < 0,
          adjustments: (batch.adjustments || []).map((adj) => ({
            id: adj.id,
            // [FIX] Same reasoning as batch.quantity above —
            // StockAdjustment.quantityDelta is also Decimal(18,4). This
            // field isn't part of cache-refresh.ts's ServerProductBatch
            // contract (adjustment history isn't cached offline), but it's
            // the same class of precision-sensitive value and is only ever
            // displayed/summed via lib/utils/money.ts on the client, so it
            // stays a decimal string here too rather than reintroducing a
            // float for no reason.
            quantityDelta: adj.quantityDelta.toString(),
            reason: adj.reason,
            adjustedByUserName:
              adj.adjustedByUser?.name || adj.adjustedByUser?.email || "مستخدم",
            createdAt: adj.createdAt,
          })),
          _count: {
            invoiceItems: batch._count?.invoiceItems || 0,
            adjustments: batch._count?.adjustments || 0,
          },
        };
      });

      const totalStockInBase = totalBaseStock / baseFactor;
      const isOutOfStock = totalStockInBase <= 0;

      const hasDiscontinuedUnitStock = product.units.some(
        (u) =>
          !u.isActive &&
          product.batches.some((b) => b.unitId === u.id && Number(b.quantity) > 0)
      );

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
          // [NOTE] conversionFactor stays a `number` here, matching
          // cache-refresh.ts's ServerProductUnit.conversionFactor contract
          // (also typed `number`, not `string`) and db.ts's
          // CachedProductUnit.conversionFactor — this field was never
          // flagged for the string-decimal treatment the way the monetary
          // fields below were.
          conversionFactor: Number(u.conversionFactor),
          pricingCurrency: u.pricingCurrency || "SYP",
          // [FIX — critical, closes the cache-refresh.ts contract gap]
          // Previously `Number(u.priceWholesale ?? 0)` /
          // `Number(u.priceRetail)`. Both are Decimal(18,4) columns, and
          // cache-refresh.ts's ServerProductUnit contract requires both as
          // decimal strings ("a deliberate contract with
          // /api/inventory/products: it must serialize every monetary
          // field with .toString()") — this route was silently violating
          // that documented contract. `.toString()` on the raw Prisma
          // Decimal preserves the exact stored value.
          priceWholesale: u.priceWholesale.toString(),
          priceRetail: u.priceRetail !== null && u.priceRetail !== undefined ? u.priceRetail.toString() : null,
          barcode: u.barcode,
          barcodeSource: u.barcodeSource,
          imageUrl: u.imageUrl,
          isActive: u.isActive !== false,
        })),
        batches: processedBatches,
        totalStockInBase,
        baseUnitName: baseUnit?.unitName || "قطعة",
        hasExpiringSoonBatch,
        hasNegativeStockBatch,
        hasDiscontinuedUnitStock,
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
      filtered = filtered.filter((p) => p.hasNegativeStockBatch);
    } else if (filter === "discontinued_unit_stock") {
      filtered = filtered.filter((p) => p.hasDiscontinuedUnitStock);
    } else if (filter === "inactive_products") {
      filtered = filtered.filter((p) => !p.isActive);
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

    assertRolePermission(session.user.role, "inventory:mutate");

    await assertTenantWritable(session.user.tenantId);

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

    const packagingCheck = validatePackagingUnits(units);
    if (!packagingCheck.valid) {
      return NextResponse.json(
        {
          error: "INVALID_PACKAGING_UNITS",
          message: packagingCheck.error,
        },
        { status: 400 }
      );
    }

    // PUBLISHING GATE: delegates to the single shared implementation in
    // lib/inventory/publishing-gate.ts.
    if (isPublic) {
      const gateCheck = checkProductPublishable({ isActive: true, units });
      if (!gateCheck.publishable) {
        return NextResponse.json(
          {
            error: "PUBLISH_GATE_BLOCKED",
            message: gateCheck.reason,
          },
          { status: 400 }
        );
      }
    }

    const incomingBarcodes = units
      .map((u) => u.barcode?.trim())
      .filter((b): b is string => !!b);

    if (new Set(incomingBarcodes).size !== incomingBarcodes.length) {
      return NextResponse.json(
        { error: "DUPLICATE_BARCODE", message: "لا يمكن تكرار نفس الباركود لأكثر من وحدة ضمن نفس الطلب." },
        { status: 400 }
      );
    }

    for (const barcode of incomingBarcodes) {
      const existingBarcode = await db.productUnit.findUnique({
        where: {
          tenantId_barcode: {
            tenantId,
            barcode,
          },
        },
        include: {
          product: { select: { name: true } },
        },
      });
      if (existingBarcode) {
        const statusText = existingBarcode.isActive ? "نشطة" : "متوقفة";
        return NextResponse.json(
          {
            error: "DUPLICATE_BARCODE",
            message: `الباركود (${barcode}) مستخدم مسبقاً في وحدة (${existingBarcode.unitName}) للمنتج (${existingBarcode.product.name}) وهي بحالة [${statusText}].`,
          },
          { status: 400 }
        );
      }
    }

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
        const createdUnit = await tx.productUnit.create({
          data: {
            tenantId,
            productId: product.id,
            unitName: u.unitName,
            // [FIX] These four fields are now validated decimal strings
            // (see unitSchema above) — Prisma parses each directly into an
            // exact Decimal(18,4). No `Number(...)` conversion happens
            // anywhere on this write path.
            conversionFactor: u.conversionFactor,
            pricingCurrency: u.pricingCurrency || "SYP",
            priceWholesale: u.priceWholesale,
            priceRetail: u.priceRetail !== undefined ? u.priceRetail : null,
            barcode: u.barcode || null,
            barcodeSource: u.barcodeSource || null,
            imageUrl: u.imageUrl || null,
            isActive: u.isActive ?? true,
          },
        });
        unitIds.push(createdUnit.id);
        createdUnits.push(createdUnit as unknown as ProductUnitRow);

        // [FIX — closes a real cross-tenant race condition] ProductCatalogEntry
        // is a platform-wide (not tenant-scoped) table, and two entirely
        // unrelated tenants creating a product under the same real GS1
        // barcode at close to the same moment is an explicitly legitimate
        // case per schema.prisma's own note on ProductUnit.barcode
        // ("two different tenants can legitimately sell the same imported
        // item under the same barcode"). The previous
        // findUnique-then-create pattern had a TOCTOU race: both
        // transactions could see `existingCatalog === null`, then both
        // attempt `create`, and the loser would hit the table's `@unique`
        // constraint on `barcode` with a raw Prisma P2002 — which the
        // outer catch block below was written to interpret as "this
        // TENANT tried to reuse a barcode," failing the entire product
        // creation for a tenant who did nothing wrong. A P2002 on THIS
        // specific insert means only "another tenant's request won the
        // race to create the shared catalog convenience entry a moment
        // earlier" — an entirely expected, harmless outcome per this
        // table's own "never read again after creation, one-time
        // convenience" design (see schema.prisma's ProductCatalogEntry
        // note) — never a real conflict for the current tenant's own
        // product. It is caught and swallowed right here, not allowed to
        // propagate to the transaction's outer catch.
        if (u.barcodeSource === "GS1" && u.barcode?.trim()) {
          const barcodeTrim = u.barcode.trim();
          try {
            await tx.productCatalogEntry.create({
              data: {
                barcode: barcodeTrim,
                name,
                category: category || null,
                imageUrl: u.imageUrl || null,
                addedByTenantId: tenantId,
              },
            });
          } catch (catalogError) {
            const isBenignRace =
              catalogError instanceof Prisma.PrismaClientKnownRequestError &&
              catalogError.code === "P2002";
            if (!isBenignRace) {
              // Anything other than the specific race above is a real,
              // unexpected failure — let it propagate and abort the
              // transaction normally.
              throw catalogError;
            }
            // Otherwise: another tenant's request already created this
            // exact catalog entry a moment earlier. Nothing to do — this
            // tenant's own Product/ProductUnit creation proceeds
            // completely unaffected.
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
            // [FIX] validated decimal string — see createProductSchema above.
            quantity: initialBatch.quantity,
            expiryDate: initialBatch.expiryDate ? new Date(initialBatch.expiryDate) : null,
          },
        });
      }

      return { ...product, units: createdUnits };
    });

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
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // With the ProductCatalogEntry race now caught and swallowed inside
      // the transaction above, a P2002 reaching this outer catch can only
      // come from this tenant's OWN unique constraints (e.g.
      // ProductUnit's (tenantId, barcode) unique) — the case this message
      // was originally written for.
      return NextResponse.json(
        { error: "BARCODE_EXISTS", message: "أحد الباركودات المدخلة مستخدم بالفعل لمنتج آخر." },
        { status: 400 }
      );
    }
    console.error("Error creating product:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إضافة المنتج." }, { status: 500 });
  }
}