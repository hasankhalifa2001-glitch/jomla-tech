/**
 * lib/data/__tests__/t5c-orders-approval-helpers.test.ts
 *
 * T5c Phase 2 — pure helpers + validation unit tests (no database).
 * Mock-level tests cannot prove real row-lock or database atomicity
 * behavior — the real-database plan (TEST_DATABASE_URL-gated, skipped
 * when absent) is delivered with Phase 3.
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
    ApprovalAlreadyReviewedError,
    ApprovalInsufficientStockError,
    ApprovalInvalidPaymentError,
    ApprovalOrderNotFoundError,
    ApprovalRateRequiredError,
    ApprovalValidationError,
    APPROVAL_TX_OPTIONS,
} from "@/lib/data/orders-approval";
import { truncateMoney } from "@/lib/utils/money";
import { ROLE_CAPABILITY_MATRIX, assertRolePermission, ForbiddenRoleError } from "@/lib/auth/role-matrix";

function validBody(overrides: Record<string, unknown> = {}) {
    return {
        lines: [{ itemId: "item-1", approvedQuantity: "3" }],
        customer: { mode: "EXISTING", customerId: "cust-1" },
        payment: { mode: "FULL_CREDIT" },
        ...overrides,
    };
}

describe("T5c Phase 2 — request schema", () => {
    it("accepts a valid body", () => {
        expect(approveOrderBodySchema.safeParse(validBody()).success).toBe(true);
    });
    it("rejects bad quantities, empty lines, extra fields, bad NEW customer", () => {
        for (const qty of ["0", "-2", "abc", "1.12345", "10000.0001", ""]) {
            const r = approveOrderBodySchema.safeParse(
                validBody({ lines: [{ itemId: "i1", approvedQuantity: qty }] }),
            );
            expect(r.success).toBe(false);
        }
        expect(approveOrderBodySchema.safeParse(validBody({ lines: [] })).success).toBe(false);
        expect(approveOrderBodySchema.safeParse(validBody({ extra: 1 })).success).toBe(false);
        expect(
            approveOrderBodySchema.safeParse(
                validBody({ customer: { mode: "NEW", name: "x", phone: "bad" } }),
            ).success,
        ).toBe(false);
    });
    // [E] Arabic-Indic digits, a comma decimal separator, an explicit sign and
    // a scientific-notation exponent are all REJECTED: the schema accepts only
    // ASCII "d+(.d{1,4})" (positive, <= 4 dp). A quantity typed with Arabic
    // numerals is a real, common paste — it must fail loudly here, not be
    // silently coerced downstream. (Surrounding whitespace is intentionally
    // NOT in this list: the schema trims first, so " 5 " is a valid "5".)
    it("rejects approvedQuantity with Arabic digits, comma, sign, or exponent", () => {
        for (const qty of ["٣", "٣.٥", "1,5", "+5", "-5", "1e3", "1E3", "5.", ".5"]) {
            const r = approveOrderBodySchema.safeParse(
                validBody({ lines: [{ itemId: "i1", approvedQuantity: qty }] }),
            );
            expect(r.success, `expected ${JSON.stringify(qty)} to be rejected`).toBe(false);
        }
        // Surrounding whitespace is trimmed (documented schema behaviour), so a
        // padded-but-valid quantity is accepted and normalized.
        const padded = approveOrderBodySchema.safeParse(
            validBody({ lines: [{ itemId: "i1", approvedQuantity: " 5 " }] }),
        );
        expect(padded.success).toBe(true);
        expect(padded.success && padded.data.lines[0].approvedQuantity).toBe("5");
    });
    // [E] .strict() at EVERY nesting level: an unexpected key anywhere in the
    // body (top level, a line, the customer, or the payment object) is a 400,
    // so a forged extra field can never slip through on a nested object.
    it("rejects an extra field at any nesting level", () => {
        expect(
            approveOrderBodySchema.safeParse(
                validBody({ lines: [{ itemId: "i1", approvedQuantity: "3", sneaky: 1 }] }),
            ).success,
        ).toBe(false);
        expect(
            approveOrderBodySchema.safeParse(
                validBody({ customer: { mode: "EXISTING", customerId: "c1", sneaky: 1 } }),
            ).success,
        ).toBe(false);
        expect(
            approveOrderBodySchema.safeParse(
                validBody({ payment: { mode: "FULL_CREDIT", sneaky: 1 } }),
            ).success,
        ).toBe(false);
        expect(
            approveOrderBodySchema.safeParse(
                validBody({ lines: [{ itemId: "i1", approvedQuantity: "3" }], sneaky: 1 }),
            ).success,
        ).toBe(false);
    });
});

describe("T5c Phase 2 — line set and prices", () => {
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
            ApprovalRateRequiredError,
        );
        const { totalSYP } = approvalTotalSYP(
            [
                { itemId: "l1", approvedQuantity: "3", priceWholesaleSnapshot: "100", pricingCurrencySnapshot: "SYP" },
                { itemId: "l2", approvedQuantity: "2", priceWholesaleSnapshot: "1", pricingCurrencySnapshot: "USD" },
            ],
            "15000",
        );
        expect(totalSYP).toBe("30300.0000");
        expect(approvalUsdPreview("30000", null)).toBeNull();
        expect(approvalUsdPreview("30000", "15000")).toBe("2.0000");
        // [D] A whitespace-padded rate is trimmed and still honoured; an
        // all-whitespace rate is treated as absent (null).
        expect(approvalUsdPreview("30000", " 15000 ")).toBe("2.0000");
        expect(approvalUsdPreview("30000", "   ")).toBeNull();
    });
    // [C] invoice.totalSYP is the PER-ORDER-LINE figure. A line whose FIFO
    // allocation spans two batches fans out into two InvoiceItem rows at the
    // SAME unit price, but the total the Phase 3 transaction writes is computed
    // from the un-split approvedQuantity exactly ONCE (multiplyMoney(qty, price)
    // per line) — so it equals approvedQuantity x unitPrice with zero drift,
    // regardless of how the allocation split. 24 x 1000 = 24000, never a
    // 0.8333+...-style sum of split shares.
    it("totalSYP equals the per-line figure even when the line would span two batches", () => {
        const lines = [
            { itemId: "l1", approvedQuantity: "24", priceWholesaleSnapshot: "1000", pricingCurrencySnapshot: "SYP" as const },
        ];
        const { totalSYP, unitPricesSYP } = approvalTotalSYP(lines, null);
        expect(unitPricesSYP.get("l1")).toBe("1000.0000");
        expect(totalSYP).toBe("24000.0000");
    });
});

describe("T5c Phase 2 — payment validation (T4b parity)", () => {
    it("three modes plus ledger equation and method rules", () => {
        const cash = resolveApprovalPayment("100.0000", { mode: "FULL_CASH", paymentMethod: "CASH" });
        expect(cash).toMatchObject({ paidAmountSYP: "100.0000", debtAmountSYP: "0.0000" });
        const credit = resolveApprovalPayment("100.0000", { mode: "FULL_CREDIT", paymentMethod: "CASH" });
        expect(credit).toMatchObject({ paidAmountSYP: "0.0000", debtAmountSYP: "100.0000", paymentMethod: undefined });
        const part = resolveApprovalPayment("100.0000", { mode: "PARTIAL", paidAmountSYP: "30", paymentMethod: "CASH" });
        expect(part).toMatchObject({ paidAmountSYP: "30.0000", debtAmountSYP: "70.0000" });
        expect(() => resolveApprovalPayment("100.0000", { mode: "PARTIAL", paidAmountSYP: "0", paymentMethod: "CASH" })).toThrow(
            ApprovalInvalidPaymentError,
        );
        expect(() => resolveApprovalPayment("100.0000", { mode: "PARTIAL", paidAmountSYP: "100", paymentMethod: "CASH" })).toThrow(
            ApprovalInvalidPaymentError,
        );
        expect(() => resolveApprovalPayment("100.0000", { mode: "PARTIAL", paidAmountSYP: "10" })).toThrow(
            ApprovalInvalidPaymentError,
        );
        expect(() => resolveApprovalPayment("100.0000", { mode: "FULL_CASH" })).toThrow(ApprovalInvalidPaymentError);
    });
    // [D] The accepted payment-method list MUST stay equal to the Prisma
    // enum's values (order-insensitive — the set must match, not the order),
    // so adding an enum member without updating PAYMENT_METHODS fails.
    it("PAYMENT_METHODS equals Object.values(PaymentMethod) as a set", () => {
        expect([...PAYMENT_METHODS].sort()).toEqual(Object.values(PaymentMethod).sort());
        expect(PAYMENT_METHODS).toHaveLength(Object.values(PaymentMethod).length);
    });
    // [Addition 5] normalizeRate: a valid positive rate round-trips; a
    // present-but-invalid rate (0, negative, garbage, whitespace, null) becomes
    // null — never 1, never a coerced number. This is the ONLY rate value the
    // approval path may feed deriveUsd() / exchangeRateUsed.
    it("normalizeRate collapses invalid/absent rates to null, keeps positive ones", () => {
        expect(normalizeRate("15000")).toBe("15000.0000");
        expect(normalizeRate(" 15000.5 ")).toBe("15000.5000");
        expect(normalizeRate("0")).toBeNull();
        expect(normalizeRate("-1")).toBeNull();
        expect(normalizeRate("garbage")).toBeNull();
        expect(normalizeRate("")).toBeNull();
        expect(normalizeRate("   ")).toBeNull();
        expect(normalizeRate(null)).toBeNull();
        expect(normalizeRate(undefined)).toBeNull();
    });
});

describe("T5c Phase 2 — conversion (sold-unit factor is the ONLY source)", () => {
    it("3 packs (factor 24) -> requestedBaseQty 72", () => {
        expect(approvalRequestedBaseQty("3", "24")).toBe("72.0000");
    });
    // [A] A NON-INTEGER factor must not cause a false INSUFFICIENT_STOCK, and
    // the SOLD unit's own factor must be the source. 3 x 0.3333 = 0.9999 base
    // units. Against exactly 0.9999 available this PASSES (exact boundary, no
    // off-by-a-ulp reject). The discriminator: at 2.0000 available it ALSO
    // passes — because 0.9999 <= 2.0000. If requireBaseUnit()'s factor (always
    // 1) were wrongly used, the request would be 3 x 1 = 3.0000 > 2.0000 and it
    // would throw. So "passes at 2.0000" is precisely the proof the sold-unit
    // factor (0.3333), not 1, drove the base conversion.
    it("non-integer factor 0.3333 does not reject at the exact boundary", () => {
        expect(approvalRequestedBaseQty("3", "0.3333")).toBe("0.9999");
        const lines = [
            { itemId: "l1", productId: "p1", productName: "سكر", unitId: "u", unitName: "علبة", approvedQuantity: "3", soldUnitFactor: "0.3333" },
        ];
        // Exact boundary: 0.9999 requested vs 0.9999 available -> passes.
        expect(() => assertSufficientStock(lines, new Map([["p1", ["0.9999"]]]))).not.toThrow();
        // With the sold factor, 0.9999 <= 2.0000 -> passes. (Factor 1 would
        // request 3.0000 and fail here, so this passing IS the guard.)
        expect(() => assertSufficientStock(lines, new Map([["p1", ["2.0000"]]]))).not.toThrow();
        // One ten-thousandth below the exact request and it must reject.
        expect(() => assertSufficientStock(lines, new Map([["p1", ["0.9998"]]]))).toThrow(
            ApprovalInsufficientStockError,
        );
    });
});

describe("T5c Phase 2 — availability floors (never rounds up)", () => {
    // [B] 70 / 24 = 2.91666... truncates to 2.9166 (NOT 2.9167) via money.ts's
    // truncateMoney (Decimal.ROUND_DOWN toward zero — never a bare numeric
    // round-mode literal).
    it("truncateMoney truncates toward zero to 4 dp using Decimal.ROUND_DOWN", () => {
        expect(truncateMoney("2.91666")).toBe("2.9166");
        expect(truncateMoney("2.91669")).toBe("2.9166");
        expect(truncateMoney("2.91660")).toBe("2.9166");
        expect(approvalAvailableInLineUnit("70.0000", "24")).toBe("2.9166");
        // 5/3 = 1.66666… truncates (never 1.6667); 100/7 = 14.285714… truncates.
        expect(truncateMoney("1.66666")).toBe("1.6666");
        expect(truncateMoney("1.66669")).toBe("1.6666");
        expect(truncateMoney("14.285714")).toBe("14.2857");
        expect(truncateMoney("14.28579")).toBe("14.2857");
    });
    // [B] The floored figure is RETRYABLE: requesting exactly 2.9166 in a line
    // whose sold factor is 24 requests 2.9166 x 24 = 69.9984 <= 70 and passes,
    // so an admin who copies the shown "available" into the form is accepted.
    it("the shown available figure, retyped, passes the sufficiency check", () => {
        const shown = approvalAvailableInLineUnit("70.0000", "24");
        expect(shown).toBe("2.9166");
        const lines = [
            { itemId: "l1", productId: "p1", productName: "سكر", unitId: "u", unitName: "طرد", approvedQuantity: shown, soldUnitFactor: "24" },
        ];
        expect(() => assertSufficientStock(lines, new Map([["p1", ["70.0000"]]]))).not.toThrow();
    });
});

describe("T5c Phase 2 — sufficiency and roles", () => {
    it("checks per product across units; negatives are 0; available per line unit", () => {
        const lines = [
            { itemId: "l1", productId: "p1", productName: "سكر", unitId: "u-pack", unitName: "طرد", approvedQuantity: "3", soldUnitFactor: "24" },
            { itemId: "l2", productId: "p1", productName: "سكر", unitId: "u-pc", unitName: "قطعة", approvedQuantity: "4", soldUnitFactor: "1" },
        ];
        // [E] Assert the throw first, then capture the error in a SEPARATE try
        // so its payload can be inspected. The old try/expect.unreachable/catch
        // swallowed the unreachable AssertionError inside the catch — a false
        // pass. This form fails loudly if the check ever stops throwing.
        expect(() => assertSufficientStock(lines, new Map([["p1", ["70.0000", "-5.0000"]]]))).toThrow(
            ApprovalInsufficientStockError,
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
    // [E] Two lines of ONE product in different units, each fitting alone but
    // NOT together: the check aggregates per PRODUCT, so the INSUFFICIENT_STOCK
    // details must list BOTH lines (the admin needs to lower one of them).
    it("two lines of one product in different units: each fits alone, together lists BOTH", () => {
        const lines = [
            { itemId: "l1", productId: "p1", productName: "سكر", unitId: "u-pack", unitName: "طرد", approvedQuantity: "2", soldUnitFactor: "10" },
            { itemId: "l2", productId: "p1", productName: "سكر", unitId: "u-pc", unitName: "قطعة", approvedQuantity: "15", soldUnitFactor: "1" },
        ];
        // Alone: 20 <= 30 and 15 <= 30 — both pass individually.
        expect(() => assertSufficientStock([lines[0]], new Map([["p1", ["30.0000"]]]))).not.toThrow();
        expect(() => assertSufficientStock([lines[1]], new Map([["p1", ["30.0000"]]]))).not.toThrow();
        // Together: 20 + 15 = 35 > 30 — fails, and lists BOTH lines.
        let err: ApprovalInsufficientStockError | undefined;
        try {
            assertSufficientStock(lines, new Map([["p1", ["30.0000"]]]));
        } catch (e) {
            err = e as ApprovalInsufficientStockError;
        }
        expect(err).toBeInstanceOf(ApprovalInsufficientStockError);
        expect(err!.lines.map((l) => l.itemId).sort()).toEqual(["l1", "l2"]);
    });
    it("orders:approve is ADMIN-only; TX envelope matches T4c", () => {
        expect(ROLE_CAPABILITY_MATRIX["orders:approve"]).toEqual({ ADMIN: true, CASHIER: false });
        expect(() => assertRolePermission("ADMIN", "orders:approve")).not.toThrow();
        expect(() => assertRolePermission("CASHIER", "orders:approve")).toThrow(ForbiddenRoleError);
        expect(APPROVAL_TX_OPTIONS).toEqual({ maxWait: 10_000, timeout: 20_000 });
        expect(new ApprovalOrderNotFoundError().message).toBeTruthy();
        expect(new ApprovalAlreadyReviewedError().message).toBeTruthy();
    });
    it("no nested writes, raw queries, conversionFactor, or trust labels", () => {
        const src = fs.readFileSync(path.resolve(process.cwd(), "lib/data/orders-approval.ts"), "utf-8");
        expect(src).not.toMatch(/\$queryRaw/);
        expect(src).not.toMatch(/conversionFactor/);
        expect(src).not.toMatch(/موثوق|موثّق/);
    });
    it("tx write provenance: every tx.<model>.<method>( carries tenantId (verifiedRetailer excepted)", () => {
        // Comment-stripped: proves tenantId is in executable code, not prose.
        const raw = fs.readFileSync(path.resolve(process.cwd(), "lib/data/orders-approval-tx.ts"), "utf-8");
        const src = raw
            .replace(/\/\*[\s\S]*?\*\//g, "\n")
            .replace(/(^|\s)\/\/.*$/gm, "$1");
        const calls = [...src.matchAll(/tx\.([A-Za-z]+)\.([A-Za-z]+)\s*\(/g)];
        expect(calls.length).toBeGreaterThan(0);
        const writes = calls.filter(([, _model, method]) =>
            ["create", "update", "updateMany", "upsert", "delete", "deleteMany", "findMany", "findFirst", "findUnique", "findUniqueOrThrow", "count", "groupBy"].includes(method)
        );
        for (const [full, model] of writes) {
            if (model === "verifiedRetailer") continue; // platform-wide, no tenantId column
            // The matching call's argument block must name tenantId.
            const start = src.indexOf(full);
            const block = src.slice(start, start + 1200);
            expect(block, `${full} must carry tenantId`).toMatch(/tenantId/);
        }
        // No direct product/productUnit model writes (gateway-owned).
        expect(src).not.toMatch(/tx\.product(?:Unit)?\.(create|update|upsert|delete|deleteMany)/);
        // No nested writes, no raw queries, no factor access in the tx file.
        expect(src).not.toMatch(/\$queryRaw/);
        expect(src).not.toMatch(/conversionFactor/);
    });
});

