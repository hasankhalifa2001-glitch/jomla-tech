/**
 * lib/utils/arabic-search.ts
 *
 * T5a — Arabic text normalization for the storefront's server-side search and
 * category grouping. Raw SQL is forbidden and Arabic folding cannot be done in
 * the database, so the gateway loads a light product list and folds/filters it
 * here, in the application.
 *
 * normalizeArabic(raw)   — for SEARCH matching: strip tashkeel + tatweel, fold
 *   alef/ya/ta-marbuta variants, lower-case Latin text, collapse whitespace.
 * normalizeCategory(raw) — the GROUPING KEY for categories: the same folding,
 *   plus an escape so no real category can ever equal STORE_UNCATEGORIZED_KEY.
 *   Returns "" for a null/blank category; the CALLER maps "" to
 *   STORE_UNCATEGORIZED_KEY. The DISPLAY text is the first-seen original
 *   spelling, kept by the caller, not here.
 */

// Tashkeel U+064B-U+065F, superscript alef U+0670, tatweel U+0640.
// Example: "مُدَار" and "مدار" both become "مدار".
const TASHKEEL_TATWEEL_RE = /[\u064B-\u065F\u0670\u0640]/g;

// Alef variants (أ إ آ ٱ) -> ا ; alef maqsura ى -> ي ; ta-marbuta ة -> ه.
function foldLetters(input: string): string {
  return input
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647");
}

/** Search-matching normalization. */
export function normalizeArabic(raw: string | null | undefined): string {
  if (raw == null) return "";
  return foldLetters(String(raw))
    .replace(TASHKEEL_TATWEEL_RE, "")
    .toLowerCase() // brand names are often Latin: "Pepsi" must match "pepsi"
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Category grouping key. Injective escape for the reserved "__" namespace:
 * any key starting with "__" gets one extra "_" prepended, so a merchant
 * category literally named "__none__" becomes "___none__" and can never
 * equal the internal STORE_UNCATEGORIZED_KEY ("__none__").
 */
export function normalizeCategory(raw: string | null | undefined): string {
  const key = normalizeArabic(raw);
  return key.startsWith("__") ? "_" + key : key;
}