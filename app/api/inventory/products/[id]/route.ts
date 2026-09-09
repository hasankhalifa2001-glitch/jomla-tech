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
import { Prisma } from "@prisma/client";
import { z } from "zod";

const unitSchema = z
  .object({
    id: z.string().optional(),
    unitName: z.string().min(1, "اسم الوحدة مطلوب"),
    conversionFactor: z.number().int().min(1, "معامل التحويل يجب أن يكون 1 أو أكثر"),
    pricingCurrency: z.enum(["SYP", "USD"]).default("SYP"),
    priceWholesale: z.number().min(0, "سعر الجملة لا يمكن أن يكون سالباً"),
    priceRetail: z.number().min(0, "سعر التجزئة لا يمكن أن يكون سالباً").optional().nullable(),
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

    // Role Capability Matrix (T2b) is the single authoritative permission
    // check — no separate manual role comparison here.
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

    // Validate units if provided
    if (data.units) {
      const baseUnits = data.units.filter((u) => u.conversionFactor === 1);
      if (baseUnits.length !== 1) {
        return NextResponse.json(
          {
            error: "BASE_UNIT_REQUIRED",
            message: "يجب تحديد وحدة أساسية واحدة فقط بمعامل تحويل يساوي 1",
          },
          { status: 400 }
        );
      }

      const factors = new Set<number>();
      const names = new Set<string>();
      // Barcodes are checked for uniqueness WITHIN this same request's
      // unit list first — previously only a duplicate against a DIFFERENT
      // product was checked (`NOT: { productId: id }`), so two units on
      // the SAME product sharing a barcode slipped past this pre-check
      // and only surfaced later as a raw P2002 from the DB's
      // `@@unique([tenantId, barcode])` constraint, with no friendly
      // message. Both checks run: in-request duplicates (this Set) and
      // cross-product duplicates (the existing DB lookup, still excluding
      // this product's OTHER existing units so a unit can keep its own
      // unchanged barcode across an edit).
      const barcodesInRequest = new Set<string>();
      for (const u of data.units) {
        if (factors.has(u.conversionFactor)) {
          return NextResponse.json(
            {
              error: "DUPLICATE_CONVERSION_FACTOR",
              message: `معامل التحويل ${u.conversionFactor} مكرر أكثر من مرة`,
            },
            { status: 400 }
          );
        }
        factors.add(u.conversionFactor);

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

    // isActive and isPublic are two fully independent fields, per T1/T3a:
    // "Deactivation/reactivation is purely a visibility toggle, never a
    // data-migration event, and requires no field re-validation."
    //   - isActive changes only if the request explicitly sets it.
    //   - isPublic changes ONLY if the request explicitly sets it
    //     (`data.isPublic !== undefined`). Editing name/category/units, or
    //     toggling isActive, NEVER touches isPublic on its own — it simply
    //     carries over unchanged, exactly as the spec requires for a
    //     reactivated product's prior state to be preserved automatically.
    //   - The publishing gate is validated ONLY when the request is
    //     explicitly trying to turn isPublic ON (data.isPublic === true).
    //     Turning it off, or leaving it untouched, never re-runs the gate.
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

      const candidateUnits = data.units
        ? data.units.map((u) => ({
          isActive: u.isActive !== false,
          imageUrl: u.imageUrl,
          priceRetail: u.priceRetail,
        }))
        : existingProduct.units.map((u) => ({
          isActive: u.isActive !== false,
          imageUrl: u.imageUrl,
          priceRetail: u.priceRetail !== null && u.priceRetail !== undefined ? Number(u.priceRetail) : null,
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

          // [FIX — CRITICAL, per Master Spec T3a §6 / ProductCatalogEntry]
          // ProductCatalogEntry is write-once at creation and MUST NEVER
          // be updated afterward by anyone — not even by the tenant that
          // originally created it. Spec: "a one-time fill-in-the-form
          // convenience, never re-read afterward and never silently kept
          // in sync with a tenant's own edited copy." The previous
          // `else if (existingCatalog.addedByTenantId === tenantId) {
          // update(...) }` branch violated this directly: it silently
          // synced the owning tenant's later product edits back into the
          // shared catalog entry, meaning any OTHER tenant scanning the
          // same barcode later would see whatever the owner's local
          // product happens to say TODAY, not the value that was true
          // when the entry was first created. That branch is removed
          // entirely. The only two valid outcomes here are:
          //   (a) no entry exists yet for this barcode → create one
          //       (this tenant becomes its permanent owner), or
          //   (b) an entry already exists (owned by this tenant or any
          //       other) → do absolutely nothing to it. The only path
          //       that may ever change an existing entry is a
          //       Super-Admin resolving a ProductCatalogEntryReport
          //       (T6) — never a direct tenant write, regardless of
          //       ownership.
          if (u.barcodeSource === "GS1" && u.barcode?.trim()) {
            const barcodeTrim = u.barcode.trim();
            const existingCatalog = await tx.productCatalogEntry.findUnique({
              where: { barcode: barcodeTrim },
            });
            if (!existingCatalog) {
              await tx.productCatalogEntry.create({
                data: {
                  barcode: barcodeTrim,
                  name: data.name || product.name,
                  category: data.category !== undefined ? data.category : product.category,
                  imageUrl: u.imageUrl || null,
                  addedByTenantId: tenantId,
                },
              });
            }
            // No `else` branch — an existing entry, owned by this tenant
            // or any other, is never touched here under any condition.
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
    // P2002 (unique constraint violation) can still slip through the
    // in-request and cross-product pre-checks above under a concurrent
    // request racing this same edit — surface it as a friendly Arabic
    // message instead of a generic 500, same pattern already used in
    // products/route.ts's POST handler.
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

    // Role Capability Matrix (T2b) is the single authoritative permission
    // check — no separate manual role comparison here.
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

    // isPublic is deliberately left untouched by this write. Deactivation
    // here is the same soft-delete action as the toggle-active route — a
    // pure visibility toggle. The storefront query already filters on
    // isActive: true, so isActive: false alone already hides the product;
    // isPublic stays exactly as it was, so a later reactivation restores
    // the product's storefront visibility automatically with no manual
    // re-publishing step.
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