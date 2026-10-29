/**
 * lib/config/ledger.ts
 *
 * Owner-tunable limits for the customer balance-adjustment (previous-debts)
 * feature (opening balances / corrections). Kept in a small config module
 * with NO server-only imports so client-side helpers (the previous-debts
 * entry screen) can import the same bound for client-side validation and
 * display without pulling in Prisma or the tenant-scope client.
 * No schema change; additive only.
 */

/**
 * Upper bound for a single adjustment, in SYP, as a decimal string:
 * 1,000,000,000 SYP.
 *
 * The bound applies to the ABSOLUTE value of the amount: a CORRECTION may be
 * negative, and a negative correction of -1,000,000,001 must be rejected just
 * like a positive one. Compare with compareMoney on the absolute value; never
 * with native numbers.
 */
export const MAX_ADJUSTMENT_AMOUNT_SYP = "1000000000";