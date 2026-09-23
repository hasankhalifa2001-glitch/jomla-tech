import { NextResponse } from "next/server";
import { auth } from "@/auth";
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
import { getTenantDb } from "@/lib/db/tenant-scope";
import { CustomerMergeRecordType, type Prisma } from "@prisma/client";
import { z } from "zod";

const mergeCustomersSchema = z.object({
  survivingCustomerId: z.string().min(1, "معرف الزبون الأساسي مطلوب."),
  mergedCustomerId: z.string().min(1, "معرف الزبون المكرر المراد دمجه مطلوب."),
});

/**
 * POST /api/ledger/merge
 *
 * Wholesale Arabic SaaS Platform — T4e Addendum (v4.2)
 *
 * Merges a duplicate customer account into a surviving customer account.
 * All writes occur inside a single database transaction:
 *   1. Identifies and re-points all Invoices from mergedCustomerId -> survivingCustomerId
 *   2. Identifies and re-points all CustomerPayments from mergedCustomerId -> survivingCustomerId
 *   3. Deactivates the duplicate customer (isActive: false)
 *   4. Writes summary CustomerMergeLog
 *   5. Refreshes B2BOrderRequest.matchedCustomerId for PENDING_REVIEW orders
 *   6. Writes CustomerMergeLogItem append-only audit trail rows for every re-pointed record
 *
 * Scoping Guarantee (Prevent Audit Desync):
 * The IDs to re-point are queried first, and updateMany is strictly scoped to `id: { in: ids }`
 * matching the exact list written to CustomerMergeLogItem.
 *
 * Known Limitation:
 * Does not place a database-level row lock on Customer (avoids distributed lock contention with
 * offline writers). Writes arriving after or concurrent with the merge are redirected by
 * resolveActiveCustomerId().
 */
export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId || !session.user.id) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    // Role Capability Matrix: customer merge is ADMIN-only
    assertRolePermission(session.user.role, "ledger:merge_customers");

    const tenantId = session.user.tenantId;
    const userId = session.user.id;

    // Security boundary: assert tenant subscription is active
    await assertTenantWritable(tenantId);

    const body = await req.json();
    const validation = mergeCustomersSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات الدمج غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { survivingCustomerId, mergedCustomerId } = validation.data;

    if (survivingCustomerId === mergedCustomerId) {
      return NextResponse.json(
        { error: "SAME_CUSTOMER", message: "لا يمكن دمج الزبون مع نفسه." },
        { status: 400 }
      );
    }

    const db = getTenantDb(tenantId);

    const mergeResult = await db.$transaction(async (tx) => {
      // 1. Validate both customers exist and belong to this tenant
      const [survivor, duplicate] = await Promise.all([
        tx.customer.findFirst({
          where: { id: survivingCustomerId, tenantId },
          select: { id: true, isSystemGenerated: true, isActive: true },
        }),
        tx.customer.findFirst({
          where: { id: mergedCustomerId, tenantId },
          select: { id: true, isSystemGenerated: true, isActive: true },
        }),
      ]);

      if (!survivor) {
        throw new Error("الزبون الأساسي (المتبقي) غير موجود.");
      }
      if (!duplicate) {
        throw new Error("الزبون المكرر (المراد دمجه) غير موجود.");
      }
      if (survivor.isSystemGenerated || duplicate.isSystemGenerated) {
        throw new Error("لا يمكن دمج حساب الزبون النقدي العام (الافتراضي).");
      }
      if (!duplicate.isActive) {
        throw new Error("الزبون المكرر غير نشط أو تم دمجه مسبقاً.");
      }

      // 2. Fetch all Invoice IDs for mergedCustomerId
      const invoiceRows = await tx.invoice.findMany({
        where: { tenantId, customerId: mergedCustomerId },
        select: { id: true },
      });
      const invoiceIds = invoiceRows.map((r) => r.id);

      // 3. Fetch all CustomerPayment IDs for mergedCustomerId
      const paymentRows = await tx.customerPayment.findMany({
        where: { tenantId, customerId: mergedCustomerId },
        select: { id: true },
      });
      const paymentIds = paymentRows.map((r) => r.id);

      // 4. Re-point Invoices — scoped strictly to invoiceIds to prevent audit desync
      if (invoiceIds.length > 0) {
        await tx.invoice.updateMany({
          where: { tenantId, id: { in: invoiceIds } },
          data: { customerId: survivingCustomerId },
        });
      }

      // 5. Re-point CustomerPayments — scoped strictly to paymentIds to prevent audit desync
      if (paymentIds.length > 0) {
        await tx.customerPayment.updateMany({
          where: { tenantId, id: { in: paymentIds } },
          data: { customerId: survivingCustomerId },
        });
      }

      // 6. Deactivate the duplicate customer
      await tx.customer.update({
        where: { id: mergedCustomerId, tenantId },
        data: { isActive: false },
      });

      // 7. Write summary CustomerMergeLog
      const mergeLog = await tx.customerMergeLog.create({
        data: {
          tenantId,
          survivingCustomerId,
          mergedCustomerId,
          performedByUserId: userId,
        },
      });

      // 8. Fifth top-level write: Refresh matchedCustomerId on PENDING_REVIEW B2BOrderRequests
      await tx.b2BOrderRequest.updateMany({
        where: {
          tenantId,
          matchedCustomerId: mergedCustomerId,
          status: "PENDING_REVIEW",
        },
        data: {
          matchedCustomerId: survivingCustomerId,
        },
      });

      // 9. CustomerMergeLogItem — append-only audit trail rows for every re-pointed record
      const logItemsData: Prisma.CustomerMergeLogItemCreateManyInput[] = [
        ...invoiceIds.map((recId) => ({
          tenantId,
          mergeLogId: mergeLog.id,
          recordType: CustomerMergeRecordType.INVOICE,
          recordId: recId,
        })),
        ...paymentIds.map((recId) => ({
          tenantId,
          mergeLogId: mergeLog.id,
          recordType: CustomerMergeRecordType.PAYMENT,
          recordId: recId,
        })),
      ];

      if (logItemsData.length > 0) {
        await tx.customerMergeLogItem.createMany({
          data: logItemsData,
        });
      }

      return {
        mergeLogId: mergeLog.id,
        repointedInvoicesCount: invoiceIds.length,
        repointedPaymentsCount: paymentIds.length,
      };
    });

    return NextResponse.json({
      success: true,
      mergeLogId: mergeResult.mergeLogId,
      survivingCustomerId,
      mergedCustomerId,
      repointedInvoicesCount: mergeResult.repointedInvoicesCount,
      repointedPaymentsCount: mergeResult.repointedPaymentsCount,
      message: "تم دمج حسابات الزبائن بنجاح.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء دمج الزبائن.";
    console.error("Error merging customers:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message }, { status: 400 });
  }
}
