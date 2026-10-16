/**
 * lib/data/__tests__/t5c-orders-approval-helpers.test.ts
 *
 * T5c — pure helpers + validation unit tests, plus the STATIC source scans for
 * the approval gateway (no database). Mock-level tests cannot prove real
 * row-lock or database atomicity behaviour — see the gated real-database file.
 */
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { PaymentMethod } from "@prisma/client";
import {
    approveOrderBodySchema,
    approvalTotalSYP,
    approvalUnitPriceSYP,
    approvalUsdPreview,
    approvalRequestedBaseQty,
    approvalAvailableInLineUnit,
    assertApprovalLineSet,
    assertSufficientStock,
    resolveApprovalPayment,
    normalizeRate,
    PAYMENT_METHODS,
    ApprovalDomainError,
    ApprovalAlreadyReviewedError,
    ApprovalInsufficientStockError,
    ApprovalInvalidCustomerError,
    ApprovalInvalidPaymentError,
    ApprovalOrderNotFoundError,
    ApprovalProductInactiveError,
    ApprovalRateRequiredError,
    ApprovalValidationError,
    APPROVAL_TX_OPTIONS,
    type SufficiencyLineInput,
} from "@/lib/data/orders-approval";
import { truncateMoney } from "@/lib/utils/money";
import { ROLE_CAPABILITY_MATRIX, assertRolePermission, ForbiddenRoleError } from "@/lib/auth/role-matrix";

const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf-8");

/** Strips block and line comments so scans only see executable code. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "\n").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Extracts EVERY `<tx|db>.<model>.<method>( ... )` call with its full argument
 * block, using balanced parentheses (and skipping parentheses inside string
 * literals). Unlike an indexOf + fixed window, a SECOND identical call is
 * checked on its own block.
 */
function extractCalls(src: string): Array<{ client: string; model: string; method: string; block: string }> {
    const re = /\b(tx|db)\.([A-Za-z0-9_$]+)\.([A-Za-z_$]+)\s*\(/g;
    const out: Array<{ client: string; model: string; method: string; block: string }> = [];
    for (const m of src.matchAll(re)) {
        const open = (m.index ?? 0) + m[0].length - 1; // index of "("
        let depth = 0;
        let quote: string | null = null;
        let i = open;
        for (; i < src.length; i++) {
            const ch = src[i];
            if (quote) {
                if (ch === "\\") {
                    i++;
                    continue;
                }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === "`") {
                quote = ch;
                continue;
            }
            if (ch === "(") depth++;
            else if (ch === ")") {
                depth--;
                if (depth === 0) break;
            }
        }
        out.push({ client: m[1], model: m[2], method: m[3], block: src.slice(open, i + 1) });
    }
    return out;
}

function validBody(overrides: Record<string, unknown> = {}) {
    return {
        lines: [{ itemId: "item-1", approvedQuantity: "3" }],
        customer: { mode: "EXISTING", customerId: "cust-1" },
        payment: { mode: "FULL_CREDIT" },
        ...overrides,
    };
}

function lineInput(over: Partial<SufficiencyLineInput> = {}): SufficiencyLineInput {
    return {
        itemId: "l1",
        productId: "p1",
        productName: "سكر",
        unitId: "u",
        unitName: "طرد",
        approvedQuantity: "3",
        soldUnitFactor: "24",
        ...over,
    };
}

describe("T5c — request schema", () => {
    it("accepts a valid body", () => {
        expect(approveOrderBodySchema.safeParse(validBody()).success).toBe(true);
    });

    it("rejects bad quantities, empty lines, extra fields, bad NEW customer", () => {
        for (const qty of ["0", "-2", "abc", "1.12345", "10000.0001", ""]) {
            const r = approveOrderBodySchema.safeParse(validBody({ lines: [{ itemId: "i1", approvedQuantity: qty }] }));
            expect(r.success, JSON.stringify(qty)).toBe(false);
        }
        expect(approveOrderBodySchema.safeParse(validBody({ lines: [] })).success).toBe(false);
        expect(approveOrderBodySchema.safeParse(validBody({ extra: 1 })).success).toBe(false);
        expect(
            approveOrderBodySchema.safeParse(validBody({ customer: { mode: "NEW", name: "x", phone: "bad" } })).success
        ).toBe(false);
    });

    it("rejects approvedQuantity with Arabic digits, comma, sign, or exponent", () => {
        for (const qty of ["٣", "٣.٥", "1,5", "+5", "-5", "1e3", "1E3", "5.", ".5"]) {
            const r = approveOrderBodySchema.safeParse(validBody({ lines: [{ itemId: "i1", approvedQuantity: qty }] }));
            expect(r.success, `expected ${JSON.stringify(qty)} to be rejected`).toBe(false);
        }
        // Surrounding whitespace is trimmed (documented), so " 5 " is a valid "5".
        const padded = approveOrderBodySchema.safeParse(validBody({ lines: [{ itemId: "i1", approvedQuantity: " 5 " }] }));
        expect(padded.success).toBe(true);
        expect(padded.success && padded.data.lines[0].approvedQuantity).toBe("5");
    });

    it("rejects an extra field at any nesting level", () => {
        expect(
            approveOrderBodySchema.safeParse(validBody({ lines: [{ itemId: "i1", approvedQuantity: "3", sneaky: 1 }] })).success
        ).toBe(false);
        expect(
            approveOrderBodySchema.safeParse(validBody({ customer: { mode: "EXISTING", customerId: "c1", sneaky: 1 } })).success
        ).toBe(false);
        expect(
            approveOrderBodySchema.safeParse(validBody({ payment: { mode: "FULL_CREDIT", sneaky: 1 } })).success
        ).toBe(false);
        expect(
            approveOrderBodySchema.safeParse(validBody({ lines: [{ itemId: "i1", approvedQuantity: "3" }], sneaky: 1 })).success
        ).toBe(false);
    });
});

describe("T5c — error taxonomy", () => {
    it("EVERY typed approval error is an ApprovalDomainError; a plain Error is not", () => {
        const typed: unknown[] = [
            new ApprovalValidationError(),
            new ApprovalOrderNotFoundError(),
            new ApprovalAlreadyReviewedError(),
            new ApprovalProductInactiveError("i", "p"),
            new ApprovalInsufficientStockError([]),
            new ApprovalRateRequiredError(),
            new ApprovalInvalidCustomerError(),
            new ApprovalInvalidPaymentError(),
        ];
        for (const e of typed) expect(e).toBeInstanceOf(ApprovalDomainError);
        expect(new Error("plain")).not.toBeInstanceOf(ApprovalDomainError);
    });

    it("the route decides 'never retry' through the ONE base class, not a hand-kept list", () => {
        const src = stripComments(read("app/api/orders/[id]/approve/route.ts"));
        const fn = src.match(/function isApprovalFatal[\s\S]*?\n}/);
        expect(fn).not.toBeNull();
        expect(fn![0]).toContain("ApprovalDomainError");
        expect(fn![0]).not.toMatch(/Approval(Insufficient|Validation|AlreadyReviewed|NotFound|ProductInactive|RateRequired|InvalidCustomer|InvalidPayment)/);
    });
});

