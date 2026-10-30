/**
 * lib/ledger/__tests__/balance-adjustments.test.ts
 *
 * The ONE balance formula (schema v6.1):
 *   net debt = SUM(Invoice.debtAmountSYP)
 *            + SUM(CustomerBalanceAdjustment.amountSYP)
 *            - SUM(CustomerPayment.amountSYP WHERE invoiceId IS NULL)
 * Every expectation is exact decimal equality (compareMoney), never a float.
 */

import { describe, expect, it, vi } from "vitest";
import { compareMoney } from "@/lib/utils/money";
import { computeBalanceSYP, getCustomerBalanceSYP } from "@/lib/ledger/balance";

const sameMoney = (actual: string, expected: string) =>
    expect(compareMoney(actual, expected)).toBe(0);

describe("computeBalanceSYP", () => {
    it("a customer with ONLY an opening balance shows exactly that balance", () => {
        sameMoney(computeBalanceSYP([], [], ["5250000"]), "5250000");
    });

    it("invoices + adjustments - independent repayments", () => {
        sameMoney(computeBalanceSYP(["1000", "500"], ["300"], ["250"]), "1450");
    });

    it("an empty customer is exactly zero", () => {
        sameMoney(computeBalanceSYP([], [], []), "0");
    });

    it("a negative CORRECTION lowers the balance, landing exactly on zero", () => {
        sameMoney(computeBalanceSYP(["1000"], [], ["-400"]), "600");
        sameMoney(computeBalanceSYP(["1000"], [], ["-1000"]), "0");
    });

    it("a positive CORRECTION raises the balance", () => {
        sameMoney(computeBalanceSYP(["1000"], [], ["200"]), "1200");
    });

    it("a void (negated invoice) nets its original out to zero, adjustments untouched", () => {
        sameMoney(computeBalanceSYP(["500", "-500"], [], ["1000"]), "1000");
    });

    it("an overpaid customer goes negative", () => {
        sameMoney(computeBalanceSYP(["100"], ["150"], []), "-50");
    });

    it("is exact for large SYP values with fractional parts", () => {
        // 900000000.1234 + 100000000.5000 - 50000000.0001
        sameMoney(
            computeBalanceSYP(["900000000.1234"], ["50000000.0001"], ["100000000.5000"]),
            "950000000.6233"
        );
    });

    it("has no float drift (0.1 + 0.2 === 0.3 exactly)", () => {
        sameMoney(computeBalanceSYP(["0.1", "0.2"], [], []), "0.3");
        sameMoney(computeBalanceSYP([], [], ["0.1", "0.2"]), "0.3");
    });

    it("skips null entries instead of poisoning the total", () => {
        sameMoney(computeBalanceSYP([null as unknown as string], [], ["10"]), "10");
    });

    it("fails loud on a malformed amount instead of silently dropping it", () => {
        expect(() => computeBalanceSYP([], [], ["abc"])).toThrow();
    });
});

describe("getCustomerBalanceSYP", () => {
    function fakeTx(opts: {
        invoices?: string[];
        repayments?: string[];
        adjustments?: string[];
    }) {
        return {
            invoice: {
                findMany: vi.fn().mockResolvedValue((opts.invoices ?? []).map((d) => ({ debtAmountSYP: d }))),
            },
            customerPayment: {
                findMany: vi.fn().mockResolvedValue((opts.repayments ?? []).map((a) => ({ amountSYP: a }))),
            },
            customerBalanceAdjustment: {
                findMany: vi.fn().mockResolvedValue((opts.adjustments ?? []).map((a) => ({ amountSYP: a }))),
            },
        };
    }
    const run = (tx: ReturnType<typeof fakeTx>) =>
        getCustomerBalanceSYP(tx as unknown as Parameters<typeof getCustomerBalanceSYP>[0], "t1", "c1");

    it("combines all three sources through the one formula", async () => {
        const tx = fakeTx({ invoices: ["1000", "-250"], repayments: ["100"], adjustments: ["400"] });
        sameMoney(await run(tx), "1050");
    });

    it("subtracts ONLY independent repayments: the payment query filters invoiceId: null", async () => {
        const tx = fakeTx({ invoices: ["1000"] });
        await run(tx);
        expect(tx.customerPayment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: "t1", customerId: "c1", invoiceId: null } })
        );
    });

    it("scopes invoices and adjustments to this tenant AND this customer", async () => {
        const tx = fakeTx({});
        await run(tx);
        expect(tx.invoice.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: "t1", customerId: "c1" } })
        );
        expect(tx.customerBalanceAdjustment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: "t1", customerId: "c1" } })
        );
    });

    it("a customer with only an opening balance and zero invoices", async () => {
        sameMoney(await run(fakeTx({ adjustments: ["5250000"] })), "5250000");
    });
});