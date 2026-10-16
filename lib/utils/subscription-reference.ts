import { randomInt } from "node:crypto";

// Confusable-free alphabet: no 0, O, 1, I, L. 31 symbols.
const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const REF_PREFIX = "JT-";
const REF_LENGTH = 8;
const MAX_RETRIES = 5;

export function generateReferenceCode(): string {
  let out = REF_PREFIX;
  for (let i = 0; i < REF_LENGTH; i++) {
    // randomInt is uniform: no modulo bias, and available on every supported Node.
    out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  }
  return out;
}

/**
 * True only for a P2002 whose target is the referenceCode constraint.
 * Decided from error.meta.target — never from the error message.
 * Accepts both shapes Prisma can report: an array of field names, or a single
 * string (field name or constraint name). Verify against your installed Prisma
 * version with one real duplicate insert in a test.
 */
export function isReferenceCodeCollision(error: unknown): boolean {
  const e = error as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== "P2002") return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.includes("referenceCode");
  if (typeof target === "string") {
    return target === "referenceCode" || target === "Subscription_referenceCode_key";
  }
  return false;
}

export { REF_PREFIX, REF_LENGTH, MAX_RETRIES };