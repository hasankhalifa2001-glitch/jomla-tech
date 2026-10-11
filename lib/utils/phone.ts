/**
 * lib/utils/phone.ts
 *
 * T5a - THE single phone normalizer for the whole B2B feature. Every phone
 * stored on a B2BOrderRequest, used for the per-phone pending cap, matched
 * against VerifiedRetailer, or used to build a wa.me link passes through one
 * of these two functions. Recon confirmed no normalizer existed anywhere, so
 * this is the one and only definition (the schema VerifiedRetailer note
 * "same helper as B2BOrderRequest.retailerPhone" depends on it).
 *
 * normalizePhone(raw) -> local Syrian mobile form "09XXXXXXXX" or null.
 * toWhatsAppNumber(raw) -> international digits-only "9639XXXXXXXX" or null.
 *
 * It is deliberately conservative: it only recognizes numbers that reduce to
 * a valid Syrian mobile (09 + 8 digits). Anything else -> null, so a bad
 * number is rejected at validation instead of silently stored in a wrong form.
 * (Landlines are intentionally NOT accepted; see the owner decision in the
 * T5a report.)
 */

// Arabic-Indic (U+0660-0669) and Extended Arabic-Indic / Persian (U+06F0-06F9)
// digits -> ASCII. Done FIRST so a phone typed with Arabic numerals is treated
// identically to its ASCII spelling.
function foldArabicDigits(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x0660 && code <= 0x0669) {
      out += String(code - 0x0660);
    } else if (code >= 0x06f0 && code <= 0x06f9) {
      out += String(code - 0x06f0);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * A plausible Syrian mobile in LOCAL form: 09 then exactly 8 digits (10 total).
 * This is the ONLY shape normalizePhone ever returns, so callers can compare
 * stored phones with a plain string equality.
 */
const LOCAL_MOBILE_RE = /^09\d{8}$/;

/** National significant part of a Syrian mobile: 9 then exactly 8 digits. */
const NATIONAL_MOBILE_RE = /^9\d{8}$/;

/**
 * Normalizes any common Syrian phone spelling to the local "09XXXXXXXX" form.
 * Returns null when the digit count is implausible or it is not a Syrian
 * mobile. Accepts: leading +, spaces, dashes, parentheses, Arabic-Indic
 * digits, and the 00963 / 963 / 0 prefixes, including the common
 * "+963 (0) 9XX XXX XXX" spelling that carries a redundant local zero.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;

  // Strip every separator (spaces, dashes, parentheses, +) and anything else
  // that is not a digit, AFTER folding Arabic-Indic digits.
  const digits = foldArabicDigits(String(raw)).replace(/\D/g, "");
  if (!digits) return null;

  // Reduce to the national part (the 9XXXXXXXX that follows the prefix).
  // Order matters: 00963 before 963, and both before the bare local 0.
  let national: string;
  if (digits.startsWith("00963")) {
    national = digits.slice(5);
    // "+963 (0) 9..." -> a redundant local zero after the country code.
    if (national.startsWith("0")) national = national.slice(1);
  } else if (digits.startsWith("963")) {
    national = digits.slice(3);
    if (national.startsWith("0")) national = national.slice(1);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    // Bare "9XXXXXXXX": a mobile typed without its leading 0.
    national = digits;
  }

  return NATIONAL_MOBILE_RE.test(national) ? "0" + national : null;
}

/**
 * Converts a phone to the international, digits-only wa.me form
 * "9639XXXXXXXX" (drop the local leading 0, prepend 963; no +, no spaces).
 *
 * Returns null unless the normalized number is a valid Syrian mobile - the
 * caller hides the WhatsApp button in that case, and NEVER builds a wa.me URL
 * from a raw or merely-normalized phone.
 */
export function toWhatsAppNumber(raw: string | null | undefined): string | null {
  const local = normalizePhone(raw);
  if (!local || !LOCAL_MOBILE_RE.test(local)) return null;
  return "963" + local.slice(1);
}