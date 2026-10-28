/**
 * The UI helpers working TOGETHER with the real cart funnel in
 * lib/offline/pos-service.ts: typing an amount, switching mode, quick buttons.
 * Covers the mode/pair invariants of D8-D10 that no DOM test can reach.
 */
import { describe, expect, it } from "vitest";
import {
    applyLineAmountOverride,
    calculateCartTotals,
    clearLineOverride,
    setLineQuantity,
    type CartLineItem,
} from "@/lib/offline/pos-service";
import {
    QUICK_WEIGHT_BUTTONS,
    describeAmountLine,
    lineMode,
    parseAmountInput,
} from "@/lib/pos/by-amount-ui";

function kgLine(overrides: Partial<CartLineItem> = {}): CartLineItem {
    return {
        id: "l1",
        product: { id: "prod-rice", tenantId: "t1", name: "رز", units: [], batches: [] },
        unitId: "unit-kg",
        unitName: "كغ",
        conversionFactor: "1",
        quantity: 1,
        unitPriceSYP: "15000.0000",
        unitPriceUSD: null,
        pricingCurrency: "SYP",
        ...overrides,
    };
}

function typed(items: CartLineItem[], text: string): CartLineItem[] {
    const amount = parseAmountInput(text);
    if (amount === null) throw new Error("unparseable in test");
    return applyLineAmountOverride(items, "l1", amount);
}

describe("typing an amount (parse -> funnel)", () => {
    it("5000 on a 15,000/kg line gives 0.3333 kg and a 5,000 total", () => {
        const items = typed([kgLine()], "5000");
        expect(items[0].quantity).toBe(0.3333);
        expect(items[0].lineTotalOverrideSYP).toBe("5000.0000");
        expect(lineMode(items[0])).toBe("amount");
        expect(describeAmountLine(items[0])).toEqual({
            amountSYP: "5000.0000",
            quantityText: "0.3333",
            unitName: "كغ",
        });
        expect(calculateCartTotals(items, null).totalSYP).toBe("5000.0000");
    });

    it("Arabic-Indic digits and separators give the identical line", () => {
        const ascii = typed([kgLine()], "5000");
        expect(typed([kgLine()], "٥٬٠٠٠")).toEqual(ascii);
        expect(typed([kgLine()], "5,000")).toEqual(ascii);
    });

    it("changing the amount re-derives the quantity live", () => {
        let items = typed([kgLine()], "5000");
        items = typed(items, "7500");
        expect(items[0].quantity).toBe(0.5);
        expect(items[0].lineTotalOverrideSYP).toBe("7500.0000");
        expect(calculateCartTotals(items, null).totalSYP).toBe("7500.0000");
    });

    it("a rejected amount throws, leaves the previous line untouched and explains in Arabic", () => {
        const before = typed([kgLine()], "5000");
        const snapshot = JSON.stringify(before);

        expect(() => applyLineAmountOverride(before, "l1", "0")).toThrow(/أكبر من صفر/);
        expect(() => applyLineAmountOverride(before, "l1", "0.0001")).toThrow(/الكمية الدنيا/);

        // Pure: the cart the UI keeps showing is exactly what it was.
        expect(JSON.stringify(before)).toBe(snapshot);
        expect(calculateCartTotals(before, null).totalSYP).toBe("5000.0000");
    });
});

describe("switching back to بالكمية (D10)", () => {
    it("keeps quantity 0.3333, drops the override, and the total reverts to quantity x price", () => {
        const amountItems = typed([kgLine()], "5000");
        const quantityItems = clearLineOverride(amountItems, "l1");

        expect(quantityItems[0].quantity).toBe(0.3333);
        expect("lineTotalOverrideSYP" in quantityItems[0]).toBe(false);
        expect(lineMode(quantityItems[0])).toBe("quantity");
        expect(describeAmountLine(quantityItems[0])).toBeNull();
        expect(calculateCartTotals(quantityItems, null).totalSYP).toBe("4999.5000");
    });

    it("amount -> quantity -> amount round-trips to the same pair", () => {
        const first = typed([kgLine()], "5000");
        const back = clearLineOverride(first, "l1");
        const again = typed(back, "5000");
        expect(again).toEqual(first);
    });
});

describe("quick weight buttons exit amount mode (D7)", () => {
    const expectedTotals: Record<string, string> = {
        "0.25": "3750.0000",
        "0.5": "7500.0000",
        "1": "15000.0000",
    };

    for (const button of QUICK_WEIGHT_BUTTONS) {
        it(`${button.label} sets exactly ${button.quantity} and clears an existing override`, () => {
            const amountItems = typed([kgLine()], "5000");
            expect(lineMode(amountItems[0])).toBe("amount");

            const items = setLineQuantity(amountItems, "l1", button.quantity);

            expect(items[0].quantity).toBe(Number(button.quantity));
            expect("lineTotalOverrideSYP" in items[0]).toBe(false);
            expect(lineMode(items[0])).toBe("quantity");
            expect(calculateCartTotals(items, null).totalSYP).toBe(expectedTotals[button.quantity]);
        });
    }
});