describe("T5c — line set and prices", () => {
    it("requires exactly the order item ids", () => {
        expect(() => assertApprovalLineSet(["a", "b"], ["a", "b"])).not.toThrow();
        expect(() => assertApprovalLineSet(["a", "a"], ["a", "b"])).toThrow(ApprovalValidationError);
        expect(() => assertApprovalLineSet(["a"], ["a", "b"])).toThrow(ApprovalValidationError);
        expect(() => assertApprovalLineSet(["a", "zzz"], ["a", "b"])).toThrow(ApprovalValidationError);
    });

    it("SYP needs no rate; USD converts once; total sums rows", () => {
        expect(approvalUnitPriceSYP({ priceWholesaleSnapshot: "5000", pricingCurrencySnapshot: "SYP" }, null)).toBe("5000.0000");
        expect(approvalUnitPriceSYP({ priceWholesaleSnapshot: "2", pricingCurrencySnapshot: "USD" }, "15000")).toBe("30000.0000");
        expect(() => approvalUnitPriceSYP({ priceWholesaleSnapshot: "2", pricingCurrencySnapshot: "USD" }, null)).toThrow(
            ApprovalRateRequiredError
        );
        const { totalSYP } = approvalTotalSYP(
            [
                { itemId: "l1", approvedQuantity: "3", priceWholesaleSnapshot: "100", pricingCurrencySnapshot: "SYP" },
                { itemId: "l2", approvedQuantity: "2", priceWholesaleSnapshot: "1", pricingCurrencySnapshot: "USD" },
            ],
            "15000"
        );
        expect(totalSYP).toBe("30300.0000");
        expect(approvalUsdPreview("30000", null)).toBeNull();
        expect(approvalUsdPreview("30000", "15000")).toBe("2.0000");
        expect(approvalUsdPreview("30000", " 15000 ")).toBe("2.0000");
        expect(approvalUsdPreview("30000", "   ")).toBeNull();
    });

    // invoice.totalSYP is the PER-ORDER-LINE figure (T4c computes it over the
    // un-split cart lines). This pure test only pins the arithmetic; the real
    // split-line behaviour (two FIFO rows, one per-line total) is proven in
    // t5c-orders-approval.test.ts ("FIFO spanning two batches").
    it("totalSYP is quantity x unit price per ORDER line", () => {
        const lines = [
            { itemId: "l1", approvedQuantity: "24", priceWholesaleSnapshot: "1000", pricingCurrencySnapshot: "SYP" as const },
        ];
        const { totalSYP, unitPricesSYP } = approvalTotalSYP(lines, null);
        expect(unitPricesSYP.get("l1")).toBe("1000.0000");
        expect(totalSYP).toBe("24000.0000");
    });
});

