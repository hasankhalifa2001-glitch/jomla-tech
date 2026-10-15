/**
 * lib/data/orders-approval.ts
 *
 * T5c — pure helpers + validation for B2B order approval. No Prisma access in
 * this file: typed errors, the strict zod request schema, and pure
 * price/total/payment/sufficiency helpers. The transaction lives in
 * lib/data/orders-approval-tx.ts.
 *
 * Conventions: decimal.js only via lib/utils/money.ts; unit conversion only
 * via lib/inventory/units.ts; no factor-field access here; SYP authoritative,
 * USD via deriveUsd() only.
 *
 *  - `available` in INSUFFICIENT_STOCK details is rounded DOWN (never up), so
 *    an admin who retries with the shown value always passes the check.
 *  - ONE source for the requested base quantity (approvalRequestedBaseQty):
 *    the sufficiency check and the FIFO request both use it. A quantity that
 *    converts to zero base units is rejected (400), never silently priced.
 *  - INSUFFICIENT_STOCK details always have exactly the keys
 *    { itemId, productName, unitName, available } — on BOTH the pre-allocation
 *    check and the defensive post-allocation path.
 */

import { z } from "zod";
import type { PaymentMethod } from "@prisma/client";
import { STORE_ERROR, STORE_MAX_LINES_PER_ORDER, STORE_MAX_QTY_PER_LINE } from "@/lib/config/storefront";
import {
    compareMoney,
    convertCurrency,
    deriveUsd,
    multiplyMoney,
    serializeMoney,
    subtractMoney,
    sumMoney,
    truncateMoney,
} from "@/lib/utils/money";
import { fromBaseUnit, toBaseUnit } from "@/lib/inventory/units";
import { normalizePhone } from "@/lib/utils/phone";

/** Interactive-transaction envelope — identical to T4c's sync engine. */
export const APPROVAL_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/**
 * Upper bound on the number of lines in one approval request. Reuses T5a's
 * STORE_MAX_LINES_PER_ORDER so the two limits can never drift apart.
 */
const MAX_APPROVAL_LINES = STORE_MAX_LINES_PER_ORDER;

/** Decimal string: digits with an optional fraction of at most 4 dp. No sign, no exponent, no spaces. */
const DECIMAL_4DP_RE = /^\d{1,14}(\.\d{1,4})?$/;
/** Hard length bound applied BEFORE any decimal parsing. */
const DECIMAL_MAX_LENGTH = 24;

/** Base class for every typed approval failure. The route never retries these. */
export class ApprovalDomainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ApprovalDomainError";
    }
}

export class ApprovalValidationError extends ApprovalDomainError {
    constructor(message = "بيانات الموافقة غير صالحة.") {
        super(message);
        this.name = "ApprovalValidationError";
    }
}

export class ApprovalOrderNotFoundError extends ApprovalDomainError {
    constructor(message = "الطلب غير موجود.") {
        super(message);
        this.name = "ApprovalOrderNotFoundError";
    }
}

export class ApprovalAlreadyReviewedError extends ApprovalDomainError {
    constructor(message = "تمت مراجعة هذا الطلب مسبقاً.") {
        super(message);
        this.name = "ApprovalAlreadyReviewedError";
    }
}

export class ApprovalProductInactiveError extends ApprovalDomainError {
    readonly itemId: string;
    readonly productName: string;
    constructor(itemId: string, productName: string) {
        super(`المنتج «${productName}» غير متوفر حالياً — يمكنك رفض الطلب بدلاً من الموافقة.`);
        this.name = "ApprovalProductInactiveError";
        this.itemId = itemId;
        this.productName = productName;
    }
}

/** EXACT key set of one INSUFFICIENT_STOCK detail entry (no ids beyond itemId). */
export interface InsufficientStockLine {
    itemId: string;
    productName: string;
    unitName: string;
    /** Availability rendered in THAT LINE's own unit (decimal string, rounded DOWN to 4 dp). */
    available: string;
}

