/**
 * lib/utils/order-reference.ts
 *
 * T5a — the DISPLAY reference of a B2B order. Display-only; never a key, never
 * used to look a row up (T5b's queue search matches it case-insensitively via
 * `endsWith` on the id, not via this string).
 *
 * orderReference(id)  = the last 6 characters of the id, upper-cased.
 * randomReference()   = a throwaway 6-char reference for the honeypot response,
 *                       so that path returns the normal success shape.
 */

export function orderReference(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

// Same alphabet a real reference can contain (cuid is base36, upper-cased), so
// a honeypot reference is statistically indistinguishable from a real one.
// Do NOT "improve" this into a confusable-free alphabet: that would make
// fake references detectable. Modulo bias is irrelevant for a throwaway.
const REF_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function randomReference(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return out;
}