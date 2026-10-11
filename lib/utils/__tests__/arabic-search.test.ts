import { describe, it, expect } from "vitest";
import { normalizeArabic, normalizeCategory } from "@/lib/utils/arabic-search";
import { STORE_UNCATEGORIZED_KEY } from "@/lib/config/storefront";

/**
 * T5a - Arabic folding for the storefront's in-application search and category
 * grouping. The storefront cannot fold in the DB (raw SQL forbidden), so these
 * functions are the entire search/grouping contract.
 */
describe("normalizeArabic (search)", () => {
  it("strips tashkeel so a vocalized query matches a bare name", () => {
    expect(normalizeArabic("مُدَار")).toBe(normalizeArabic("مدار"));
    expect(normalizeArabic("مُقَدَّمِات")).toBe(normalizeArabic("مقدمات"));
  });

  it("strips tatweel (kashida)", () => {
    const withTatweel = "مش" + "ـــ" + "روبات";
    expect(normalizeArabic(withTatweel)).toBe(normalizeArabic("مشروبات"));
    expect(normalizeArabic("مـدار")).toBe(normalizeArabic("مدار"));
  });

  it("folds alef variants أ إ آ to ا", () => {
    expect(normalizeArabic("أحمد")).toBe(normalizeArabic("احمد"));
    expect(normalizeArabic("إبراهيم")).toBe(normalizeArabic("ابراهيم"));
    expect(normalizeArabic("آمال")).toBe(normalizeArabic("امال"));
    expect(normalizeArabic("مدآر")).toBe(normalizeArabic("مدار"));
  });

  it("folds alef maqsura ى to ي", () => {
    expect(normalizeArabic("مصطفى")).toBe(normalizeArabic("مصطفي"));
  });

  it("folds ta-marbuta ة to ه", () => {
    expect(normalizeArabic("مشكلة")).toBe(normalizeArabic("مشكله"));
  });

  it("lower-cases Latin text (brand names)", () => {
    expect(normalizeArabic("Pepsi")).toBe(normalizeArabic("pepsi "));
    expect(normalizeArabic("PEPSI")).toBe("pepsi");
  });

  it("collapses internal whitespace and trims", () => {
    expect(normalizeArabic("  عصير    مانجو  ")).toBe("عصير مانجو");
  });

  it("returns empty string for null/undefined/blank", () => {
    expect(normalizeArabic(null)).toBe("");
    expect(normalizeArabic(undefined)).toBe("");
    expect(normalizeArabic("   ")).toBe("");
  });
});

describe("normalizeCategory (grouping key)", () => {
  it("groups trim/spacing variants together", () => {
    expect(normalizeCategory("مشروبات")).toBe(normalizeCategory("  مشروبات  "));
    expect(normalizeCategory("عصائر  طبيعية")).toBe(normalizeCategory("عصائر طبيعية"));
  });

  it("groups alef/ta-marbuta variants under one key", () => {
    expect(normalizeCategory("ألبان")).toBe(normalizeCategory("البان"));
    expect(normalizeCategory("بقالة")).toBe(normalizeCategory("بقاله"));
  });

  it("groups Latin case variants under one key", () => {
    expect(normalizeCategory("Pepsi")).toBe(normalizeCategory("pepsi "));
    expect(normalizeCategory("PEPSI")).toBe(normalizeCategory("pepsi"));
  });

  it("returns '' for null/undefined/blank (caller maps '' to the uncategorized key)", () => {
    expect(normalizeCategory(null)).toBe("");
    expect(normalizeCategory(undefined)).toBe("");
    expect(normalizeCategory("")).toBe("");
    expect(normalizeCategory("   ")).toBe("");
  });

  it("never produces the reserved uncategorized key from a real category", () => {
    expect(normalizeCategory("__none__")).not.toBe(STORE_UNCATEGORIZED_KEY);
    expect(normalizeCategory("  __none__ ")).not.toBe(STORE_UNCATEGORIZED_KEY);
    expect(normalizeCategory("__none__")).toBe("___none__");
  });

  it("keeps the escape injective: '__x' and '___x' stay distinct", () => {
    expect(normalizeCategory("__x")).not.toBe(normalizeCategory("___x"));
  });

  it("a category literally named 'أخرى' is its own group, distinct from the uncategorized key", () => {
    expect(normalizeCategory("أخرى")).not.toBe(STORE_UNCATEGORIZED_KEY);
    expect(normalizeCategory("أخرى")).not.toBe("");
  });
});