export class ApprovalInsufficientStockError extends ApprovalDomainError {
    readonly lines: InsufficientStockLine[];
    constructor(lines: InsufficientStockLine[]) {
        super("المخزون غير كافٍ لبعض الأصناف.");
        this.name = "ApprovalInsufficientStockError";
        this.lines = lines;
    }

    /**
     * Error for the gateway's DEFENSIVE post-allocation path (a bug/race that
     * the pre-allocation check should have prevented). Renders EVERY passed
     * line (the lines of the affected product) with the same entry shape as
     * assertSufficientStock(), so the admin-facing details are identical
     * whichever path caught it.
     */
    static fromSufficiencyLines(
        lines: SufficiencyLineInput[],
        lockedBaseQuantitiesByProduct: Map<string, string[]>
    ): ApprovalInsufficientStockError {
        return new ApprovalInsufficientStockError(
            buildInsufficientLines(lines, lockedBaseQuantitiesByProduct, false)
        );
    }
}

export class ApprovalRateRequiredError extends ApprovalDomainError {
    constructor(message = "حدّد سعر الصرف أولاً.") {
        super(message);
        this.name = "ApprovalRateRequiredError";
    }
}

export class ApprovalInvalidCustomerError extends ApprovalDomainError {
    constructor(message = "الزبون المحدد غير صالح.") {
        super(message);
        this.name = "ApprovalInvalidCustomerError";
    }
}

export class ApprovalInvalidPaymentError extends ApprovalDomainError {
    constructor(message = "بيانات الدفعة غير صالحة.") {
        super(message);
        this.name = "ApprovalInvalidPaymentError";
    }
}

/**
 * The complete set of accepted payment methods — MUST equal the Prisma
 * `PaymentMethod` enum's values (asserted by a unit test).
 */
export const PAYMENT_METHODS = ["CASH", "SHAM_CASH", "SYRIATEL_CASH", "BANK_TRANSFER", "OTHER"] as const;

/** > 0, <= 4 dp, <= STORE_MAX_QTY_PER_LINE. Trimmed by the schema. */
const approvedQuantitySchema = z
    .string()
    .trim()
    .max(DECIMAL_MAX_LENGTH)
    .superRefine((v, ctx) => {
        if (!DECIMAL_4DP_RE.test(v)) {
            ctx.addIssue({ code: "custom", message: "الكمية غير صالحة." });
            return;
        }
        try {
            if (compareMoney(v, "0") <= 0) {
                ctx.addIssue({ code: "custom", message: "الكمية يجب أن تكون أكبر من الصفر." });
                return;
            }
            if (compareMoney(v, STORE_MAX_QTY_PER_LINE) > 0) {
                ctx.addIssue({ code: "custom", message: "الكمية تتجاوز الحد المسموح." });
            }
        } catch {
            ctx.addIssue({ code: "custom", message: "الكمية غير صالحة." });
        }
    });

export const approveOrderBodySchema = z
    .object({
        lines: z
            .array(
                z
                    .object({
                        itemId: z.string().min(1).max(64),
                        approvedQuantity: approvedQuantitySchema,
                    })
                    .strict(),
            )
            .min(1)
            .max(MAX_APPROVAL_LINES),
        customer: z.union([
            z.object({ mode: z.literal("EXISTING"), customerId: z.string().min(1).max(64) }).strict(),
            z
                .object({
                    mode: z.literal("NEW"),
                    name: z.string().trim().min(2).max(80),
                    phone: z
                        .string()
                        .max(40)
                        .superRefine((v, ctx) => {
                            if (normalizePhone(v) === null) {
                                ctx.addIssue({ code: "custom", message: "رقم هاتف الزبون غير صالح." });
                            }
                        }),
                    shopName: z.string().trim().max(120).optional(),
                })
                .strict(),
        ]),
        payment: z
            .object({
                mode: z.enum(["FULL_CASH", "FULL_CREDIT", "PARTIAL"]),
                // Only meaningful for PARTIAL; ignored for the other two modes.
                paidAmountSYP: z
                    .string()
                    .trim()
                    .max(DECIMAL_MAX_LENGTH)
                    .regex(DECIMAL_4DP_RE, "المبلغ المدفوع غير صالح.")
                    .optional(),
                paymentMethod: z.enum(PAYMENT_METHODS).optional(),
            })
            .strict(),
    })
    .strict();