describe("T5c — payment validation (T4b parity)", () => {
    it("three modes plus ledger equation and method rules", () => {
        const cash = resolveApprovalPayment("100.0000", { mode: "FULL_CASH", paymentMethod: "CASH" });
        expect(cash).toMatchObject({ paidAmountSYP: "100.0000", debtAmountSYP: "0.0000" });
        const credit = resolveApprovalPayment("100.0000", { mode: "FULL_CREDIT", paymentMethod: "CASH" });
        expect(credit).toMatchObject({ paidAmountSYP: "0.0000", debtAmountSYP: "100.0000", paymentMethod: undefined });
        const part = resolveApprovalPayment("100.0000", { mode: "PARTIAL", paidAmountSYP: "30", paymentMethod: "CASH" });
        expect(part).toMatchObject({ paidAmountSYP: "30.0000", debtAmountSYP: "70.0000" });
        expect(() => resolveApprovalPayment("100.0000", { mode: "PARTIAL", paidAmountSYP: "0", paymentMethod: "CASH" })).toThrow(
            ApprovalInvalidPaymentError
        );
        expect(() => resolveApprovalPayment("100.0000", { mode: "PARTIAL", paidAmountSYP: "100", paymentMethod: "CASH" })).toThrow(
            ApprovalInvalidPaymentError
        );
        expect(() => resolveApprovalPayment("100.0000", { mode: "PARTIAL", paidAmountSYP: "10" })).toThrow(ApprovalInvalidPaymentError);
        expect(() => resolveApprovalPayment("100.0000", { mode: "FULL_CASH" })).toThrow(ApprovalInvalidPaymentError);
    });

    it("PAYMENT_METHODS equals Object.values(PaymentMethod) as a set", () => {
        expect([...PAYMENT_METHODS].sort()).toEqual(Object.values(PaymentMethod).sort());
        expect(PAYMENT_METHODS).toHaveLength(Object.values(PaymentMethod).length);
    });

    it("normalizeRate collapses invalid/absent rates to null, keeps positive ones", () => {
        expect(normalizeRate("15000")).toBe("15000.0000");
        expect(normalizeRate(" 15000.5 ")).toBe("15000.5000");
        for (const bad of ["0", "-1", "garbage", "", "   ", null, undefined]) {
            expect(normalizeRate(bad), String(bad)).toBeNull();
        }
    });
});

describe("T5c — conversion (the sold unit's factor is the ONLY source)", () => {
    it("3 packs (factor 24) -> requestedBaseQty 72", () => {
        expect(approvalRequestedBaseQty("3", "24")).toBe("72.0000");
    });

    it("a quantity that converts to zero base units is a validation error, never silently priced", () => {
        expect(() => approvalRequestedBaseQty("0.0001", "0.0001")).toThrow(ApprovalValidationError);
        expect(() => approvalRequestedBaseQty("0.0001", "0.0001", "سكر")).toThrow(/سكر/);
    });

    it("non-integer factor 0.3333 does not reject at the exact boundary", () => {
        expect(approvalRequestedBaseQty("3", "0.3333")).toBe("0.9999");
        const lines = [lineInput({ unitName: "علبة", soldUnitFactor: "0.3333" })];
        expect(() => assertSufficientStock(lines, new Map([["p1", ["0.9999"]]]))).not.toThrow();
        // With the sold factor 0.9999 <= 2.0000; factor 1 would request 3.0000 and fail here.
        expect(() => assertSufficientStock(lines, new Map([["p1", ["2.0000"]]]))).not.toThrow();
        expect(() => assertSufficientStock(lines, new Map([["p1", ["0.9998"]]]))).toThrow(ApprovalInsufficientStockError);
    });
});

