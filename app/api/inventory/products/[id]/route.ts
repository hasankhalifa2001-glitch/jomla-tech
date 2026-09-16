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
import { validatePackagingUnits, type PackagingUnit } from "@/lib/inventory/packaging-unit-validation";
// [v4.0] Sole gateway for reading Product.baseUnitId.
import { requireBaseUnit, MissingBaseUnitError } from "@/lib/inventory/base-unit";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";

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
    conversionFactor: positiveDecimalString("معامل التحويل يجب أن يكون رقماً موجباً"),
    pricingCurrency: z.enum(["SYP", "USD"]).default("SYP"),
    priceWholesale: nonNegativeDecimalString("سعر الجملة لا يمكن أن يكون سالباً"),
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
  // [v4.0] Required whenever this PATCH would actually change WHICH unit
  // is the base unit (only possible when the product has zero batches —
  // see the immutability check below). Backs the BaseUnitChangeLog audit
  // row — a base-unit correction is never a silent field edit.
  baseUnitChangeReason: z.string().optional(),
});

interface PublishabilityCandidateUnit {
  isActive: boolean;
  imageUrl: string | null | undefined;
  priceRetail: string | number | Prisma.Decimal | null | undefined;
}

// [v4.0] The full merged shape used both for the effective-units
// validation below and for the publishing-gate candidate check, so both
// checks see the SAME resulting state — not just whatever subset of units
// happened to be included in this particular PATCH payload.
interface EffectiveUnit {
  id?: string;
  unitName: string;
  conversionFactor: string;
  priceWholesale?: string | number | Prisma.Decimal;
  priceRetail?: string | number | Prisma.Decimal | null;
  imageUrl?: string | null;
  isActive?: boolean;
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

    // [v4.0] Resolve the CURRENT base unit through the sole sanctioned
    // gateway — never by reading existingProduct.baseUnitId directly
    // (blocked by this project's ESLint rule) and never by re-deriving it
    // via conversionFactor === 1.
    let currentBaseUnit;
    try {
      currentBaseUnit = await requireBaseUnit(db, tenantId, id);
    } catch (e) {
      if (e instanceof MissingBaseUnitError) {
        // Pre-v4.0 legacy row that still needs a one-time baseUnitId
        // backfill migration — fail loud rather than guess.
        return NextResponse.json(
          {
            error: "MISSING_BASE_UNIT",
            message: "هذا المنتج بدون وحدة أساسية محددة (بيانات قديمة تحتاج تصحيح) — الرجاء التواصل مع الدعم الفني.",
          },
          { status: 409 }
        );
      }
      throw e;
    }

    const batchCount = await db.productBatch.count({ where: { productId: id, tenantId } });

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

    // [v4.0] Build the EFFECTIVE resulting unit list — existing units not
    // mentioned in data.units stay as they are; units with a matching
    // `id` are replaced by their submitted values; units with no `id` are
    // additions. Every check below runs against this merged list, not
    // just the submitted subset — otherwise a partial update that simply
    // omits the current base unit from data.units could silently evade
    // the "exactly one conversionFactor === 1" / base-unit-immutability
    // rules.
    const effectiveUnits: EffectiveUnit[] = existingProduct.units.map((u) => ({
      id: u.id,
      unitName: u.unitName,
      conversionFactor: u.conversionFactor.toString(),
      priceWholesale: u.priceWholesale,
      priceRetail: u.priceRetail,
      imageUrl: u.imageUrl,
      isActive: u.isActive,
    }));

    if (data.units) {
      for (const submitted of data.units) {
        if (submitted.id) {
          const idx = effectiveUnits.findIndex((u) => u.id === submitted.id);
          if (idx >= 0) {
            effectiveUnits[idx] = { ...effectiveUnits[idx], ...submitted };
          } else {
            // A submitted id that doesn't belong to this product — let
            // the per-unit write loop below surface that naturally
            // (Prisma's update on a non-existent id fails).
            effectiveUnits.push(submitted);
          }
        } else {
          effectiveUnits.push(submitted);
        }
      }
    }

    let baseUnitWouldChange = false;
    let effectiveBaseUnitId = currentBaseUnit.id;