export type ApproveOrderBody = z.infer<typeof approveOrderBodySchema>;
export type ApprovePaymentMode = ApproveOrderBody["payment"]["mode"];

/**
 * Normalizes a tenant daily exchange rate to the ONE value the approval path
 * may use. A present-but-invalid rate (0, negative, non-numeric, blank)
 * collapses to null — never 1, never a coerced number.
 *   - null is fine for a SYP-only order: every USD field stays null.
 *   - a USD-priced line with a null normalized rate is RATE_REQUIRED (422).
 */
export function normalizeRate(rate: string | null | undefined): string | null {
    if (rate == null) return null;
    const trimmed = rate.trim();
    if (!trimmed) return null;
    try {
        return compareMoney(trimmed, "0") > 0 ? serializeMoney(trimmed) : null;
    } catch {
        return null;
    }
}

/** What the route passes into the approval gateway transaction. */
export interface ApproveOrderInput {
    orderId: string;
    tenantId: string;
    approvingUserId: string;
    body: ApproveOrderBody;
}

/** What the approval gateway returns on success (money as Decimal strings). */
export interface ApproveOrderResult {
    invoiceId: string;
    totalSYP: string;
    paidAmountSYP: string;
    debtAmountSYP: string;
    customerId: string;
}

export interface PricedApprovalLine {
    itemId: string;
    approvedQuantity: string;
    priceWholesaleSnapshot: string;
    pricingCurrencySnapshot: "SYP" | "USD";
}

export function approvalUnitPriceSYP(
    line: Pick<PricedApprovalLine, "priceWholesaleSnapshot" | "pricingCurrencySnapshot">,
    exchangeRate: string | null,
): string {
    if (line.pricingCurrencySnapshot === "SYP") return serializeMoney(line.priceWholesaleSnapshot);
    const rate = (exchangeRate ?? "").trim();
    if (!rate) throw new ApprovalRateRequiredError();
    try {
        if (compareMoney(serializeMoney(rate), "0") <= 0) throw new ApprovalRateRequiredError();
    } catch (e) {
        if (e instanceof ApprovalRateRequiredError) throw e;
        throw new ApprovalRateRequiredError();
    }
    return convertCurrency(serializeMoney(line.priceWholesaleSnapshot), serializeMoney(rate), "USD", "SYP");
}

export function approvalTotalSYP(
    lines: PricedApprovalLine[],
    exchangeRate: string | null,
): { totalSYP: string; unitPricesSYP: Map<string, string> } {
    const unitPricesSYP = new Map<string, string>();
    const rowTotals: string[] = [];
    for (const line of lines) {
        const unitPrice = approvalUnitPriceSYP(line, exchangeRate);
        unitPricesSYP.set(line.itemId, unitPrice);
        rowTotals.push(multiplyMoney(serializeMoney(line.approvedQuantity), unitPrice));
    }
    return { totalSYP: sumMoney(rowTotals), unitPricesSYP };
}

export interface ResolvedApprovalPayment {
    paidAmountSYP: string;
    debtAmountSYP: string;
    paymentMethod: PaymentMethod | undefined;
}

/**
 * Server-side payment validation (mirrors the POS payment modal's rules).
 *  - FULL_CASH:   paid = total; a paymentMethod is required.
 *  - FULL_CREDIT: paid = 0; a stray paymentMethod is IGNORED; no
 *                 CustomerPayment row is written when paid = 0.
 *  - PARTIAL:     0 < paid < total; a paymentMethod is required.
 * debt = total - paid is the authoritative figure (ledger equation).
 */