describe("T5c — availability truncates (never rounds up)", () => {
    it("truncateMoney truncates toward zero to 4 dp using Decimal.ROUND_DOWN", () => {
        expect(truncateMoney("2.91666")).toBe("2.9166");
        expect(truncateMoney("2.91669")).toBe("2.9166");
        expect(truncateMoney("1.66666")).toBe("1.6666");
        expect(truncateMoney("1.66669")).toBe("1.6666");
        expect(truncateMoney("14.285714")).toBe("14.2857");
        expect(truncateMoney("14.28579")).toBe("14.2857");
        expect(approvalAvailableInLineUnit("70.0000", "24")).toBe("2.9166");
        expect(approvalAvailableInLineUnit("100.0000", "7")).toBe("14.2857");
        expect(approvalAvailableInLineUnit("5.0000", "3")).toBe("1.6666");
    });

    it("the shown available figure, retyped, passes the sufficiency check", () => {
        const shown = approvalAvailableInLineUnit("70.0000", "24");
        expect(shown).toBe("2.9166");
        const lines = [lineInput({ approvedQuantity: shown })];
        expect(() => assertSufficientStock(lines, new Map([["p1", ["70.0000"]]]))).not.toThrow();
    });
});

describe("T5c — sufficiency", () => {
    const stockKeys = ["available", "itemId", "productName", "unitName"];

    it("checks per product across units; negatives are 0; available is per line unit", () => {
        const lines = [
            lineInput({ itemId: "l1", unitId: "u-pack", unitName: "طرد", approvedQuantity: "3", soldUnitFactor: "24" }),
            lineInput({ itemId: "l2", unitId: "u-pc", unitName: "قطعة", approvedQuantity: "4", soldUnitFactor: "1" }),
        ];
        expect(() => assertSufficientStock(lines, new Map([["p1", ["70.0000", "-5.0000"]]]))).toThrow(
            ApprovalInsufficientStockError
        );
        let err: ApprovalInsufficientStockError | undefined;
        try {
            assertSufficientStock(lines, new Map([["p1", ["70.0000", "-5.0000"]]]));
        } catch (e) {
            err = e as ApprovalInsufficientStockError;
        }
        expect(err).toBeInstanceOf(ApprovalInsufficientStockError);
        expect(err!.lines).toHaveLength(2);
        expect(err!.lines.find((l) => l.itemId === "l1")?.available).toBe("2.9166");
        expect(err!.lines.find((l) => l.itemId === "l2")?.available).toBe("70.0000");
        expect(JSON.stringify(err!.lines)).not.toMatch(/batch/i);
        expect(() => assertSufficientStock(lines, new Map([["p1", ["76.0000"]]]))).not.toThrow();
    });

    it("two lines of ONE product, each fitting alone but not together, lists BOTH lines", () => {
        const lines = [
            lineInput({ itemId: "l1", unitId: "u-pack", approvedQuantity: "2", soldUnitFactor: "10" }),
            lineInput({ itemId: "l2", unitId: "u-pc", unitName: "قطعة", approvedQuantity: "15", soldUnitFactor: "1" }),
        ];
        expect(() => assertSufficientStock([lines[0]], new Map([["p1", ["30.0000"]]]))).not.toThrow();
        expect(() => assertSufficientStock([lines[1]], new Map([["p1", ["30.0000"]]]))).not.toThrow();
        let err: ApprovalInsufficientStockError | undefined;
        try {
            assertSufficientStock(lines, new Map([["p1", ["30.0000"]]]));
        } catch (e) {
            err = e as ApprovalInsufficientStockError;
        }
        expect(err).toBeInstanceOf(ApprovalInsufficientStockError);
        expect(err!.lines.map((l) => l.itemId).sort()).toEqual(["l1", "l2"]);
    });

    it("INSUFFICIENT_STOCK entries have EXACTLY the same four keys on BOTH paths", () => {
        const lines = [lineInput()];
        let pre: ApprovalInsufficientStockError | undefined;
        try {
            assertSufficientStock(lines, new Map([["p1", ["10.0000"]]]));
        } catch (e) {
            pre = e as ApprovalInsufficientStockError;
        }
        const post = ApprovalInsufficientStockError.fromSufficiencyLines(lines, new Map([["p1", ["10.0000"]]]));
        for (const err of [pre!, post]) {
            expect(err.lines).toHaveLength(1);
            expect(Object.keys(err.lines[0]).sort()).toEqual(stockKeys);
        }
        expect(pre!.lines[0]).toEqual(post.lines[0]);
    });
});

describe("T5c — roles and envelope", () => {
    it("orders:approve is ADMIN-only; TX envelope matches T4c", () => {
        expect(ROLE_CAPABILITY_MATRIX["orders:approve"]).toEqual({ ADMIN: true, CASHIER: false });
        expect(() => assertRolePermission("ADMIN", "orders:approve")).not.toThrow();
        expect(() => assertRolePermission("CASHIER", "orders:approve")).toThrow(ForbiddenRoleError);
        expect(APPROVAL_TX_OPTIONS).toEqual({ maxWait: 10_000, timeout: 20_000 });
    });
});