    if (data.units) {
      const packagingCheck = validatePackagingUnits(effectiveUnits as PackagingUnit[]);
      if (!packagingCheck.valid) {
        return NextResponse.json(
          { error: "INVALID_PACKAGING_UNITS", message: packagingCheck.error },
          { status: 400 }
        );
      }

      // [v4.0] Base-unit immutability (T1's Unit Conversion Architecture).
      // validatePackagingUnits above already guarantees exactly one unit
      // in effectiveUnits has conversionFactor === 1.
      const effectiveBaseUnit = effectiveUnits.find((u) =>
        new Decimal(u.conversionFactor).equals(1)
      )!;
      effectiveBaseUnitId = effectiveBaseUnit.id ?? "__NEW_UNIT__"; // real id resolved after creation inside the transaction
      baseUnitWouldChange =
        !effectiveBaseUnit.id || effectiveBaseUnit.id !== currentBaseUnit.id;

      if (baseUnitWouldChange && batchCount > 0) {
        return NextResponse.json(
          {
            error: "BASE_UNIT_LOCKED",
            message: "لا يمكن تغيير الوحدة الأساسية أو معامل تحويلها لمنتج لديه دفعات مخزون مسجلة.",
          },
          { status: 400 }
        );
      }

      if (baseUnitWouldChange && batchCount === 0 && !data.baseUnitChangeReason?.trim()) {
        return NextResponse.json(
          {
            error: "BASE_UNIT_CHANGE_REASON_REQUIRED",
            message: "يجب إدخال سبب لتغيير الوحدة الأساسية.",
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
            { error: "DUPLICATE_UNIT_NAME", message: `اسم الوحدة "${u.unitName}" مكرر لهذا المنتج` },
            { status: 400 }
          );
        }
        names.add(lowerName);

        if (u.barcode && u.barcode.trim()) {
          const barcodeTrim = u.barcode.trim();

          if (barcodesInRequest.has(barcodeTrim)) {
            return NextResponse.json(
              { error: "DUPLICATE_BARCODE", message: `الباركود ${barcodeTrim} مكرر لأكثر من وحدة ضمن نفس الطلب.` },
              { status: 400 }
            );
          }
          barcodesInRequest.add(barcodeTrim);

          const duplicate = await db.productUnit.findFirst({
            where: { barcode: barcodeTrim, product: { tenantId }, NOT: { productId: id } },
          });
          if (duplicate) {
            return NextResponse.json(
              { error: "DUPLICATE_BARCODE", message: `الباركود ${barcodeTrim} مستخدم مسبقاً في منتج آخر لديك.` },
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
          { error: "PRODUCT_INACTIVE", message: "لا يمكن نشر منتج موقوف في المتجر." },
          { status: 400 }
        );
      }

      // [v4.0] Now built from effectiveUnits (the full merged state), not
      // just data.units OR existingProduct.units — a partial update that
      // e.g. only edits one unit's price no longer loses visibility into
      // every OTHER unit's isActive/imageUrl/priceRetail for this gate
      // check.
      const candidateUnits: PublishabilityCandidateUnit[] = effectiveUnits.map((u) => ({
        isActive: u.isActive !== false,
        imageUrl: u.imageUrl,
        priceRetail: u.priceRetail,
      }));

      const gateCheck = checkProductPublishable({ isActive: nextIsActive, units: candidateUnits });
      if (!gateCheck.publishable) {
        return NextResponse.json(
          { error: "PUBLISH_GATE_BLOCKED", message: gateCheck.reason },
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

      // [v4.0] Tracks which unit ends up with conversionFactor === 1 as
      // we actually write each row — starts at the current base unit (no
      // change) and is overwritten only if a unit written below turns out
      // to carry factor 1.
      let resolvedBaseUnitId = currentBaseUnit.id;

      if (data.units) {
        for (const u of data.units) {
          let writtenUnitId: string;

          if (u.id) {
            const updated = await tx.productUnit.update({
              where: { id: u.id },
              data: {
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
            writtenUnitId = updated.id;
          } else {
            const created = await tx.productUnit.create({
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
            writtenUnitId = created.id;
          }

          if (new Decimal(u.conversionFactor).equals(1)) {
            resolvedBaseUnitId = writtenUnitId;
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

      // [v4.0] If the base unit actually changed (only reachable when
      // batchCount === 0 — already blocked above otherwise), log it via
      // BaseUnitChangeLog and update Product.baseUnitId — both as their
      // own top-level calls in this same transaction (T1's nested-write
      // rule). A base-unit correction is never a silent field edit.
      if (resolvedBaseUnitId !== currentBaseUnit.id) {
        await tx.baseUnitChangeLog.create({
          data: {
            tenantId,
            productId: id,
            oldBaseUnitId: currentBaseUnit.id,
            newBaseUnitId: resolvedBaseUnitId,
            // NOTE: assumes `session.user.id` is populated on the JWT
            // session per T2a — please confirm this field name matches
            // your actual auth callback (role/tenantId/isPlatformAdmin
            // were the three explicitly documented; user id wasn't
            // called out by name).
            changedByUserId: session.user.id,
            reason: data.baseUnitChangeReason!.trim(),
          },
        });
        await tx.product.update({
          where: { id },
          data: { baseUnitId: resolvedBaseUnitId },
        });
      }

      return tx.product.findFirst({
        where: { id },
        include: { units: { orderBy: { conversionFactor: "asc" } } },
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

    const existingProduct = await db.product.findFirst({ where: { id } });

    if (!existingProduct) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    await db.product.update({
      where: { id },
      data: { isActive: false },
    });

    return NextResponse.json({ success: true, message: "تم تعطيل المنتج بنجاح." });
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