export function resolveApprovalPayment(
    totalSYP: string,
    payment: { mode: ApprovePaymentMode; paidAmountSYP?: string; paymentMethod?: PaymentMethod },
): ResolvedApprovalPayment {
    const total = serializeMoney(totalSYP);
    if (payment.mode === "FULL_CASH") {
        if (!payment.paymentMethod) throw new ApprovalInvalidPaymentError("يجب تحديد طريقة الدفع.");
        return { paidAmountSYP: total, debtAmountSYP: subtractMoney(total, total), paymentMethod: payment.paymentMethod };
    }
    if (payment.mode === "FULL_CREDIT") {
        return { paidAmountSYP: serializeMoney("0"), debtAmountSYP: total, paymentMethod: undefined };
    }
    if (payment.paidAmountSYP === undefined) throw new ApprovalInvalidPaymentError("حدّد المبلغ المدفوع.");
    let paid: string;
    try {
        paid = serializeMoney(payment.paidAmountSYP);
    } catch {
        throw new ApprovalInvalidPaymentError("المبلغ المدفوع غير صالح.");
    }
    if (compareMoney(paid, "0") <= 0 || compareMoney(paid, total) >= 0) {
        throw new ApprovalInvalidPaymentError("الدفع الجزئي يجب أن يكون أكبر من الصفر وأقل من الإجمالي.");
    }
    if (!payment.paymentMethod) throw new ApprovalInvalidPaymentError("يجب تحديد طريقة الدفع.");
    return { paidAmountSYP: paid, debtAmountSYP: subtractMoney(total, paid), paymentMethod: payment.paymentMethod };
}

export function assertApprovalLineSet(submittedIds: string[], orderItemIds: string[]): void {
    const seen = new Set<string>();
    for (const id of submittedIds) {
        if (seen.has(id)) throw new ApprovalValidationError("بند مكرر في بيانات الموافقة.");
        seen.add(id);
    }
    const orderSet = new Set(orderItemIds);
    if (seen.size !== orderSet.size || [...seen].some((id) => !orderSet.has(id))) {
        throw new ApprovalValidationError("بنود الموافقة يجب أن تطابق بنود الطلب تماماً.");
    }
}

/**
 * THE single source of a line's requested quantity in base units:
 * approvedQuantity (sale unit) x the SOLD unit's own factor, 4 dp.
 * The sufficiency check and the FIFO request MUST both use this exact value.
 * `soldUnitFactor` comes from getUnitConversionFactor(tx, tenantId, item.unitId),
 * never from requireBaseUnit() and never from a client payload.
 *
 * A quantity that rounds to zero base units (e.g. a unit factor below 1 with a
 * tiny quantity) is a validation error: it would otherwise be priced on the
 * invoice without deducting any stock.
 */
export function approvalRequestedBaseQty(
    approvedQuantity: string,
    soldUnitFactor: string,
    lineLabel?: string,
): string {
    const base = toBaseUnit(serializeMoney(approvedQuantity), soldUnitFactor).toFixed(4);
    if (compareMoney(base, "0") <= 0) {
        throw new ApprovalValidationError(
            lineLabel
                ? `الكمية المعتمدة للصنف «${lineLabel}» صغيرة جداً بحيث لا تعادل أي كمية من الوحدة الأساسية.`
                : "الكمية المعتمدة صغيرة جداً بحيث لا تعادل أي كمية من الوحدة الأساسية."
        );
    }
    return base;
}

/**
 * Availability (base units) rendered in a line's own unit, rounded DOWN to
 * 4 dp via money.ts's truncateMoney. Never round up: 70 pieces / 24 = 2.9166...
 * must show 2.9166, so an admin who retypes that figure requests <= what is
 * truly available and passes the sufficiency check on retry.
 */
export function approvalAvailableInLineUnit(availableBase: string, soldUnitFactor: string): string {
    return truncateMoney(fromBaseUnit(availableBase, soldUnitFactor).toString());
}

