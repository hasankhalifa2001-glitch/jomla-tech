/**
 * lib/store/__tests__/storefront-cart.test.ts
 *
 * T5a â€” the storefront cart's PURE logic (Â§6.7), exercised with a plain
 * in-memory Storage fake. No React, no jsdom, no window: every rule in
 * lib/store/storefront-cart.ts is reachable from the node vitest environment.
 *
 * What is pinned here:
 *   1. Quantity validation â€” > 0, â‰¤ 4 dp, â‰¤ STORE_MAX_QTY_PER_LINE (D6).
 *   2. One line per (product, unit) pair; a second tap SUMS and is re-capped.
 *   3. The per-order line cap (STORE_MAX_LINES_PER_ORDER).
 *   4. Per-currency totals â€” SYP and USD summed SEPARATELY, never converted
 *      into one another (Â§6.7). This is the single most important cart rule: a
 *      silent merge would misrepresent a mixed-currency order.
 *   5. localStorage keys are namespaced BY TENANT SLUG, so two stores in one
 *      browser can never see each other's cart.
 *   6. Every read is RE-VALIDATED and every access is try/catch-safe: a
 *      throwing/hostile storage degrades to "empty" instead of breaking the
 *      storefront, and a hand-edited value cannot smuggle an invalid line.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
    addCartLine,
    cartTotalsByCurrency,
    checkQuantity,
    clearCart,
    lineKey,
    loadCart,
    loadLastOrder,
    loadRetailerDetails,
    removeCartLine,
    saveCart,
    saveLastOrder,
    saveRetailerDetails,
    setCartLineQuantity,
    cartStorageKey,
    retailerStorageKey,
    lastOrderStorageKey,
    type CartLine,
    type StorageLike,
} from "@/lib/store/storefront-cart";
import {
    STORE_MAX_LINES_PER_ORDER,
    STORE_MAX_QTY_PER_LINE,
} from "@/lib/config/storefront";

/** A minimal in-memory Storage; every method can be made to throw per-test. */
function makeStorage(): StorageLike & {
    data: Map<string, string>;
    throws: boolean;
} {
    const data = new Map<string, string>();
    return {
        data,
        throws: false,
        getItem(key: string) {
            if (this.throws) throw new Error("blocked");
            return data.has(key) ? data.get(key)! : null;
        },
        setItem(key: string, value: string) {
            if (this.throws) throw new Error("quota");
            data.set(key, value);
        },
        removeItem(key: string) {
            if (this.throws) throw new Error("blocked");
            data.delete(key);
        },
    };
}

function line(overrides: Partial<CartLine> = {}): CartLine {
    return {
        productId: "prod-1",
        unitId: "unit-piece",
        quantity: "1",
        productName: "مدار",
        unitName: "قطعة",
        priceWholesale: "5000",
        pricingCurrency: "SYP",
        imageUrl: null,
        ...overrides,
    };
}

describe("checkQuantity (§6.7 / D6)", () => {
    it("accepts a positive decimal with up to 4 places", () => {
        expect(checkQuantity("1").ok).toBe(true);
        expect(checkQuantity("12.5").ok).toBe(true);
        expect(checkQuantity("0.0001").ok).toBe(true);
    });

    it("rejects zero, negatives, blanks and junk", () => {
        expect(checkQuantity("0").ok).toBe(false);
        expect(checkQuantity("-5").ok).toBe(false);
        expect(checkQuantity("").ok).toBe(false);
        expect(checkQuantity("abc").ok).toBe(false);
        expect(checkQuantity("1e3").ok).toBe(false);
    });

    it("rejects more than 4 decimal places (the column is DECIMAL(18,4))", () => {
        expect(checkQuantity("1.00005").ok).toBe(false);
    });

    it("accepts exactly the cap and rejects one unit above it", () => {
        expect(checkQuantity(STORE_MAX_QTY_PER_LINE).ok).toBe(true);
        expect(checkQuantity(`${STORE_MAX_QTY_PER_LINE}.0001`).ok).toBe(false);
    });

    it("compares huge values exactly (no float precision loss)", () => {
        expect(checkQuantity("9007199254740993").ok).toBe(false);
    });
});

