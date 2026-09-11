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

// [FIX] Matches products/route.ts POST's own DECIMAL_STRING_REGEX exactly
// (18,4) — kept as a separate literal here rather than importing it from
// that file, per the decision not to introduce a shared decimal-format
// module for this pass. conversionFactor/priceWholesale/priceRetail are
// all backed by Decimal(18,4) columns; accepting them as native JS
// numbers (the previous schema) risks the exact same float-precision loss
// this project's decimal.js-everywhere rule (T1) exists to prevent — this
// PATCH route was the one remaining write path still doing that after
// POST was already fixed.
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
    id: z.string().optional(),
    unitName: z.string().min(1, "اسم الوحدة مطلوب"),
    // [FIX] Was `z.number().positive(...)` — switched to a validated
    // decimal string, matching POST's unitSchema. Fractional factors
    // remain fully supported (a quarter/half carton) — this only changes
    // HOW the exact value is transmitted, not what values are allowed.
    conversionFactor: positiveDecimalString("معامل التحويل يجب أن يكون رقماً موجباً"),
    pricingCurrency: z.enum(["SYP", "USD"]).default("SYP"),
    // [FIX] Was `z.number().min(0, ...)`.
    priceWholesale: nonNegativeDecimalString("سعر الجملة لا يمكن أن يكون سالباً"),
    // [FIX] Was `z.number().min(0, ...).optional().nullable()`.
    priceRetail: nonNegativeDecimalString("سعر التجزئة لا يمكن أن يكون سالباً")
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

const updateProductSchema = z.object({
  name: z.string().min(1, "اسم المنتج مطلوب").optional(),
  category: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  units: z.array(unitSchema).min(1, "يجب أن يحتوي المنتج على وحدة قياس واحدة على الأقل").optional(),
});

// [FIX — TYPE ERROR] checkProductPublishable<T>() infers T from the shape
// of the `units` array it's given. The PATCH handler below builds that
// array via a ternary — `data.units ? data.units.map(...) : existingProduct
// .units.map(...)` — and the two branches previously produced two
// STRUCTURALLY DIFFERENT element shapes: the `data.units` branch has
// `priceRetail: string | null | undefined` (Zod's validated decimal
// string), while the `existingProduct.units` branch used to convert its
// Prisma.Decimal via `Number(...)` into `priceRetail: number | null`.
// A ternary whose two branches produce different array element types
// gives the variable a UNION of two array types (`A[] | B[]`), not a
// single array of a union element type (`(A|B)[]`) — and TypeScript's
// generic inference does not reliably unify that into one T when the
// argument itself is such a union, which is exactly the compile error
// this produced ("Type ... priceRetail: number | null ... is not
// assignable to ... priceRetail: string | null | undefined").
//
// Fixed two ways together:
//   1. `candidateUnits` below is given ONE explicit, concrete type
//      annotation, so both ternary branches are contextually checked
//      against that same declared type instead of each inferring its own
//      shape independently.
//   2. The `existingProduct.units` branch no longer converts via
//      `Number(...)` at all — it passes the live `Prisma.Decimal | null`
//      straight through. This is not just a type-checking convenience:
//      `checkProductPublishable`'s own `PriceRetailValue` type already
//      accepts anything with a `.toNumber()` method (a `Prisma.Decimal`
//      qualifies structurally), and `isUnitPublishable` already branches
//      on exactly that case internally. Passing the Decimal through
//      avoids an unnecessary premature float coercion here, consistent
//      with T1's decimal.js-everywhere rule — even though this is only a
//      read-time gate check (not a value that gets persisted), there is
//      no reason to convert earlier than the one place that actually
//      needs a plain number for its `> 0` comparison.
interface PublishabilityCandidateUnit {
  isActive: boolean;
  imageUrl: string | null | undefined;
  priceRetail: string | number | Prisma.Decimal | null | undefined;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const { id } = await params;
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    const product = await db.product.findFirst({
      where: { id },
      include: {
        units: { orderBy: { conversionFactor: "asc" } },
        batches: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!product) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    return NextResponse.json({ success: true, product });
  } catch (error) {
    console.error("GET product error:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب المنتج." }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    assertRolePermission(session.user.role, "inventory:mutate");

    await assertTenantWritable(session.user.tenantId);

    const { id } = await params;
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    const existingProduct = await db.product.findFirst({
      where: { id },
      include: { units: true },
    });

    if (!existingProduct) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    const body = await req.json();
    const parsed = updateProductSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message || "بيانات التعديل غير صحيحة",
          issues: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    const data = parsed.data;

    if (data.units) {
      const packagingCheck = validatePackagingUnits(data.units);
      if (!packagingCheck.valid) {
        return NextResponse.json(
          {
            error: "INVALID_PACKAGING_UNITS",
            message: packagingCheck.error,
          },
          { status: 400 }
        );
      }

      const names = new Set<string>();
      const barcodesInRequest = new Set<string>();
      for (const u of data.units) {
        const lowerName = u.unitName.trim().toLowerCase();
        if (names.has(lowerName)) {
          return NextResponse.json(
            {
              error: "DUPLICATE_UNIT_NAME",
              message: `اسم الوحدة "${u.unitName}" مكرر لهذا المنتج`,
            },
            { status: 400 }
          );
        }
        names.add(lowerName);

        if (u.barcode && u.barcode.trim()) {
          const barcodeTrim = u.barcode.trim();

          if (barcodesInRequest.has(barcodeTrim)) {
            return NextResponse.json(
              {
                error: "DUPLICATE_BARCODE",
                message: `الباركود ${barcodeTrim} مكرر لأكثر من وحدة ضمن نفس الطلب.`,
              },
              { status: 400 }
            );
          }
          barcodesInRequest.add(barcodeTrim);

          const duplicate = await db.productUnit.findFirst({
            where: {
              barcode: barcodeTrim,
              product: { tenantId },
              NOT: { productId: id },
            },
          });
          if (duplicate) {
            return NextResponse.json(
              {
                error: "DUPLICATE_BARCODE",
                message: `الباركود ${barcodeTrim} مستخدم مسبقاً في منتج آخر لديك.`,
              },
              { status: 400 }
            );
          }
        }
      }
    }

    const nextIsActive = data.isActive !== undefined ? data.isActive : existingProduct.isActive;
    const nextIsPublic = data.isPublic !== undefined ? data.isPublic : existingProduct.isPublic;

    if (data.isPublic === true) {
      if (!nextIsActive) {
        return NextResponse.json(
          {
            error: "PRODUCT_INACTIVE",
            message: "لا يمكن نشر منتج موقوف في المتجر.",
          },
          { status: 400 }
        );
      }

      // [FIX — TYPE ERROR, see the PublishabilityCandidateUnit comment
      // above for the full explanation] Both ternary branches are now
      // contextually typed against the SAME explicit annotation, and the
      // `existingProduct.units` branch passes its Prisma.Decimal straight
      // through instead of pre-converting via Number(...).
      const candidateUnits: PublishabilityCandidateUnit[] = data.units
        ? data.units.map((u) => ({
          isActive: u.isActive !== false,
          imageUrl: u.imageUrl,
          priceRetail: u.priceRetail,
        }))
        : existingProduct.units.map((u) => ({
          isActive: u.isActive !== false,
          imageUrl: u.imageUrl,
          priceRetail: u.priceRetail,
        }));

      const gateCheck = checkProductPublishable({
        isActive: nextIsActive,
        units: candidateUnits,
      });
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

    const updatedProduct = await db.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id },
        data: {
          name: data.name,
          category: data.category !== undefined ? data.category : undefined,
          isActive: nextIsActive,
          isPublic: nextIsPublic,
        },
      });