/**
 * Groups locked batch quantities (base units) by product, for
 * assertSufficientStock.
 */
export function groupLockedQuantitiesByProduct(
    rows: ReadonlyArray<{ productId: string; quantity: string }>,
): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const row of rows) {
        const list = out.get(row.productId);
        if (list) list.push(row.quantity);
        else out.set(row.productId, [row.quantity]);
    }
    return out;
}

export interface SufficiencyLineInput {
    itemId: string;
    productId: string;
    productName: string;
    unitId: string;
    unitName: string;
    approvedQuantity: string;
    soldUnitFactor: string;
}

/** Positive batch quantities only — negative/zero batches count as 0. */
function availableBaseOf(lockedQuantities: string[]): string {
    return sumMoney(lockedQuantities.map((q) => (compareMoney(q, "0") > 0 ? serializeMoney(q) : "0.0000")));
}

/**
 * Builds the INSUFFICIENT_STOCK detail entries with the EXACT key set
 * { itemId, productName, unitName, available }. With onlyShort = true only
 * lines whose PRODUCT total requested exceeds availability are returned
 * (pre-allocation check); with false every passed line is returned (defensive
 * post-allocation path).
 */
function buildInsufficientLines(
    lines: SufficiencyLineInput[],
    lockedBaseQuantitiesByProduct: Map<string, string[]>,
    onlyShort: boolean,
): InsufficientStockLine[] {
    const requestedByProduct = new Map<string, string>();
    for (const line of lines) {
        const baseQty = approvalRequestedBaseQty(line.approvedQuantity, line.soldUnitFactor, line.productName);
        const prev = requestedByProduct.get(line.productId) ?? "0.0000";
        requestedByProduct.set(line.productId, sumMoney([prev, baseQty]));
    }
    const out: InsufficientStockLine[] = [];
    for (const line of lines) {
        const availableBase = availableBaseOf(lockedBaseQuantitiesByProduct.get(line.productId) ?? []);
        const requested = requestedByProduct.get(line.productId) ?? "0.0000";
        const isShort = compareMoney(requested, availableBase) > 0;
        if (onlyShort && !isShort) continue;
        out.push({
            itemId: line.itemId,
            productName: line.productName,
            unitName: line.unitName,
            available: approvalAvailableInLineUnit(availableBase, line.soldUnitFactor),
        });
    }
    return out;
}

export function assertSufficientStock(
    lines: SufficiencyLineInput[],
    lockedBaseQuantitiesByProduct: Map<string, string[]>,
): void {
    const short = buildInsufficientLines(lines, lockedBaseQuantitiesByProduct, true);
    if (short.length > 0) throw new ApprovalInsufficientStockError(short);
}

export function approvalUsdPreview(amountSYP: string, exchangeRate: string | null): string | null {
    return deriveUsd(serializeMoney(amountSYP), (exchangeRate ?? "").trim() ? exchangeRate : null);
}

export const APPROVAL_STORE_ERROR_CODES = {
    validation: STORE_ERROR.VALIDATION_ERROR,
    alreadyReviewed: STORE_ERROR.ALREADY_REVIEWED,
    notFound: STORE_ERROR.NOT_FOUND,
    productInactive: STORE_ERROR.PRODUCT_INACTIVE,
    insufficientStock: STORE_ERROR.INSUFFICIENT_STOCK,
    rateRequired: STORE_ERROR.RATE_REQUIRED,
    invalidCustomer: STORE_ERROR.INVALID_CUSTOMER,
    invalidPayment: STORE_ERROR.INVALID_PAYMENT,
    forbidden: STORE_ERROR.FORBIDDEN,
    unauthorized: STORE_ERROR.UNAUTHORIZED,
    tenantNotWritable: STORE_ERROR.TENANT_NOT_WRITABLE,
    // A retryable transaction failure (P2034 / P2028) — "حاول مرة ثانية".
    txRetry: STORE_ERROR.TX_RETRY,
    internal: STORE_ERROR.INTERNAL_ERROR,
} as const;