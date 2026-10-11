import { describe, it, expect } from "vitest";
import { normalizePhone, toWhatsAppNumber } from "@/lib/utils/phone";

/**
 * T5a - normalizePhone / toWhatsAppNumber unit tests. Every stored phone, the
 * per-phone cap, the VerifiedRetailer match and the wa.me link go through
 * these two functions, so their exact folding is load-bearing.
 */
describe("normalizePhone", () => {
  it("keeps an already-local 09XXXXXXXX number unchanged", () => {
    expect(normalizePhone("0991234567")).toBe("0991234567");
  });

  it("maps +9639... to the local 09... form", () => {
    expect(normalizePhone("+963991234567")).toBe("0991234567");
  });

  it("maps 009639... to the local 09... form", () => {
    expect(normalizePhone("00963991234567")).toBe("0991234567");
  });

  it("maps a bare 9639... to the local 09... form", () => {
    expect(normalizePhone("963991234567")).toBe("0991234567");
  });

  it("strips spaces, dashes and parentheses", () => {
    expect(normalizePhone("099-123 45(67)")).toBe("0991234567");
  });

  it("folds Arabic-Indic digits to ASCII", () => {
    // ٠٩٩١٢٣٤٥٦٧
    expect(normalizePhone("٠٩٩١٢٣٤٥٦٧")).toBe("0991234567");
  });

  it("folds Extended Arabic-Indic (Persian) digits too", () => {
    // ۰۹۹۱۲۳۴۵۶۷
    expect(normalizePhone("۰۹۹۱۲۳۴۵۶۷")).toBe("0991234567");
  });

  it("treats a bare 9XXXXXXXX (missing leading 0) as local", () => {
    expect(normalizePhone("991234567")).toBe("0991234567");
  });

  it("accepts the common '+963 (0) 9XX' spelling with a redundant local zero", () => {
    expect(normalizePhone("+963 (0) 944 123 456")).toBe("0944123456");
    expect(normalizePhone("00963 0944123456")).toBe("0944123456");
    expect(normalizePhone("963 0944123456")).toBe("0944123456");
  });

  it("rejects a malformed country-code form (963 followed by a full 10-digit local number, no separator zero handling)", () => {
    // 0963944123456 is neither local (too long) nor a valid international form.
    expect(normalizePhone("0963944123456")).toBeNull();
  });

  it("returns null for null/undefined/empty", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
  });

  it("returns null for implausible digit counts", () => {
    expect(normalizePhone("09912")).toBeNull(); // too short
    expect(normalizePhone("099123456789")).toBeNull(); // too long
    expect(normalizePhone("+1 555 0100")).toBeNull(); // not Syrian
    expect(normalizePhone("abcdefghij")).toBeNull();
  });

  it("does not accept landlines (documented owner decision: mobile only)", () => {
    expect(normalizePhone("0111234567")).toBeNull();
    expect(normalizePhone("011 1234567")).toBeNull();
    expect(normalizePhone("+963 11 1234567")).toBeNull();
    expect(normalizePhone("00963111234567")).toBeNull();
  });
});

describe("toWhatsAppNumber", () => {
  it("produces the same 9639XXXXXXXX for every spelling", () => {
    const forms = [
      "0991234567",
      "+963991234567",
      "00963991234567",
      "963991234567",
      "099-123-4567",
      "٠٩٩١٢٣٤٥٦٧",
      "991234567",
      "+963 (0) 991 234 567",
    ];
    for (const f of forms) {
      expect(toWhatsAppNumber(f)).toBe("963991234567");
    }
  });

  it("returns null for an implausible number", () => {
    expect(toWhatsAppNumber("09912")).toBeNull();
    expect(toWhatsAppNumber("0963991234567")).toBeNull();
  });

  it("returns null for a landline", () => {
    expect(toWhatsAppNumber("011 1234567")).toBeNull();
  });

  it("returns null when the input is null/undefined/not a phone", () => {
    expect(toWhatsAppNumber(null)).toBeNull();
    expect(toWhatsAppNumber(undefined)).toBeNull();
    expect(toWhatsAppNumber("not a phone")).toBeNull();
  });
});