      if (data.units) {
        for (const u of data.units) {
          if (u.id) {
            await tx.productUnit.update({
              where: { id: u.id },
              data: {
                unitName: u.unitName,
                // [FIX] These three are now validated decimal strings —
                // Prisma parses each directly into an exact Decimal(18,4),
                // matching POST's write path. No Number(...) conversion.
                conversionFactor: u.conversionFactor,
                pricingCurrency: u.pricingCurrency,
                priceWholesale: u.priceWholesale,
                priceRetail: u.priceRetail !== undefined ? u.priceRetail : null,
                barcode: u.barcode ? u.barcode.trim() : null,
                barcodeSource: u.barcode ? u.barcodeSource : null,
                imageUrl: u.imageUrl || null,
                isActive: u.isActive !== undefined ? u.isActive : true,
              },
            });
          } else {
            await tx.productUnit.create({
              data: {
                tenantId,
                productId: id,
                unitName: u.unitName,
                conversionFactor: u.conversionFactor,
                pricingCurrency: u.pricingCurrency,
                priceWholesale: u.priceWholesale,
                priceRetail: u.priceRetail !== undefined ? u.priceRetail : null,
                barcode: u.barcode ? u.barcode.trim() : null,
                barcodeSource: u.barcode ? u.barcodeSource : null,
                imageUrl: u.imageUrl || null,
                isActive: u.isActive !== undefined ? u.isActive : true,
              },
            });
          }

          if (u.barcodeSource === "GS1" && u.barcode?.trim()) {
            const barcodeTrim = u.barcode.trim();
            const existingCatalog = await tx.productCatalogEntry.findUnique({
              where: { barcode: barcodeTrim },
            });
            if (!existingCatalog) {
              try {
                await tx.productCatalogEntry.create({
                  data: {
                    barcode: barcodeTrim,
                    name: data.name || product.name,
                    category: data.category !== undefined ? data.category : product.category,
                    imageUrl: u.imageUrl || null,
                    addedByTenantId: tenantId,
                  },
                });
              } catch (catalogError) {
                // [FIX] Same benign cross-tenant race guard as
                // products/route.ts's POST — a P2002 here means another
                // tenant's request won the race to create this exact
                // shared catalog entry a moment earlier, which is a
                // harmless, expected outcome for a platform-wide,
                // write-once-per-barcode table, never a real conflict for
                // THIS tenant's own product/unit write.
                const isBenignRace =
                  catalogError instanceof Prisma.PrismaClientKnownRequestError &&
                  catalogError.code === "P2002";
                if (!isBenignRace) {
                  throw catalogError;
                }
              }
            }
          }
        }
      }

      return tx.product.findFirst({
        where: { id },
        include: {
          units: { orderBy: { conversionFactor: "asc" } },
        },
      });
    });

    return NextResponse.json({
      success: true,
      product: updatedProduct,
      message: "تم تحديث بيانات المنتج والوحدات بنجاح.",
    });
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse();
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "BARCODE_EXISTS", message: "أحد الباركودات المدخلة مستخدم بالفعل لوحدة أخرى." },
        { status: 400 }
      );
    }
    console.error("PATCH product error:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تعديل المنتج." }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    assertRolePermission(session.user.role, "inventory:mutate");

    await assertTenantWritable(session.user.tenantId);

    const { id } = await params;
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    const existingProduct = await db.product.findFirst({
      where: { id },
    });

    if (!existingProduct) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    await db.product.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    return NextResponse.json({
      success: true,
      message: "تم تعطيل المنتج بنجاح.",
    });
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse();
    }
    console.error("DELETE product error:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تعطيل المنتج." }, { status: 500 });
  }
}