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
import { validatePackagingUnits, type PackagingUnit } from "@/lib/inventory/units";
import {
  requireBaseUnit,
  MissingBaseUnitError,
  resetProductUnits,
  updateNonBaseUnitConversionFactor,
  PendingB2BReferenceError,
  // [FIX] Dedicated error class replacing brittle string-matching on
  // assertBaseUnitMutable()'s thrown message — see base-unit.ts's header.
  BaseUnitLockedError,
} from "@/lib/inventory/base-unit";
import {
  findProductWithUnits,
  findProductUnitByBarcodeExcludingProduct,
  updateProduct,
  updateProductUnit,
  createAdditionalUnit,
  countProductBatches,
  setProductActive,
} from "@/lib/data/products";
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
  // Required whenever this PATCH would actually change WHICH unit is the
  // base unit (only reachable when the product has zero batches AND zero
  // pending B2B references — both re-checked INSIDE the transaction).
  baseUnitChangeReason: z.string().optional(),
});

interface PublishabilityCandidateUnit {
  isActive: boolean;
  imageUrl: string | null | undefined;
  priceRetail: string | number | Prisma.Decimal | null | undefined;
}

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

    const product = await findProductWithUnits(db, tenantId, id);

    if (!product) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    // [v4.0] Surfaced for the UI so the edit screen can lock the base
    // unit's conversionFactor field — resolved via the sole sanctioned
    // gateway, never by reading product.baseUnitId directly.
    let baseUnitId: string;
    try {
      const baseUnit = await requireBaseUnit(db, tenantId, id);
      baseUnitId = baseUnit.id;
    } catch (e) {
      if (e instanceof MissingBaseUnitError) {
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

    return NextResponse.json({
      success: true,
      product: {
        ...product,
        baseUnitId,
        units: product.units.map((u) => ({ ...u, isBaseUnit: u.id === baseUnitId })),
      },
    });
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

    const existingProduct = await findProductWithUnits(db, tenantId, id);
    if (!existingProduct) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    let currentBaseUnit;
    try {
      currentBaseUnit = await requireBaseUnit(db, tenantId, id);
    } catch (e) {
      if (e instanceof MissingBaseUnitError) {
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

    // Build the EFFECTIVE resulting unit list — existing units not
    // mentioned in data.units stay as they are; units with a matching
    // `id` are replaced by their submitted values; units with no `id`
    // are additions. Every validation check below runs against this
    // merged list, not just the submitted subset.
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
            effectiveUnits.push(submitted);
          }
        } else {
          effectiveUnits.push(submitted);
        }
      }
    }

    let wantsBaseUnitChange = false;
    let newBaseUnitSubmission: z.infer<typeof unitSchema> | null = null;

    if (data.units) {
      const packagingCheck = validatePackagingUnits(effectiveUnits as PackagingUnit[]);
      if (!packagingCheck.valid) {
        return NextResponse.json(
          { error: "INVALID_PACKAGING_UNITS", message: packagingCheck.error },
          { status: 400 }
        );
      }

      const effectiveBaseUnit = effectiveUnits.find((u) =>
        new Decimal(u.conversionFactor).equals(1)
      )!;
      wantsBaseUnitChange = !effectiveBaseUnit.id || effectiveBaseUnit.id !== currentBaseUnit.id;

      if (wantsBaseUnitChange) {
        // Early, INFORMATIONAL check only — fast/friendly error for the
        // common case, NOT the security boundary. The authoritative
        // re-check happens INSIDE the transaction below via
        // resetProductUnits(), closing the window a concurrent write
        // could otherwise slip through.
        const earlyBatchCount = await countProductBatches(db, tenantId, id);
        if (earlyBatchCount > 0) {
          return NextResponse.json(
            {
              error: "BASE_UNIT_LOCKED",
              message: "لا يمكن تغيير الوحدة الأساسية أو معامل تحويلها لمنتج لديه دفعات مخزون مسجلة.",
            },
            { status: 400 }
          );
        }

        if (!data.baseUnitChangeReason?.trim()) {
          return NextResponse.json(
            {
              error: "BASE_UNIT_CHANGE_REASON_REQUIRED",
              message: "يجب إدخال سبب لتغيير الوحدة الأساسية.",
            },
            { status: 400 }
          );
        }

        // A base-unit change is a dedicated, standalone correction flow —
        // it does not attempt to also apply arbitrary sibling-unit edits
        // from the same payload. If other unit edits are genuinely
        // needed, submit them in a separate PATCH after the base-unit
        // correction.
        newBaseUnitSubmission = data.units.find(
          (u) => new Decimal(u.conversionFactor).equals(1)
        )!;
      } else {
        // Ordinary path (no base-unit change): validate name/barcode
        // uniqueness for the submitted units.
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

            const duplicate = await findProductUnitByBarcodeExcludingProduct(db, tenantId, barcodeTrim, id);
            if (duplicate) {
              return NextResponse.json(
                { error: "DUPLICATE_BARCODE", message: `الباركود ${barcodeTrim} مستخدم مسبقاً في منتج آخر لديك.` },
                { status: 400 }
              );
            }
          }
        }

        for (const u of data.units) {
          if (!u.id) continue; // new non-base unit — no prior factor to compare against
          const existing = effectiveUnits.find((e) => e.id === u.id);
          const priorFactorRow = existingProduct.units.find((eu) => eu.id === u.id);
          if (
            priorFactorRow &&
            !new Decimal(u.conversionFactor).equals(priorFactorRow.conversionFactor.toString())
          ) {
            const earlyBatchCount = await countProductBatches(db, tenantId, id);
            if (earlyBatchCount > 0) {
              return NextResponse.json(
                {
                  error: "CONVERSION_FACTOR_LOCKED",
                  message: `لا يمكن تعديل معامل تحويل الوحدة "${existing?.unitName}" لمنتج لديه دفعات مخزون مسجلة.`,
                },
                { status: 400 }
              );
            }
          }
        }
      }
    }

    const nextIsActive = data.isActive !== undefined ? data.isActive : existingProduct.isActive;
    let nextIsPublic = data.isPublic !== undefined ? data.isPublic : existingProduct.isPublic;

    // A base-unit reset always forces the product private — the freshly
    // created base unit has no priceRetail/imageUrl, so a product left
    // `isPublic: true` across a reset would silently keep failing (or
    // worse, keep passing on stale cached data) T3a's publishing gate.
    if (wantsBaseUnitChange) {
      nextIsPublic = false;
    }

    if (data.isPublic === true && !wantsBaseUnitChange) {
      if (!nextIsActive) {
        return NextResponse.json(
          { error: "PRODUCT_INACTIVE", message: "لا يمكن نشر منتج موقوف في المتجر." },
          { status: 400 }
        );
      }

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
      if (wantsBaseUnitChange && newBaseUnitSubmission) {
        // resetProductUnits() itself calls assertBaseUnitMutable() AND
        // assertNoPendingB2BReferences() as its first two actions, inside
        // THIS transaction — this is the actual, race-free gate.
        await resetProductUnits(tx, {
          tenantId,
          productId: id,
          newBaseUnit: {
            unitName: newBaseUnitSubmission.unitName,
            pricingCurrency: newBaseUnitSubmission.pricingCurrency,
            priceWholesale: newBaseUnitSubmission.priceWholesale,
            priceRetail: newBaseUnitSubmission.priceRetail ?? null,
            imageUrl: newBaseUnitSubmission.imageUrl ?? null,
          },
          changedByUserId: session.user.id,
          reason: data.baseUnitChangeReason!.trim(),
        });

        await updateProduct(tx, tenantId, id, {
          name: data.name,
          category: data.category !== undefined ? data.category : undefined,
          isActive: nextIsActive,
          isPublic: false, // forced — see the note above
        });
      } else {
        await updateProduct(tx, tenantId, id, {
          name: data.name,
          category: data.category !== undefined ? data.category : undefined,
          isActive: nextIsActive,
          isPublic: nextIsPublic,
        });

        if (data.units) {
          for (const u of data.units) {
            const isNonBaseFactorChange =
              !!u.id &&
              (() => {
                const priorRow = existingProduct.units.find((eu) => eu.id === u.id);
                return !!priorRow && !new Decimal(u.conversionFactor).equals(priorRow.conversionFactor.toString());
              })();

            if (u.id) {
              if (isNonBaseFactorChange) {
                // conversionFactor changes on an existing unit go through
                // the one explicitly-guarded path — it re-checks
                // zero-batch INSIDE this same transaction, and refuses to
                // touch the current base unit.
                await updateNonBaseUnitConversionFactor(tx, {
                  tenantId,
                  productId: id,
                  unitId: u.id,
                  newConversionFactor: u.conversionFactor,
                });
              }
              await updateProductUnit(tx, tenantId, u.id, {
                unitName: u.unitName,
                pricingCurrency: u.pricingCurrency,
                priceWholesale: u.priceWholesale,
                priceRetail: u.priceRetail !== undefined ? u.priceRetail : null,
                barcode: u.barcode ? u.barcode.trim() : null,
                barcodeSource: u.barcode ? u.barcodeSource : null,
                imageUrl: u.imageUrl || null,
                isActive: u.isActive !== undefined ? u.isActive : true,
              });
            } else {
              await createAdditionalUnit(tx, tenantId, id, u.conversionFactor, {
                unitName: u.unitName,
                pricingCurrency: u.pricingCurrency,
                priceWholesale: u.priceWholesale,
                priceRetail: u.priceRetail !== undefined ? u.priceRetail : null,
                barcode: u.barcode ? u.barcode.trim() : null,
                barcodeSource: u.barcode ? u.barcodeSource : null,
                imageUrl: u.imageUrl || null,
                isActive: u.isActive !== undefined ? u.isActive : true,
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
                      name: data.name || existingProduct.name,
                      category: data.category !== undefined ? data.category : existingProduct.category,
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
      }

      return findProductWithUnits(tx, tenantId, id);
    });

    return NextResponse.json({
      success: true,
      product: updatedProduct,
      message: wantsBaseUnitChange
        ? "تم تصحيح الوحدة الأساسية للمنتج بنجاح. تم إلغاء نشر المنتج تلقائياً — يرجى مراجعة بيانات النشر (السعر والصورة) قبل إعادة نشره."
        : "تم تحديث بيانات المنتج والوحدات بنجاح.",
    });
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse();
    }
    if (error instanceof PendingB2BReferenceError) {
      return NextResponse.json(
        {
          error: "PENDING_B2B_ORDERS_EXIST",
          message: "لا يمكن تصحيح الوحدة الأساسية حالياً — يوجد طلب/طلبات بيع بالجملة (B2B) قيد المراجعة على وحدات هذا المنتج. يرجى الموافقة على الطلبات أو رفضها أولاً.",
        },
        { status: 409 }
      );
    }
    // [FIX] Was brittle string-matching on error.message.includes(...) —
    // replaced with instanceof against the dedicated BaseUnitLockedError
    // class (see base-unit.ts's header FIX note). Catches the race where
    // assertBaseUnitMutable()'s re-check inside the transaction finds a
    // batch that was created concurrently, after the early informational
    // check above already passed — for BOTH the base-unit-reset path
    // (resetProductUnits) and the non-base conversionFactor-edit path
    // (updateNonBaseUnitConversionFactor), since both throw this same
    // error class.
    if (error instanceof BaseUnitLockedError) {
      return NextResponse.json(
        {
          error: "BASE_UNIT_LOCKED",
          message: "تعذر إتمام التصحيح: تم تسجيل دفعة مخزون على هذا المنتج للتو من عملية أخرى. لا يمكن تغيير الوحدة الأساسية أو معامل تحويلها بعد الآن.",
        },
        { status: 409 }
      );
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

    const existingProduct = await findProductWithUnits(db, tenantId, id);
    if (!existingProduct) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    // Pure visibility toggle — the ONLY field this touches, never bundled
    // with an isPublic change.
    await setProductActive(db, tenantId, id, false);

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