describe("T5c — static scans of the approval gateway", () => {
    const txSrc = () => stripComments(read("lib/data/orders-approval-tx.ts"));

    it("the scanner itself works: it flags a call that lacks tenantId and counts nested calls", () => {
        const flagged = extractCalls("await tx.invoice.create({ data: { totalSYP, nested: fn(1) } });");
        expect(flagged).toHaveLength(1);
        expect(flagged[0].block).toContain("nested: fn(1)");
        expect(flagged[0].block).not.toMatch(/tenantId/);
        // Two identical calls are BOTH inspected (an indexOf-based scan would only see the first).
        const two = extractCalls(
            "tx.invoice.create({ data: { tenantId } }); tx.invoice.create({ data: { totalSYP } });"
        );
        expect(two).toHaveLength(2);
        expect(two[0].block).toMatch(/tenantId/);
        expect(two[1].block).not.toMatch(/tenantId/);
    });

    it("EVERY tx./db. model call carries tenantId (verifiedRetailer is the only exception)", () => {
        const calls = extractCalls(txSrc());
        expect(calls.some((c) => c.model === "b2BOrderRequest")).toBe(true);
        expect(calls.some((c) => c.model === "b2BOrderRequestItem")).toBe(true);
        expect(calls.some((c) => c.model === "invoice")).toBe(true);
        expect(calls.some((c) => c.model === "invoiceItem")).toBe(true);
        expect(calls.some((c) => c.model === "customerPayment")).toBe(true);
        expect(calls.some((c) => c.model === "verifiedRetailer")).toBe(true);
        for (const c of calls) {
            if (c.model === "verifiedRetailer") continue; // platform-wide, no tenantId column
            expect(c.block, `${c.client}.${c.model}.${c.method}(...) must carry tenantId`).toMatch(/tenantId/);
        }
        // The only calls WITHOUT tenantId are verifiedRetailer.*
        expect(calls.filter((c) => c.model === "verifiedRetailer").length).toBeGreaterThanOrEqual(1);
    });

    it("no nested writes (create/connect/update/set/disconnect keys) inside non-upsert writes", () => {
        const writes = extractCalls(txSrc()).filter((c) =>
            ["create", "update", "updateMany", "delete", "deleteMany"].includes(c.method)
        );
        expect(writes.length).toBeGreaterThan(0);
        for (const c of writes) {
            expect(c.block, `${c.model}.${c.method}`).not.toMatch(/\b(create|connect|connectOrCreate|update|upsert|set|disconnect)\s*:\s*\{/);
        }
    });

    it("the order item update writes ONLY approvedQuantity", () => {
        const itemUpdates = extractCalls(txSrc()).filter((c) => c.model === "b2BOrderRequestItem" && c.method === "update");
        expect(itemUpdates).toHaveLength(1);
        expect(itemUpdates[0].block).toMatch(/data:\s*\{\s*approvedQuantity:/);
        expect(itemUpdates[0].block).not.toMatch(/\bquantity\s*:/);
        expect(itemUpdates[0].block).not.toMatch(/priceWholesaleSnapshot|pricingCurrencySnapshot/);
    });

    it("never touches product/productUnit/tenant writes, raw queries, factors or an overdraw policy", () => {
        const src = txSrc();
        expect(src).not.toMatch(/tx\.(product|productUnit|tenant)\.(create|update|updateMany|upsert|delete|deleteMany)/);
        expect(src).not.toMatch(/\$queryRaw/);
        expect(src).not.toMatch(/conversionFactor/);
        expect(src).not.toMatch(/previewFifoAllocation/);
        expect(src).not.toMatch(/overdraw/i);
    });

    it("commitFifoAllocation always receives the live tx, and the claim comes before any lock", () => {
        const src = txSrc();
        expect(src).toMatch(/commitFifoAllocation\(\s*tx\s*,/);
        expect(src.indexOf("updateMany(")).toBeGreaterThan(-1);
        expect(src.indexOf("updateMany(")).toBeLessThan(src.indexOf("lockBatchesForFifoAllocations(tx"));
    });

    it("the pure-helper module has no raw queries, factor access or trust labels", () => {
        const src = read("lib/data/orders-approval.ts");
        expect(src).not.toMatch(/\$queryRaw/);
        expect(src).not.toMatch(/conversionFactor/);
        expect(src).not.toMatch(/موثوق|موثّق/);
    });
});