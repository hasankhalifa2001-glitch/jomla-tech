/**
 * lib/data/ledger-adjustments.ts
 *
 * T4e v6.1 — gateway for CustomerBalanceAdjustment (opening-balance /
 * correction entries). All writes are top-level prisma.model.method() calls
 * inside a single $transaction opened by the caller; no nested
 * create/update/connect/upsert/disconnect, no $queryRaw. TenantId always
 * comes from the authenticated session — never from the client.
 *
 * The amount upper bound (MAX_ADJUSTMENT_AMOUNT_SYP) lives in
 * lib/config/ledger.ts and is imported from there directly by the route and
 * by client-side helpers; it is deliberately NOT re-exported from this
 * server-side file.
 */

import type { CustomerBalanceAdjustmentKind } from "@prisma/client";
import type { TxOrClient } from "@/lib/db/tenant-scope";

export interface CreateBalanceAdjustmentParams {
  tenantId: string;
  createdByUserId: string;
  customerId: string;
  kind: CustomerBalanceAdjustmentKind;
  amountSYP: string;
  reason: string;
  idempotencyKey: string;
}

/**
 * Creates a single CustomerBalanceAdjustment row. One top-level write only;
 * atomicity with any companion write (e.g. a NEW customer row) is provided
 * by the caller's $transaction.
 */
export async function createBalanceAdjustment(
  tx: TxOrClient,
  params: CreateBalanceAdjustmentParams
) {
  return tx.customerBalanceAdjustment.create({
    data: {
      tenantId: params.tenantId,
      customerId: params.customerId,
      kind: params.kind,
      amountSYP: params.amountSYP,
      reason: params.reason,
      createdByUserId: params.createdByUserId,
      idempotencyKey: params.idempotencyKey,
    },
    select: {
      id: true,
      customerId: true,
      kind: true,
      amountSYP: true,
      reason: true,
      idempotencyKey: true,
      createdAt: true,
    },
  });
}

/**
 * Finds an existing adjustment by its client-generated idempotency key.
 *
 * Used twice by POST /api/ledger/adjustments: in the idempotency pre-check
 * before any write, and again to re-read the winning row after a racing
 * duplicate was rejected with P2002 on (tenantId, idempotencyKey). Explicit
 * tenantId in the `where` (the unique key is per tenant, and the
 * getTenantDb() extension also injects it).
 *
 * Callers compare the returned row with the request (kind, amountSYP, and the
 * RESOLVED customer id) before replaying it, and must serialize amountSYP
 * with toString() when building a response.
 */
export async function findAdjustmentByIdempotencyKey(
  dbOrTx: TxOrClient,
  tenantId: string,
  idempotencyKey: string
) {
  return dbOrTx.customerBalanceAdjustment.findFirst({
    where: { tenantId, idempotencyKey },
    select: {
      id: true,
      customerId: true,
      kind: true,
      amountSYP: true,
      reason: true,
      idempotencyKey: true,
      createdAt: true,
    },
  });
}

/**
 * Lists a customer's balance adjustments, newest first (id breaks ties so the
 * order is stable when two rows share a createdAt). Explicit tenantId filter
 * for defense-in-depth (the getTenantDb() extension also injects it).
 *
 * `amountSYP` is a Prisma Decimal: the API layer must serialize it with
 * toString() before returning JSON.
 */
export async function listAdjustmentsForCustomer(
  dbOrTx: TxOrClient,
  tenantId: string,
  customerId: string
) {
  return dbOrTx.customerBalanceAdjustment.findMany({
    where: { tenantId, customerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      kind: true,
      amountSYP: true,
      reason: true,
      createdAt: true,
      createdByUser: {
        select: { name: true },
      },
    },
  });
}