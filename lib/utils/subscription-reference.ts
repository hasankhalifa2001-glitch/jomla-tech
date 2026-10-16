/**
 * lib/utils/subscription-reference.ts
 *
 * T6a — reference code generator for subscription payment requests.
 *
 * Format: `JT-` + 8 characters drawn from an unambiguous alphabet that
 * excludes visually-confusable characters (no `0`, `O`, `1`, `I`, `L`), so
 * merchants never misread a code when writing it in a transfer note.
 *
 * On a Prisma unique violation (P2002) targeting `referenceCode`, the code is
 * regenerated and retried, up to 5 attempts. An unrelated P2002 (targeting a
 * different unique field) is never treated as a reference collision and is
 * re-thrown.
 */

// Confusable-free uppercase alphanumeric: A-Z minus I, L, O; 0-9 minus 0, 1.
// Result: 23 letters + 8 digits = 31 symbols.
const REF_ALPHABET =
  "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const REF_PREFIX = "JT-";
const REF_LENGTH = 8;
const MAX_RETRIES = 5;

export function generateReferenceCode(): string {
  const bytes = new Uint8Array(REF_LENGTH);
  crypto.getRandomValues(bytes);
  let out = REF_PREFIX;
  for (let i = 0; i < REF_LENGTH; i++) {
    out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  }
  return out;
}

/**
 * Detects whether a Prisma P2002 unique-violation error targets the
 * `referenceCode` field specifically (via error.meta.target), never via a
 * message substring. Returns true only when referenceCode is among the
 * constrained targets.
 */
export function isReferenceCodeCollision(error: unknown): boolean {
  const prismaError = error as { code?: string; meta?: { target?: unknown } };
  if (prismaError.code !== "P2002") return false;
  const target = prismaError.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("referenceCode");
  }
  if (typeof target === "string") {
    return target === "referenceCode";
  }
  return false;
}

export { REF_PREFIX, REF_LENGTH, MAX_RETRIES };
