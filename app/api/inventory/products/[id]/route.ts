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
  UnitNotBelongingToProductError,
} from "@/lib/inventory/base-unit";
import {
  findProductWithUnits,
  findProductUnitByBarcodeExcludingProduct,
  updateProduct,
  // [FIX] existing-unit edits (name/prices/image/isActive) were never
  // persisted by this route — see the `if (u.id)` branch in the transaction.
  updateProductUnit,
  createAdditionalUnit,
  countProductBatches,
  setProductActive,
  // [v4.5] Barcode writes + the shared-catalog decision both live behind
  // lib/data/products.ts — this route never names productUnitBarcode or
  // productCatalogEntryBarcode (see eslint.config.mjs's barcode rule arrays).
  createUnitBarcode,
  resolveSharedCatalogForBarcode,
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

// [v4.5] One barcode row's worth of validated input — mirrors
// products/route.ts's unitBarcodeSchema. Both fields are REQUIRED per
// element: a barcode value and its human-confirmed source always travel
// together. `barcodeSource` is never inferred from the barcode's digit
// pattern (T3a §5).
const unitBarcodeSchema = z.object({
  barcode: z.string().trim().min(1, "قيمة الباركود مطلوبة"),
  barcodeSource: z.enum(["GS1", "INTERNAL"]),
});

const unitSchema = z
  .object({
    id: z.string().optional(),
    unitName: z.string().min(1, "اسم الوحدة مطلوب"),
    conversionFactor: positiveDecimalString("معامل التحويل يجب أن يكون رقماً موجباً"),
    // [FIX] No `.default(...)` on pricingCurrency / isActive. A Zod default
    // silently injected "SYP" / true into every submitted unit that omitted
    // them — harmless while existing-unit edits weren't persisted, but once
    // they are, it would re-activate a deactivated unit and flip a USD unit
    // to SYP on an unrelated edit. `undefined` now means "leave unchanged"
    // for an existing unit; the create paths below apply the real defaults
    // ("SYP" / true) explicitly.
    pricingCurrency: z.enum(["SYP", "USD"]).optional(),
    priceWholesale: nonNegativeDecimalString("سعر الجملة لا يمكن أن يكون سالباً"),
    // [v4.5] REPLACED the old single `barcode`/`barcodeSource` scalar pair.
    // On an EXISTING unit this list is the unit's full desired set as the edit
    // screen sees it; the PATCH is ADDITIVE-ONLY (see the transaction below:
    // barcodes already stored on the unit are skipped, and REMOVAL happens
    // exclusively through the dedicated DELETE barcode route, ADMIN-only).
    barcodes: z.array(unitBarcodeSchema).optional().default([]),
    // [DEPRECATED — INPUT SHIM, remove together with the deprecated `barcode`
    // field on products/route.ts's GET response] A client build cached by
    // T4a2's service worker before this change still sends the two scalars.
    // Folded into `barcodes` by the transform below; the original
    // "source required whenever a barcode is present" refine is kept verbatim.
    barcode: z.string().optional().nullable(),
    barcodeSource: z.enum(["GS1", "INTERNAL"]).optional().nullable(),
    isActive: z.boolean().optional(),
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
  )
  .transform((u) => {
    const legacyBarcode = u.barcode?.trim();
    if (u.barcodes.length === 0 && legacyBarcode) {
      return u.barcodeSource
        ? { ...u, barcodes: [{ barcode: legacyBarcode, barcodeSource: u.barcodeSource }] }
        : u;
    }
    return u;
  });

type SubmittedUnit = z.infer<typeof unitSchema>;

const updateProductSchema = z.object({
  name: z.string().min(1, "اسم المنتج مطلوب").optional(),
  category: z.string().optional().nullable(),
  // [v4.6] The ONE image for this product (moved here from ProductUnit).
  // undefined = untouched; null or an empty/blank string = cleared.
  imageUrl: z.string().optional().nullable(),
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
}

interface EffectiveUnit {
  id?: string;
  unitName: string;
  conversionFactor: string;
  priceWholesale?: string | number | Prisma.Decimal;
  isActive?: boolean;
}

/**
 * Overlays a submitted unit onto an effective unit, copying ONLY the fields
 * the client actually sent (undefined = leave as-is). Never spreads the raw
 * submitted object, so barcode/legacy fields can't leak into the effective
 * list and an omitted isActive can't overwrite a stored value.
 */
function overlaySubmittedUnit(base: EffectiveUnit, s: SubmittedUnit): EffectiveUnit {
  return {
    ...base,
    unitName: s.unitName,
    conversionFactor: s.conversionFactor,
    priceWholesale: s.priceWholesale,
    ...(s.isActive !== undefined ? { isActive: s.isActive } : {}),
  };
}

// [DEPRECATED — compatibility shim, removal target: same release as the GET
// shim below] mirrors the FIRST barcode onto the old scalar fields, so a
// cached client that reads the PATCH response sees the same unit shape as GET.
function withLegacyBarcodeFields<
  U extends { barcodes: { barcode: string; barcodeSource: string | null }[] }
>(units: U[]) {
  return units.map((u) => ({
    ...u,
    barcode: u.barcodes[0]?.barcode ?? null,
    barcodeSource: u.barcodes[0]?.barcodeSource ?? null,
  }));
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

    // [v4.0] `isBaseUnit` is already precomputed per-unit by
    // findProductWithUnits() (via base-unit.ts's toSafeProductWithUnits()),
    // which is itself the sanctioned gateway for resolving
    // Product.baseUnitId — this file never reads that field directly.
    const baseUnit = product.units.find((u) => u.isBaseUnit);

    if (!baseUnit) {
      // Structurally the same situation MissingBaseUnitError signals —
      // a data-integrity bug, never expected in normal operation.
      return NextResponse.json(
        {
          error: "MISSING_BASE_UNIT",
          message: "هذا المنتج بدون وحدة أساسية محددة (بيانات قديمة تحتاج تصحيح) — الرجاء التواصل مع الدعم الفني.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      product: {
        ...product,
        baseUnitId: baseUnit.id,
        // [v4.5] Deprecated per-unit `barcode`/`barcodeSource` siblings, for a
        // client build an old T4a2 service-worker cache may still be serving.
        // [DEPRECATED — REMOVAL TARGET: the release after T4a2's service worker
        // has rolled the new client build to all cached devices]
        units: withLegacyBarcodeFields(product.units),
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
    // `id` are overlaid by their submitted values; units with no `id`
    // are additions. Every validation check below runs against this
    // merged list, not just the submitted subset.
    const effectiveUnits: EffectiveUnit[] = existingProduct.units.map((u) => ({
      id: u.id,
      unitName: u.unitName,
      conversionFactor: u.conversionFactor.toString(),
      priceWholesale: u.priceWholesale,
      isActive: u.isActive,
    }));

    if (data.units) {
      for (const submitted of data.units) {
        const idx = submitted.id
          ? effectiveUnits.findIndex((u) => u.id === submitted.id)
          : -1;
        if (idx >= 0) {
          effectiveUnits[idx] = overlaySubmittedUnit(effectiveUnits[idx], submitted);
        } else {
          effectiveUnits.push(
            overlaySubmittedUnit(
              { unitName: submitted.unitName, conversionFactor: submitted.conversionFactor },
              submitted
            )
          );
        }
      }
    }

    let wantsBaseUnitChange = false;
    let newBaseUnitSubmission: SubmittedUnit | null = null;

    if (data.units) {
      // [FIX] Packaging rules (exactly one factor-1 unit, no duplicate
      // factors) apply to the units that are LIVE after this request —
      // active ones, plus the product's current base unit even if a request
      // deactivates it. resetProductUnits() soft-deletes the old units
      // (isActive: false) and never removes them, so validating over ALL
      // rows made every PATCH after a base-unit reset fail with "more than
      // one base unit" (a leftover deactivated factor-1 row), and could make
      // the base-unit lookup below pick that dead row.
      const liveEffectiveUnits = effectiveUnits.filter(
        (u) => u.isActive !== false || u.id === currentBaseUnit.id
      );

      const packagingCheck = validatePackagingUnits(liveEffectiveUnits as PackagingUnit[]);
      if (!packagingCheck.valid) {
        return NextResponse.json(
          { error: "INVALID_PACKAGING_UNITS", message: packagingCheck.error },
          { status: 400 }
        );
      }

      // Safe: validatePackagingUnits() just confirmed exactly one factor-1 unit.
      const effectiveBaseUnit = liveEffectiveUnits.find((u) =>
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
        // from the same payload (the response message says so when the
        // payload carried more than the new base unit).
        const submittedBase = data.units.find((u) =>
          new Decimal(u.conversionFactor).equals(1)
        );
        if (!submittedBase) {
          // The new base unit came from an existing stored row that wasn't
          // (re)submitted with factor 1 — there is nothing to build it from.
          return NextResponse.json(
            {
              error: "INVALID_PACKAGING_UNITS",
              message: "يجب إرسال بيانات الوحدة الأساسية الجديدة (معامل تحويل 1) ضمن الطلب.",
            },
            { status: 400 }
          );
        }
        newBaseUnitSubmission = submittedBase;
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

          // [v4.5] EVERY barcode of THIS unit — the request-wide Set and the
          // live-DB check both span all units of the request.
          for (const barcodeRow of u.barcodes) {
            const barcodeTrim = barcodeRow.barcode;

            if (barcodesInRequest.has(barcodeTrim)) {
              return NextResponse.json(
                { error: "DUPLICATE_BARCODE", message: `الباركود ${barcodeTrim} مكرر ضمن نفس الطلب.` },
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

    // Only used for the publishing gate below. It is NOT forwarded to
    // updateProduct(): fields the client didn't send stay `undefined` there
    // (= "don't touch"), so a concurrent toggle-public/toggle-active can't
    // be overwritten with a stale value read at the top of this handler.
    const nextIsActive = data.isActive !== undefined ? data.isActive : existingProduct.isActive;

    // [v4.6] The image lives on Product, not on a unit. productImageWrite is
    // the value this request would SAVE: undefined = the client sent nothing
    // (leave as-is), otherwise the trimmed value or null (cleared).
    // effectiveImageUrl is the value the gate must validate -- the one the
    // product would actually carry afterwards -- so the gate can never
    // approve an image this request is not going to persist.
    const productImageWrite =
      data.imageUrl === undefined ? undefined : data.imageUrl?.trim() || null;
    const effectiveImageUrl =
      data.imageUrl === undefined ? existingProduct.imageUrl : productImageWrite;

    // The gate is evaluated against the publishing state the product WOULD
    // end up in, not only against an explicit isPublic: true. That is what
    // makes "clear the image while the product is public" a 400 instead of a
    // silent violation of the T3a publishing rule.
    const nextIsPublic =
      data.isPublic !== undefined ? data.isPublic : existingProduct.isPublic;

    if (nextIsPublic && !wantsBaseUnitChange) {
      if (!nextIsActive) {
        return NextResponse.json(
          { error: "PRODUCT_INACTIVE", message: "لا يمكن نشر منتج موقوف في المتجر." },
          { status: 400 }
        );
      }

      const candidateUnits: PublishabilityCandidateUnit[] = effectiveUnits.map((u) => ({
        isActive: u.isActive !== false,
      }));

      const gateCheck = checkProductPublishable({
        isActive: nextIsActive,
        imageUrl: effectiveImageUrl,
        units: candidateUnits,
      });
      if (!gateCheck.publishable) {
        return NextResponse.json(
          { error: "PUBLISH_GATE_BLOCKED", message: gateCheck.reason },
          { status: 400 }
        );
      }
    }

    // [v4.6] A base-unit reset no longer forces the product private. The
    // image belongs to the product, so swapping the unit rows cannot strip
    // the photo and cannot invalidate publishing on its own. Publishing
    // state is left untouched below; instead the gate is re-run here against
    // the POST-reset unit state -- resetProductUnits() always creates the
    // new base unit with isActive: true -- and this request is rejected
    // only if the product would genuinely no longer qualify.
    if (nextIsPublic && wantsBaseUnitChange) {
      const resetGateCheck = checkProductPublishable({
        isActive: nextIsActive,
        imageUrl: effectiveImageUrl,
        units: [{ isActive: true }],
      });
      if (!resetGateCheck.publishable) {
        return NextResponse.json(
          { error: "PUBLISH_GATE_BLOCKED", message: resetGateCheck.reason },
          { status: 400 }
        );
      }
    }

    const updatedProduct = await db.$transaction(async (tx) => {
      if (wantsBaseUnitChange && newBaseUnitSubmission) {
        // resetProductUnits() itself calls assertBaseUnitMutable() AND
        // assertNoPendingB2BReferences() as its first two actions, inside
        // THIS transaction.
        //
        // [v4.5] Its return value is captured because resetProductUnits()
        // deliberately accepts NO barcode for the new base unit — a barcode
        // is only ever attached AFTER a reset, through createUnitBarcode().
        // A duplicate value is caught by @@unique([tenantId, barcode]) and
        // surfaces as the friendly BARCODE_EXISTS response below.
        const resetBaseUnit = await resetProductUnits(tx, {
          tenantId,
          productId: id,
          newBaseUnit: {
            unitName: newBaseUnitSubmission.unitName,
            // [FIX] the schema no longer defaults this — apply it here.
            pricingCurrency: newBaseUnitSubmission.pricingCurrency ?? "SYP",
            priceWholesale: newBaseUnitSubmission.priceWholesale,
          },
          changedByUserId: session.user.id,
          reason: data.baseUnitChangeReason!.trim(),
        });

        for (const barcodeRow of newBaseUnitSubmission.barcodes) {
          await createUnitBarcode(tx, tenantId, resetBaseUnit.id, {
            barcode: barcodeRow.barcode,
            barcodeSource: barcodeRow.barcodeSource,
          });
        }

        // GS1 shared-catalog reconciliation for the new base unit's barcodes —
        // the same request-scoped continuity rule as products/route.ts's POST.
        let resetSharedCatalogEntryId: string | null = null;
        for (const barcodeRow of newBaseUnitSubmission.barcodes) {
          if (barcodeRow.barcodeSource !== "GS1") continue;
          resetSharedCatalogEntryId = await resolveSharedCatalogForBarcode(tx, {
            barcode: barcodeRow.barcode,
            name: data.name || existingProduct.name,
            category: data.category !== undefined ? data.category : existingProduct.category,
            imageUrl: effectiveImageUrl ?? null,
            addedByTenantId: tenantId,
            preferEntryId: resetSharedCatalogEntryId,
          });
        }

        // [v4.6] Publishing state is NOT forced to false here: the image
        // belongs to the product, so a base-unit reset cannot invalidate it.
        // The gate was already re-run against the post-reset state above and
        // this request was rejected if the product would not still qualify.
        await updateProduct(tx, tenantId, id, {
          name: data.name,
          category: data.category,
          isActive: data.isActive,
          isPublic: data.isPublic,
          imageUrl: productImageWrite,
        });
      } else {
        await updateProduct(tx, tenantId, id, {
          name: data.name,
          category: data.category, // undefined = untouched, null = cleared
          isActive: data.isActive,
          isPublic: data.isPublic,
          imageUrl: productImageWrite, // undefined = untouched, null = cleared
        });

        if (data.units) {
          // [v4.5] Request-scoped continuity for the shared catalog — see the
          // GS1 loop at the bottom of this block.
          let sharedCatalogEntryId: string | null = null;

          for (const u of data.units) {
            if (u.id && !existingProduct.units.some((eu) => eu.id === u.id)) {
              throw new UnitNotBelongingToProductError(u.id, id);
            }
          }
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

              // [FIX] Persist the unit's own editable fields. Previously this
              // branch handled only the factor and barcodes, so a name /
              // price / image / isActive edit returned 200 "updated" while
              // writing nothing — and the publishing gate above had already
              // validated the never-saved values. `undefined` = untouched;
              // conversionFactor is deliberately absent (SafeProductUnitUpdate
              // excludes it — see the guarded path above).
              await updateProductUnit(tx, tenantId, u.id, {
                unitName: u.unitName,
                priceWholesale: u.priceWholesale,
                pricingCurrency: u.pricingCurrency,
                isActive: u.isActive,
              });

              // [v4.5] ADDITIVE-ONLY barcode writes for an existing unit. A
              // barcode already stored is skipped, so re-saving the form is
              // idempotent rather than a P2002. REMOVAL is exclusively the
              // dedicated DELETE barcode route's job (ADMIN-only).
              const storedBarcodes = new Set(
                (existingProduct.units.find((eu) => eu.id === u.id)?.barcodes ?? []).map(
                  (b) => b.barcode
                )
              );
              for (const barcodeRow of u.barcodes) {
                if (storedBarcodes.has(barcodeRow.barcode)) continue;
                await createUnitBarcode(tx, tenantId, u.id, {
                  barcode: barcodeRow.barcode,
                  barcodeSource: barcodeRow.barcodeSource,
                });
              }
            } else {
              const createdAdditional = await createAdditionalUnit(tx, tenantId, id, u.conversionFactor, {
                unitName: u.unitName,
                // [FIX] the schema no longer defaults this — apply it here.
                pricingCurrency: u.pricingCurrency ?? "SYP",
                priceWholesale: u.priceWholesale,
                isActive: u.isActive !== undefined ? u.isActive : true,
              });

              // [v4.5] A brand-new unit starts with no barcodes, so every
              // submitted row is written.
              for (const barcodeRow of u.barcodes) {
                await createUnitBarcode(tx, tenantId, createdAdditional.id, {
                  barcode: barcodeRow.barcode,
                  barcodeSource: barcodeRow.barcodeSource,
                });
              }
            }

            // [v4.5] GS1 shared-catalog reconciliation for this unit's
            // barcodes (one entry per real product; a new barcode links to
            // the entry this request already resolved). Re-resolving an
            // already-stored barcode is harmless. INTERNAL barcodes never
            // contribute to the shared cross-tenant catalog (T3a §5).
            for (const barcodeRow of u.barcodes) {
              if (barcodeRow.barcodeSource !== "GS1") continue;
              sharedCatalogEntryId = await resolveSharedCatalogForBarcode(tx, {
                barcode: barcodeRow.barcode,
                name: data.name || existingProduct.name,
                category: data.category !== undefined ? data.category : existingProduct.category,
                imageUrl: effectiveImageUrl ?? null,
                addedByTenantId: tenantId,
                preferEntryId: sharedCatalogEntryId,
              });
            }
          }
        }
      }

      return findProductWithUnits(tx, tenantId, id);
    });

    const otherUnitEditsIgnored =
      wantsBaseUnitChange && (data.units?.length ?? 0) > 1;

    return NextResponse.json({
      success: true,
      product: updatedProduct
        ? { ...updatedProduct, units: withLegacyBarcodeFields(updatedProduct.units) }
        : updatedProduct,
      message: wantsBaseUnitChange
        ? "تم تصحيح الوحدة الأساسية للمنتج بنجاح." +
        (otherUnitEditsIgnored
          ? " ملاحظة: لم يتم تطبيق أي تعديلات أخرى على الوحدات ضمن هذا الطلب — أرسلها في طلب منفصل."
          : "")
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
    // Catches the race where assertBaseUnitMutable()'s re-check inside the
    // transaction finds a batch created concurrently, after the early
    // informational check above already passed — for BOTH the base-unit-reset
    // path and the non-base conversionFactor-edit path.
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