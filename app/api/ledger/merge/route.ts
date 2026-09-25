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
// [FIX] The same sole-sanctioned-path helper every other write route
// (T4c sync, T4d void, T5 B2B approval) already goes through — see this
// file's header note below for why the merge route itself was the one
// write path NOT calling it, and why that was a real gap.
import { resolveActiveCustomerId } from "@/lib/customers/resolve-active";
import { CustomerMergeRecordType, Prisma, type Prisma as PrismaTypes } from "@prisma/client";
import { z } from "zod";

const mergeCustomersSchema = z.object({
  survivingCustomerId: z.string().min(1, "معرف الزبون الأساسي مطلوب."),
  mergedCustomerId: z.string().min(1, "معرف الزبون المكرر المراد دمجه مطلوب."),
});

/**
 * POST /api/ledger/merge
 *
 * Wholesale Arabic SaaS Platform — T4e Addendum (v4.2, corrected v4.5)
 *
 * Merges a duplicate customer account into a surviving customer account.
 * All writes occur inside a single database transaction:
 *   1. [FIX — v4.5] Resolves survivingCustomerId through
 *      resolveActiveCustomerId() BEFORE any read or write — see the
 *      dedicated FIX note below for the real bug this closes.
 *   2. Identifies and re-points all Invoices from mergedCustomerId -> the
 *      RESOLVED survivingCustomerId
 *   3. Identifies and re-points all CustomerPayments from mergedCustomerId ->
 *      the RESOLVED survivingCustomerId
 *   4. Deactivates the duplicate customer (isActive: false)
 *   5. Writes summary CustomerMergeLog (against the RESOLVED survivor)
 *   6. Refreshes B2BOrderRequest.matchedCustomerId for PENDING_REVIEW orders
 *      ONLY — deliberately. An order that has already moved to APPROVED keeps
 *      whatever matchedCustomerId it had at approval time, unrefreshed,
 *      indefinitely. The field's only documented purpose (per T1) is a
 *      pre-approval hint shown to the reviewing admin; once approval has
 *      happened it is inert and feeds no downstream calculation, so leaving it
 *      stale after a merge is a display-only historical artifact, not a
 *      correctness gap. The `status` filter below is load-bearing.
 *   7. Writes CustomerMergeLogItem append-only audit trail rows for every re-pointed record
 *
 * [FIX — v4.5, this revision — closes a real "merge into a dead end" bug]
 * Every OTHER write path that resolves a customerId before a financial write
 * (T4c sync, T4d void — both online and offline/sync, T5 B2B approval) goes
 * through resolveActiveCustomerId() as the sole sanctioned path (see that
 * file's own header doc). This route — the one that actually WRITES the
 * CustomerMergeLog rows those other paths read — was the one write path that
 * never called it on its OWN survivingCustomerId input.
 *
 * Concretely: nothing previously stopped an ADMIN (via a stale UI reference,
 * a direct API call, or simply re-opening an old duplicate-merge suggestion
 * card after already having merged that exact survivor into someone else)
 * from submitting a survivingCustomerId that was ITSELF already merged away
 * (isActive: false, with its own CustomerMergeLog row pointing to a further
 * survivor). The only check performed was on `duplicate.isActive` — the
 * customer being merged AWAY — never on `survivor.isActive`, the customer
 * being merged INTO.
 *
 * Had this gone through, every Invoice/CustomerPayment belonging to the new
 * duplicate would have been re-pointed onto a customer row that is itself
 * inactive and invisible in every "active customers" list/picker in the
 * system — the merged debt would not be lost from the database, but would
 * become practically unreachable from any normal screen (T4e's ledger, the
 * customer picker, the merge-suggestion UI) until/unless that dead-end
 * customer happened to be merged again in the future, purely by chance.
 * resolveActiveCustomerId() chasing a merge chain on every OTHER write path
 * would still have redirected any INDIVIDUAL future invoice/payment to the
 * true final survivor correctly — but this route's own CustomerMergeLog row
 * would permanently record a merge INTO a non-final node, and the
 * re-pointing this route performs itself (steps 2-3 above) would have
 * landed those specific historical records on that dead end for good,
 * since this route re-points them directly, once, outside of
 * resolveActiveCustomerId()'s normal per-write resolution path.
 *
 * FIX: survivingCustomerId is resolved via resolveActiveCustomerId() as the
 * very first operation inside the transaction — before the existence
 * lookups, before any read. Every subsequent step in this route (the
 * survivor existence/isSystemGenerated/isActive checks, the invoice/payment
 * re-pointing, the CustomerMergeLog write, the B2BOrderRequest refresh) uses
 * ONLY the resolved ID from that point forward. A defensive
 * `!survivor.isActive` check is also added as a second, independent
 * backstop — structurally this should now be unreachable given the
 * resolution above, but costs nothing to keep as defense-in-depth against a
 * future change to resolveActiveCustomerId() or a data-integrity edge case
 * the resolution didn't anticipate.
 *
 * mergedCustomerId is deliberately NOT resolved the same way — the
 * `!duplicate.isActive` check already rejects it outright if it was already
 * merged away (a customer that's already merged away is deactivated and
 * must never be eligible to be merged again — see CustomerMergeLog's own
 * @unique constraint on mergedCustomerId, the DB-level backstop for exactly
 * this). Resolving mergedCustomerId through the chain would silently
 * redirect the ADMIN's actual selection to some other customer entirely,
 * which is never the right behavior for the side being merged AWAY — the
 * admin explicitly chose that customer to deactivate, and that choice must
 * either succeed as stated or fail with a clear, honest error, never be
 * silently substituted.
 *
 * Scoping Guarantee (Prevent Audit Desync):
 * The IDs to re-point are queried first, and updateMany is strictly scoped to `id: { in: ids }`
 * matching the exact list written to CustomerMergeLogItem.
 *
 * [FIX — v4.5] P2002 handling: a genuine race — two concurrent merge
 * requests both targeting the same mergedCustomerId — is now caught
 * specifically (matching the pattern every other write route in this
 * codebase already uses for its own double-action guard: T4d's void,
 * T1's B2B approval) and mapped to a clear, honest Arabic message with a
 * 409 status, instead of leaking Prisma's raw constraint-violation text
 * ("Unique constraint failed on the fields: (`mergedCustomerId`)") to the
 * client. An unrelated P2002 is never mislabeled as "already merged" —
 * checked against error.meta.target including "mergedCustomerId"
 * specifically, never a substring match on the error message.
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

    const { survivingCustomerId: rawSurvivingCustomerId, mergedCustomerId } = validation.data;

    // [FIX — v4.5] A cheap, pre-transaction rejection for the literal-same-id
    // case still applies to the RAW input — submitting the same id for both
    // fields is always a mistake regardless of merge-chain resolution, and
    // catching it here (before opening a transaction) is the same
    // cheapest-rejection-first posture used elsewhere in this codebase
    // (e.g. T4d's void-eligibility check).
    if (rawSurvivingCustomerId === mergedCustomerId) {
      return NextResponse.json(
        { error: "SAME_CUSTOMER", message: "لا يمكن دمج الزبون مع نفسه." },
        { status: 400 }
      );
    }

    const db = getTenantDb(tenantId);

    let mergeResult;
    try {
      mergeResult = await db.$transaction(async (tx) => {
        // [FIX — v4.5, THE CORE FIX] Resolve survivingCustomerId through
        // the sole sanctioned merge-chain-resolution path BEFORE any read
        // or write in this transaction — see the file-header FIX note for
        // the full "merge into a dead end" bug this closes. Every
        // subsequent line in this transaction uses ONLY
        // resolvedSurvivingCustomerId, never the raw input.
        const resolvedSurvivingCustomerId = await resolveActiveCustomerId(
          tx,
          tenantId,
          rawSurvivingCustomerId
        );

        // [FIX — v4.5] Re-check the same-customer case AFTER resolution too:
        // an admin could submit two DIFFERENT raw ids that both resolve to
        // the same current survivor (e.g. picking two customers that were
        // each already merged into the same third customer earlier). This
        // is just as much a no-op/error as the raw-input case above and
        // must be rejected the same way, inside the transaction where the
        // resolved value is actually known.
        if (resolvedSurvivingCustomerId === mergedCustomerId) {
          throw new Error("لا يمكن دمج الزبون مع نفسه (بعد تتبع سلسلة الدمج السابقة).");
        }

        // 1. Validate both customers exist and belong to this tenant —
        // survivor lookup now uses the RESOLVED id.
        const [survivor, duplicate] = await Promise.all([
          tx.customer.findFirst({
            where: { id: resolvedSurvivingCustomerId, tenantId },
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
        // [FIX — v4.5] Defensive backstop — structurally unreachable given
        // the resolution above (resolveActiveCustomerId always chases to
        // an unmerged node, and a customer with no CustomerMergeLog row
        // pointing away from it should never itself carry isActive: false
        // through any other code path in this system), but kept as
        // defense-in-depth per this file's own FIX note.
        if (!survivor.isActive) {
          throw new Error("لا يمكن الدمج ضمن زبون غير نشط.");
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

        // 4. Re-point Invoices — scoped strictly to invoiceIds to prevent
        // audit desync. Target is now the RESOLVED survivor.
        if (invoiceIds.length > 0) {
          await tx.invoice.updateMany({
            where: { tenantId, id: { in: invoiceIds } },
            data: { customerId: resolvedSurvivingCustomerId },
          });
        }

        // 5. Re-point CustomerPayments — scoped strictly to paymentIds to
        // prevent audit desync. Target is now the RESOLVED survivor.
        if (paymentIds.length > 0) {
          await tx.customerPayment.updateMany({
            where: { tenantId, id: { in: paymentIds } },
            data: { customerId: resolvedSurvivingCustomerId },
          });
        }

        // 6. Deactivate the duplicate customer
        await tx.customer.update({
          where: { id: mergedCustomerId, tenantId },
          data: { isActive: false },
        });

        // 7. Write summary CustomerMergeLog — against the RESOLVED survivor,
        // so this log row itself always points at a real, currently-active
        // final destination, never at an intermediate/dead-end node.
        const mergeLog = await tx.customerMergeLog.create({
          data: {
            tenantId,
            survivingCustomerId: resolvedSurvivingCustomerId,
            mergedCustomerId,
            performedByUserId: userId,
          },
        });

        // 8. Refresh matchedCustomerId on PENDING_REVIEW B2BOrderRequests
        // ONLY. The status filter is load-bearing, not incidental — see
        // item 6 of this route's header: an APPROVED order's
        // matchedCustomerId is historical/display-only and is
        // intentionally left untouched by a later merge. Target is the
        // RESOLVED survivor.
        await tx.b2BOrderRequest.updateMany({
          where: {
            tenantId,
            matchedCustomerId: mergedCustomerId,
            status: "PENDING_REVIEW",
          },
          data: {
            matchedCustomerId: resolvedSurvivingCustomerId,
          },
        });

        // 9. CustomerMergeLogItem — append-only audit trail rows for every
        // re-pointed record
        const logItemsData: PrismaTypes.CustomerMergeLogItemCreateManyInput[] = [
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
          resolvedSurvivingCustomerId,
          repointedInvoicesCount: invoiceIds.length,
          repointedPaymentsCount: paymentIds.length,
        };
      });
    } catch (txError) {
      // [FIX — v4.5] Narrow P2002 handling — a genuine race between two
      // concurrent merge requests for the same mergedCustomerId. Checked
      // against error.meta.target specifically, never a substring match
      // on the error message, so an unrelated P2002 (a different unique
      // constraint entirely) is never mislabeled as "already merged."
      if (
        txError instanceof Prisma.PrismaClientKnownRequestError &&
        txError.code === "P2002" &&
        Array.isArray(txError.meta?.target) &&
        (txError.meta.target as string[]).includes("mergedCustomerId")
      ) {
        return NextResponse.json(
          {
            error: "CONCURRENCY_ERROR",
            message: "تم دمج هذا الزبون بالفعل ضمن عملية أخرى متزامنة — يرجى تحديث الصفحة.",
          },
          { status: 409 }
        );
      }
      throw txError;
    }

    return NextResponse.json({
      success: true,
      mergeLogId: mergeResult.mergeLogId,
      survivingCustomerId: mergeResult.resolvedSurvivingCustomerId,
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