import { describe, it, expect } from "vitest";
import { orderReference, randomReference } from "@/lib/utils/order-reference";

/**
 * T5a - the display reference of a B2B order. Display-only; never a key.
 */
describe("orderReference", () => {
  it("is the last 6 characters of the id, upper-cased", () => {
    expect(orderReference("clxabc123DEF")).toBe("123DEF");
    expect(orderReference("abcdef123456")).toBe("123456");
  });

  it("upper-cases lowercase ids", () => {
    expect(orderReference("orderabcd")).toBe("ERABCD");
  });

  it("returns the whole (short) id when it has fewer than 6 chars", () => {
    expect(orderReference("ab")).toBe("AB");
  });
});

describe("randomReference", () => {
  it("returns 6 characters by default", () => {
    expect(randomReference()).toHaveLength(6);
  });

  it("honours a custom length", () => {
    expect(randomReference(10)).toHaveLength(10);
  });

  it("uses the same [0-9A-Z] alphabet a real reference (upper-cased cuid) can contain", () => {
    const ref = randomReference(500);
    expect(ref).toMatch(/^[0-9A-Z]+$/);
  });

  it("is NOT restricted to a confusable-free alphabet (fake refs must not be detectable)", () => {
    // Over 5000 draws every one of 0/1/O/I must appear at least once.
    const sample = randomReference(5000);
    for (const ch of ["0", "1", "O", "I"]) {
      expect(sample.includes(ch)).toBe(true);
    }
  });
});