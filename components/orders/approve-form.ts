/**
 * components/orders/approve-form.ts
 *
 * T5c Phase 5 — approval form state + payload builder (no JSX).
 * Fetching stays in orders-client.tsx; JSX lives in
 * approve-order-dialog.tsx. dir=rtl at render. No trust labels.
 */

"use client";

import { useState } from "react";
import { compareMoney, convertCurrency, multiplyMoney, serializeMoney, sumMoney } from "@/lib/utils/money";
import type { ApproveOrderPayload, ApprovePaymentMode, OrderDetailView } from "./types";

export type CustomerChoice =
    | { kind: "EXISTING"; customerId: string }
    | { kind: "NEW"; name: string; phone: string; shopName: string };

export const APPROVE_QTY_RE = /^\d{1,14}(\.\d{1,4})?$/;

export const APPROVE_PAYMENT_METHODS = [
    { id: "CASH", label: "نقداً (كاش)" },
    { id: "SHAM_CASH", label: "شام كاش" },
    { id: "SYRIATEL_CASH", label: "سيرياتيل كاش" },
    { id: "BANK_TRANSFER", label: "تحويل بنكي / مكتب" },
    { id: "OTHER", label: "وسيلة دفع أخرى" },
] as const;

export function approveLineTotalSYP(
    approvedQty: string, price: string, currency: "SYP" | "USD", rate: string | null
): string | null {
    try {
        const unitSYP = currency === "SYP" ? serializeMoney(price) : convertCurrency(price, rate ?? "", "USD", "SYP");
        return multiplyMoney(approvedQty, unitSYP);
    } catch {
        return null;
    }
}

export function approveOrderTotalSYP(
    order: OrderDetailView, quantities: Record<string, string>, rate: string | null
): string | null {
    const parts: string[] = [];
    for (const l of order.lines) {
        const q = (quantities[l.id] ?? l.quantity).trim();
        if (!APPROVE_QTY_RE.test(q)) return null;
        const t = approveLineTotalSYP(q, l.priceWholesaleSnapshot, l.pricingCurrencySnapshot, rate);
        if (t === null) return null;
        parts.push(t);
    }
    try {
        return sumMoney(parts);
    } catch {
        return null;
    }
}

export function useApproveForm(order: OrderDetailView | null, open: boolean) {
    const [prevKey, setPrevKey] = useState<string | null>(null);
    const [quantities, setQuantities] = useState<Record<string, string>>({});
    const [qtyErrors, setQtyErrors] = useState<Record<string, string | null>>({});
    const [customer, setCustomer] = useState<CustomerChoice | null>(null);
    const [newName, setNewName] = useState("");
    const [newPhone, setNewPhone] = useState("");
    const [newShop, setNewShop] = useState("");
    const [payMode, setPayMode] = useState<ApprovePaymentMode>("FULL_CREDIT");
    const [paidInput, setPaidInput] = useState("");
    const [payMethod, setPayMethod] = useState<string>("CASH");
    const [localError, setLocalError] = useState<string | null>(null);

    const openKey = order ? `${order.id}:${open}` : null;
    if (openKey !== prevKey) {
        setPrevKey(openKey);
        if (open && order) {
            const q: Record<string, string> = {};
            for (const l of order.lines) q[l.id] = l.quantity;
            setQuantities(q);
            setQtyErrors({});
            const suggested = order.matchedCustomer ?? order.candidates[0] ?? null;
            setCustomer(suggested ? { kind: "EXISTING", customerId: suggested.id } : null);
            setNewName(order.retailerName ?? "");
            setNewPhone(order.retailerPhone ?? "");
            setNewShop(order.retailerShopName ?? "");
            setPayMode("FULL_CREDIT");
            setPaidInput("");
            setPayMethod("CASH");
            setLocalError(null);
        }
    }

    const rate = order?.dailyExchangeRate ?? null;
    const totalSYP = order ? approveOrderTotalSYP(order, quantities, rate) : null;
    const hasUsdWithoutRate = !!order && !rate && order.lines.some((l) => l.pricingCurrencySnapshot === "USD");

    function setQty(id: string, v: string) {
        setQuantities((p) => ({ ...p, [id]: v }));
        setQtyErrors((p) => ({ ...p, [id]: APPROVE_QTY_RE.test(v.trim()) ? null : "كمية غير صالحة." }));
    }

    function buildPayload(): ApproveOrderPayload | null {
        if (!order) return null;
        for (const l of order.lines) {
            const q = (quantities[l.id] ?? "").trim();
            if (!APPROVE_QTY_RE.test(q)) {
                setQtyErrors((p) => ({ ...p, [l.id]: "كمية غير صالحة." }));
                setLocalError("راجع الكميات المعتمدة قبل المتابعة.");
                return null;
            }
            try {
                if (compareMoney(q, "0") <= 0) throw new Error();
            } catch {
                setQtyErrors((p) => ({ ...p, [l.id]: "الكمية يجب أن تكون أكبر من صفر." }));
                setLocalError("راجع الكميات المعتمدة قبل المتابعة.");
                return null;
            }
        }
        if (totalSYP === null) {
            setLocalError(hasUsdWithoutRate ? "حدّد سعر الصرف أولاً." : "تعذّر حساب الإجمالي.");
            return null;
        }
        let customerPayload: ApproveOrderPayload["customer"];
        if (customer?.kind === "EXISTING") {
            customerPayload = { mode: "EXISTING", customerId: customer.customerId };
        } else {
            if (newName.trim().length < 2 || newName.trim().length > 80) {
                setLocalError("اسم الزبون مطلوب (2–80 حرف).");
                return null;
            }
            if (!newPhone.trim()) {
                setLocalError("هاتف الزبون مطلوب.");
                return null;
            }
            customerPayload = {
                mode: "NEW",
                name: newName.trim(),
                phone: newPhone.trim(),
                ...(newShop.trim() ? { shopName: newShop.trim() } : {}),
            };
        }
        const payment: ApproveOrderPayload["payment"] = { mode: payMode };
        if (payMode === "PARTIAL") {
            const p = paidInput.trim();
            try {
                if (!APPROVE_QTY_RE.test(p) || compareMoney(p, "0") <= 0 || compareMoney(p, totalSYP) >= 0) {
                    setLocalError("الدفعة الجزئية يجب أن تكون أكبر من صفر وأقل من الإجمالي.");
                    return null;
                }
                payment.paidAmountSYP = p;
                payment.paymentMethod = payMethod;
            } catch {
                setLocalError("مبلغ الدفعة غير صالح.");
                return null;
            }
        } else if (payMode === "FULL_CASH") {
            payment.paymentMethod = payMethod;
        }
        setLocalError(null);
        return {
            lines: order.lines.map((l) => ({ itemId: l.id, approvedQuantity: (quantities[l.id] ?? l.quantity).trim() })),
            customer: customerPayload,
            payment,
        };
    }

    return {
        quantities, qtyErrors, setQty, customer, setCustomer,
        newName, setNewName, newPhone, setNewPhone, newShop, setNewShop,
        payMode, setPayMode, paidInput, setPaidInput, payMethod, setPayMethod,
        localError, setLocalError, rate, totalSYP, hasUsdWithoutRate, buildPayload,
    };
}

export type ApproveForm = ReturnType<typeof useApproveForm>;
