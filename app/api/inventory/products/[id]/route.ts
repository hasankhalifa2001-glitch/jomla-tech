import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { prisma } from "@/lib/db";
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

    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "غير مصرح: تعديل المنتجات متاح لمدير المتجر فقط." },
        { status: 403 }
      );
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
          const duplicate = await db.productUnit.findFirst({
            where: {
              barcode: u.barcode.trim(),
              product: { tenantId },
              NOT: { productId: id },
            },
          });
          if (duplicate) {
            return NextResponse.json(
              {
                error: "DUPLICATE_BARCODE",
                message: `الباركود ${u.barcode.trim()} مستخدم مسبقاً في منتج آخر لديك.`,
              },
              { status: 400 }
            );
          }
        }
      }
    }

    const nextIsActive = data.isActive !== undefined ? data.isActive : existingProduct.isActive;
    let nextIsPublic = data.isPublic !== undefined ? data.isPublic : existingProduct.isPublic;

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

    if (!nextIsActive) {
      if (data.isPublic === true) {
        return NextResponse.json(
          {
            error: "PRODUCT_INACTIVE",
            message: "لا يمكن نشر منتج موقوف في المتجر.",
          },
          { status: 400 }
        );
      }
      nextIsPublic = false;
    } else if (nextIsPublic) {
      const gateCheck = checkProductPublishable({
        isActive: nextIsActive,
        units: candidateUnits,
      });
      if (!gateCheck.publishable) {
        if (data.isPublic === true) {
          return NextResponse.json(
            {
              error: "PUBLISH_GATE_BLOCKED",
              message: gateCheck.reason,
            },
            { status: 400 }
          );
        }
        nextIsPublic = false;
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

          if (u.barcodeSource === "GS1" && u.barcode?.trim()) {
            const barcodeTrim = u.barcode.trim();
            const existingCatalog = await prisma.productCatalogEntry.findUnique({
              where: { barcode: barcodeTrim },
            });
            if (!existingCatalog) {
              await prisma.productCatalogEntry.create({
                data: {
                  barcode: barcodeTrim,
                  name: data.name || product.name,
                  category: data.category !== undefined ? data.category : product.category,
                  imageUrl: u.imageUrl || null,
                  addedByTenantId: tenantId,
                },
              });
            } else if (existingCatalog.addedByTenantId === tenantId) {
              await prisma.productCatalogEntry.update({
                where: { id: existingCatalog.id },
                data: {
                  name: data.name || product.name,
                  category: data.category !== undefined ? data.category : product.category,
                  imageUrl: u.imageUrl || existingCatalog.imageUrl,
                },
              });
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

    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "غير مصرح: تعطيل المنتجات متاح لمدير المتجر فقط." },
        { status: 403 }
      );
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
        isPublic: false,
      },
    });

    return NextResponse.json({
      success: true,
      message: "تم تعطيل المنتج وإلغاء نشره من المتجر بنجاح.",
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