describe("addCartLine (§6.7)", () => {
    it("adds a new line", () => {
        const result = addCartLine([], line({ quantity: "3" }));
        expect(result.ok).toBe(true);
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].quantity).toBe("3.0000");
    });

    it("keeps ONE line per (product, unit) and SUMS a repeat tap", () => {
        let lines = addCartLine([], line({ quantity: "2" })).lines;
        lines = addCartLine(lines, line({ quantity: "3" })).lines;
        expect(lines).toHaveLength(1);
        expect(lines[0].quantity).toBe("5.0000");
    });

    it("re-caps the SUM, so two taps cannot exceed the per-line limit", () => {
        const lines = addCartLine([], line({ quantity: STORE_MAX_QTY_PER_LINE })).lines;
        const result = addCartLine(lines, line({ quantity: "1" }));
        expect(result.ok).toBe(false);
        expect(result.lines[0].quantity).toBe("10000.0000");
    });

    it("treats a different UNIT of the same product as its own line", () => {
        let lines = addCartLine([], line({ unitId: "unit-piece" })).lines;
        lines = addCartLine(lines, line({ unitId: "unit-carton" })).lines;
        expect(lines).toHaveLength(2);
    });

    it("enforces the per-order line cap (D6)", () => {
        let lines: CartLine[] = [];
        for (let i = 0; i < STORE_MAX_LINES_PER_ORDER; i++) {
            lines = addCartLine(lines, line({ productId: `p-${i}` })).lines;
        }
        expect(lines).toHaveLength(STORE_MAX_LINES_PER_ORDER);
        const result = addCartLine(lines, line({ productId: "one-too-many" }));
        expect(result.ok).toBe(false);
        expect(result.lines).toHaveLength(STORE_MAX_LINES_PER_ORDER);
    });
});

describe("setCartLineQuantity / removeCartLine (§6.7)", () => {
    it("replaces a quantity", () => {
        const lines = addCartLine([], line({ quantity: "2" })).lines;
        const result = setCartLineQuantity(lines, "prod-1", "unit-piece", "7.25");
        expect(result.lines[0].quantity).toBe("7.2500");
    });

    it("removes the line when the new quantity is invalid (an emptied box)", () => {
        const lines = addCartLine([], line()).lines;
        const result = setCartLineQuantity(lines, "prod-1", "unit-piece", "");
        expect(result.lines).toHaveLength(0);
    });

    it("removes one line without touching the others", () => {
        let lines = addCartLine([], line({ unitId: "unit-piece" })).lines;
        lines = addCartLine(lines, line({ unitId: "unit-carton" })).lines;
        const result = removeCartLine(lines, "prod-1", "unit-piece");
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].unitId).toBe("unit-carton");
    });
});



describe("cartTotalsByCurrency (§6.7) — currencies are NEVER merged", () => {
    it("sums SYP and USD independently", () => {
        const lines = [
            line({ productId: "a", priceWholesale: "5000", quantity: "2" }),
            line({ productId: "b", priceWholesale: "2500.5", quantity: "4" }),
            line({
                productId: "c",
                unitId: "unit-box",
                priceWholesale: "3.25",
                quantity: "2",
                pricingCurrency: "USD",
            }),
        ];
        const totals = cartTotalsByCurrency(lines);
        // 5000×2 = 10000, 2500.5×4 = 10002 → 20002.0000 exactly (decimal.js).
        expect(totals.SYP).toBe("20002.0000");
        expect(totals.hasSYP).toBe(true);
        expect(totals.USD).toBe("6.5000");
        expect(totals.hasUSD).toBe(true);
    });

    it("reports an absent currency as has*: false so the UI can omit it", () => {
        const totals = cartTotalsByCurrency([line()]);
        expect(totals.hasSYP).toBe(true);
        expect(totals.hasUSD).toBe(false);
        expect(totals.USD).toBe("0.0000");
    });

    it("is empty for an empty cart", () => {
        const totals = cartTotalsByCurrency([]);
        expect(totals.hasSYP).toBe(false);
        expect(totals.hasUSD).toBe(false);
    });
});

describe("storage keys are namespaced by tenant slug (§6.7)", () => {
    it("produces distinct keys per slug for all three stores", () => {
        expect(cartStorageKey("acme")).not.toBe(cartStorageKey("other"));
        expect(retailerStorageKey("acme")).not.toBe(retailerStorageKey("other"));
        expect(lastOrderStorageKey("acme")).not.toBe(lastOrderStorageKey("other"));
    });
});


describe("cart persistence (§6.7)", () => {
    let storage: ReturnType<typeof makeStorage>;

    beforeEach(() => {
        storage = makeStorage();
    });

    it("round-trips the cart", () => {
        const lines = addCartLine([], line({ quantity: "3" })).lines;
        saveCart("acme", lines, storage);
        expect(loadCart("acme", storage)).toHaveLength(1);
        expect(loadCart("acme", storage)[0].quantity).toBe("3.0000");
    });

    it("returns [] when nothing is stored", () => {
        expect(loadCart("acme", storage)).toEqual([]);
    });

    it("degrades to [] when storage THROWS (private mode / quota)", () => {
        storage.throws = true;
        saveCart("acme", [line()], storage);
        expect(loadCart("acme", storage)).toEqual([]);
        expect(() => clearCart("acme", storage)).not.toThrow();
    });

    it("never lets tenant A's cart be read as tenant B's", () => {
        saveCart("acme", [line()], storage);
        expect(loadCart("other", storage)).toEqual([]);
    });

    it("drops a hand-edited line with an invalid quantity", () => {
        storage.data.set(
            cartStorageKey("acme"),
            JSON.stringify([{ ...line(), quantity: "-5" }])
        );
        expect(loadCart("acme", storage)).toEqual([]);
    });

    it("drops a line with an unknown pricing currency", () => {
        storage.data.set(
            cartStorageKey("acme"),
            JSON.stringify([{ ...line(), pricingCurrency: "EUR" }])
        );
        expect(loadCart("acme", storage)).toEqual([]);
    });

    it("drops a malformed (non-array) stored value", () => {
        storage.data.set(cartStorageKey("acme"), JSON.stringify({ nope: true }));
        expect(loadCart("acme", storage)).toEqual([]);
    });

    it("truncates a hand-edited cart to the per-order line cap on the way IN", () => {
        const many = Array.from(
            { length: STORE_MAX_LINES_PER_ORDER + 25 },
            (_, i) => line({ productId: `p-${i}` })
        );
        storage.data.set(cartStorageKey("acme"), JSON.stringify(many));
        expect(loadCart("acme", storage)).toHaveLength(STORE_MAX_LINES_PER_ORDER);
    });
});


describe("remembered retailer details (D3/D4)", () => {
    it("round-trips the details", () => {
        const storage = makeStorage();
        saveRetailerDetails(
            "acme",
            { name: "أبو خالد", phone: "0944123456", shopName: "بقالة أبو خالد" },
            storage
        );
        expect(loadRetailerDetails("acme", storage)).toEqual({
            name: "أبو خالد",
            phone: "0944123456",
            shopName: "بقالة أبو خالد",
        });
    });

    it("returns null when a required field is missing", () => {
        const storage = makeStorage();
        saveRetailerDetails("acme", { name: "", phone: "", shopName: "" }, storage);
        expect(loadRetailerDetails("acme", storage)).toBeNull();
    });

    it("clearing the prefill is what the \"مو أنا / تغيير\" control does (D4)", () => {
        const storage = makeStorage();
        saveRetailerDetails(
            "acme",
            { name: "أبو خالد", phone: "0944123456", shopName: "" },
            storage
        );
        saveRetailerDetails("acme", { name: "", phone: "", shopName: "" }, storage);
        expect(loadRetailerDetails("acme", storage)).toBeNull();
    });
});

describe("last submitted order (§6.7 — \"أعد طلبي الأخير\")", () => {
    it("round-trips only the identifiers needed to re-add the lines", () => {
        const storage = makeStorage();
        saveLastOrder(
            "acme",
            {
                orderRef: "AB12CD",
                lines: [{ productId: "prod-1", unitId: "unit-piece", quantity: "3" }],
            },
            storage
        );
        const loaded = loadLastOrder("acme", storage);
        expect(loaded?.orderRef).toBe("AB12CD");
        expect(loaded?.lines).toHaveLength(1);
        expect(loaded?.lines[0].quantity).toBe("3.0000");
        const raw = storage.data.get(lastOrderStorageKey("acme"))!;
        expect(raw).not.toContain("priceWholesale");
        expect(raw).not.toContain("retailerPhone");
    });

    it("returns null when every stored line is invalid", () => {
        const storage = makeStorage();
        saveLastOrder(
            "acme",
            { orderRef: "X", lines: [{ productId: "p", unitId: "u", quantity: "0" }] },
            storage
        );
        expect(loadLastOrder("acme", storage)).toBeNull();
    });
});

describe("lineKey", () => {
    it("is the (product, unit) identity used for de-duplication", () => {
        expect(lineKey("p", "u")).toBe("p|u");
        expect(lineKey("p", "u")).not.toBe(lineKey("p", "v"));
    });
});

