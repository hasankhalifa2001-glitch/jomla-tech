/**
 * lib/data/analytics.ts
 *
 * T4h — Dashboard Analytics data-access layer.
 *
 * Pure tenant-scoped READS against tables that already exist (Invoice,
 * InvoiceItem, ProductBatch, Customer) plus T4g's frozen `costAmountSYP`.
 * Every query goes through the caller-supplied `db` (a getTenantDb() client)
 * so the T1 Prisma Client Extension injects `tenantId` (and every `where`
 * below ALSO carries an explicit `tenantId` wherever a query could not
 * otherwise be seen by the extension — belt-and-suspenders, as elsewhere).
 * NO raw SQL anywhere. Day bucketing happens app-side (Postgres date_trunc is
 * unreachable without raw SQL); customer balances use Prisma `groupBy`, which
 * needs no date arithmetic.
 *
 * ROLE NOTE: this module contains NO role/permission logic — that belongs to
 * the route that calls it (app/api/analytics/route.ts), per lib/data/
 * products.ts's and lib/data/invoices.ts's shared convention: a data layer
 * fetches, the route decides who may see it.
 *
 * -----------------------------------------------------------------------------
 * THE DEFINITIONS (each one is the EXACT query a verification script runs):
 * -----------------------------------------------------------------------------
 * [v4.8 — SALES vs RETURNS ARE SEPARATE FIGURES]
 *   A void writes a mirror Invoice row (status VOIDED) with NEGATED money, on
 *   the day the void is made. Previously every status was summed into ONE
 *   "sales" number, so the day of a cancellation showed NEGATIVE sales next to
 *   "0 invoices" — two figures that looked contradictory. They are now
 *   reported separately, from the same rows:
 *
 * salesSYP(window)      = SUM(Invoice.totalSYP) over invoices with
 *                         status != VOIDED created in the window. GROSS sales:
 *                         never reduced by a later (or same-day) void, so a
 *                         day's figure cannot change retroactively.
 *
 * returnsSYP(window)    = −SUM(Invoice.totalSYP) over VOIDED rows created in
 *                         the window, i.e. a POSITIVE number ("how much was
 *                         returned/cancelled today"). returnsCount is the
 *                         number of such void rows.
 *
 * netSalesSYP(window)   = salesSYP − returnsSYP  (= SUM over EVERY row).
 *                         Identity pinned by tests.
 *
 * salesUSD(today)       = SUM(Invoice.totalUSD) over the SAME non-void rows,
 *                         skipping nulls. Each invoice carries the USD figure
 *                         derived from ITS OWN frozen exchangeRateUsed, so the
 *                         total is never re-converted at today's rate. Null
 *                         when no rated sale exists today. (Returns have no
 *                         USD caption — SYP is authoritative.)
 *
 * PROFIT — [v4.8] computed at INVOICE level, never from quantities:
 *   profit(rows) = SUM(Invoice.totalSYP) − SUM(InvoiceItem.costAmountSYP)
 *   Both operands are stored, exact figures (costAmountSYP is frozen at commit
 *   time, T4g; non-nullable). The previous formula
 *   Σ(unitPriceSYP × quantity − costAmountSYP) multiplied by the ROUNDED
 *   sale-unit `quantity` (20/24 = 0.8333), which drifts for FIFO-split sales
 *   (a 3-way split summed to 0.9999). Void rows carry negated totalSYP AND
 *   negated costAmountSYP, so a void's profit is exactly the negation of the
 *   original's.
 *     grossProfitSYP   = profit over non-void rows
 *     returnsProfitSYP = profit over VOIDED rows (≤ 0 — "profit given back")
 *     netProfitSYP     = grossProfitSYP + returnsProfitSYP
 *
 * invoiceCount(today)   = COUNT of invoices created today with status
 *                         COMPLETED. Void mirror rows are VOIDED, so they are
 *                         never counted (they are counted in returnsCount).
 *                         [T4h fix] The count is EVENT-DATED exactly like
 *                         salesSYP: it is a function of rows created today and
 *                         nothing else, so a void issued TOMORROW can never
 *                         change today's already-displayed figure. A sale made
 *                         AND voided today therefore counts as one issued sale
 *                         AND one return — and salesSYP / returnsSYP now show
 *                         both sides of it instead of silently netting.
 *
 * outstandingDebtSYP    = SUM over active customers of computeBalanceSYP(
 *                         [SUM(invoice.debtAmountSYP)], [SUM(independent
 *                         payments)]) — the T4e ledger equation re-used from
 *                         lib/ledger/balance.ts, fed with per-customer totals
 *                         from two groupBy queries instead of every row.
 *
 * EVENT-DATE ACCOUNTING: a void counts on the day IT was created, not on the
 * day of the sale it reverses. Yesterday's report therefore never changes
 * after the day closes (the merchant may already have counted the till).
 * Voiding yesterday's sale today shows as today's RETURNS (and negative net
 * profit) — never as negative "sales".
 *
 * WINDOWS
 *   One window, `range` days (1, 7 or 30), ending today. The trend, the KPI
 *   "today" figures and the product rankings are all derived from that same
 *   set of rows, so they can never disagree.
 *   range = 1 ("today"): a one-point daily chart draws nothing, so the trend
 *   is bucketed BY LOCAL HOUR instead — hour 00 through the CURRENT local
 *   hour (future hours are omitted, never shown as a misleading drop to
 *   zero). `trendGranularity` tells the client which one it received.
 *   DAY BOUNDARIES use the tenant's local day: Syria is a fixed UTC+3
 *   (TENANT_TZ_OFFSET_HOURS). Tenant carries no timezone field, so this is a
 *   platform-wide constant — the market is Syria. A sale at 23:30 UTC belongs
 *   to the NEXT local day.
 *
 * PRODUCT RANKINGS [v4.8]: built from InvoiceItem.baseQuantity (the exact
 *   quantity deducted from the batch, in the product's BASE unit; negative on
 *   a void line) — never from the rounded sale-unit `quantity`.
 *     - quantity ranking = SUM(baseQuantity): already base-unit, no conversion.
 *     - revenue: rows of ONE sale line (same product, same sold unit, same
 *       price — a sale FIFO-split across batches) are collapsed first, then the
 *       summed base quantity is divided ONCE by the sold unit's factor
 *       (units.ts → saleQuantityFromBase) and multiplied by the unit price.
 *       A sale and its void collapse to exactly zero.
 *   Because voids are included (negative), product figures are NET of returns.
 *
 * ALERTS [T4h fix]: the batch alerts are two capped, separately COUNTED
 * database queries (lib/data/products.ts's listBatchAlertSets()). The
 * "expiring" boundary is exact — `expiryDate < start of the local day that is
 * EXPIRING_SOON_DAYS from today` — so the DB count and the displayed list use
 * the same definition; nothing is fetched just to be thrown away.
 *
 * KNOWN LIMIT: the invoice and invoiceItem reads cover the whole window
 * (up to 30 days) because per-day figures need row-level math that Prisma
 * cannot aggregate without raw SQL. Fine at small-merchant scale; the route
 * sets a short private Cache-Control to absorb repeated loads.
 *
 * LINT NOTE (eslint.config.mjs's BACKEND_ONLY_FILES block): this file may not
 * name `product`/`productUnit` as a select/include/where key or as a member
 * expression, nor read .baseUnit/.conversionFactor arithmetic. Product names,
 * unit factors and batch alerts come from small gateway helpers in
 * lib/data/products.ts; base-unit names from base-unit.ts's requireBaseUnits();
 * the sale-unit division from units.ts's saleQuantityFromBase().
 */

import type { InvoiceStatus } from "@prisma/client";
import type { TxOrClient } from "@/lib/db/tenant-scope";
import Decimal from "decimal.js";
import {
    UNKNOWN_PRODUCT_NAME,
    listBatchAlertSets,
    listProductNamesByIds,
    listUnitConversionFactors,
    type BatchAlertSets,
} from "@/lib/data/products";
import { requireBaseUnits } from "@/lib/inventory/base-unit";
import { saleQuantityFromBase } from "@/lib/inventory/units";
import {
    addLocalDays,
    localDayKey,
    startOfLocalDay,
    SYRIA_UTC_OFFSET_HOURS,
} from "@/lib/utils/syria-time";
// [T4e] THE single implementation of a customer balance — reused, never
// re-typed, exactly as app/api/customers/route.ts does.
import { computeBalanceSYP } from "@/lib/ledger/balance";
import {
    addMoney,
    compareMoney,
    multiplyMoney,
    subtractMoney,
} from "@/lib/utils/money";

/** The chart's window toggle. Anything else is rejected by the route. */
export type AnalyticsRange = 1 | 7 | 30;

/**
 * A Decimal column's shape as returned by Prisma — always reduced to a string
 * via toString(), the same discipline lib/data/invoices.ts uses.
 */
type DecimalLike = { toString(): string };

function dstr(v: DecimalLike): string {
    return v.toString();
}

/**
 * decimal.js's INSTANCE type. The `Decimal` default import names the VALUE
 * (the class), so it cannot appear in type position (TS2749) — mirror
 * lib/inventory/units.ts's own DecimalInstance alias.
 */
type DecimalInstance = InstanceType<typeof Decimal>;

export interface AnalyticsKpis {
    /**
     * Today's GROSS sales, SYP — every non-VOIDED invoice created today. A
     * void never reduces this (see returnsSYP).
     */
    salesSYP: string;
    /**
     * [v4.9] Sum of each non-void invoice's own frozen-rate USD figure — never
     * re-converted. Null when no rated sale exists today (null-rate invoices
     * contribute nothing, never today's rate).
     */
    salesUSD: string | null;
    /** [v4.8] Today's returns/cancellations, SYP — a POSITIVE number (|Σ void totals|). */
    returnsSYP: string;
    /** [v4.8] Number of void rows created today. */
    returnsCount: number;
    /** [v4.8] salesSYP − returnsSYP. */
    netSalesSYP: string;
    /** [v4.8] Profit on today's non-void sales: Σ totalSYP − Σ costAmountSYP. */
    grossProfitSYP: string;
    /** [v4.8] Profit given back by today's voids (≤ 0, the negation of the originals' profit). */
    returnsProfitSYP: string;
    /** Today's NET profit, SYP = grossProfitSYP + returnsProfitSYP. */
    netProfitSYP: string;
    /** COMPLETED invoices issued today (event-dated; see the definition above). */
    invoiceCount: number;
    /** T4e's ledger equation, summed across every active customer. */
    outstandingDebtSYP: string;
}

export type TrendGranularity = "hour" | "day";

export interface TrendPoint {
    /**
     * Bucket key in local (UTC+3) time: "YYYY-MM-DD" for a daily trend, or
     * "YYYY-MM-DDTHH" (hour 00–23) when `trendGranularity` is "hour".
     */
    date: string;
    /** [v4.8] GROSS sales in the bucket (non-void rows). */
    salesSYP: string;
    /** [v4.8] Returns in the bucket — a POSITIVE number. */
    returnsSYP: string;
    /** NET profit in the bucket (Σ totalSYP − Σ costAmountSYP over every row). */
    profitSYP: string;
}

export interface ProductAggregate {
    productId: string;
    productName: string;
    /** Net revenue over the window (voids included, so returns are subtracted). */
    salesSYP: string;
    /** SUM(baseQuantity) over the window — already in the product's BASE unit. */
    quantity: string;
    /** Name of the base unit `quantity` is expressed in ("" if it could not be resolved). */
    baseUnitName: string;
    /** salesSYP − Σ costAmountSYP over the window. */
    profitSYP: string;
}

export interface NeedsReconciliationAlert {
    productId: string;
    productName: string;
    batchId: string;
    batchNumber: string;
    quantity: string;
    unitName: string;
}

export interface ExpiringSoonAlert {
    productId: string;
    productName: string;
    batchId: string;
    batchNumber: string;
    /** ISO string. */
    expiryDate: string;
    /** Calendar days from today (local) to the expiry day; negative = already expired. */
    daysToExpiry: number;
    /** True when the batch is ALREADY expired (daysToExpiry < 0) and still has stock. */
    isExpired: boolean;
    quantity: string;
    unitName: string;
}

export interface LargeBalanceAlert {
    customerId: string;
    customerName: string;
    balanceSYP: string;
}

/** `count` is the FULL number of matches; `items` is capped at the limit. */
export interface AlertList<T> {
    count: number;
    items: T[];
}

export interface AnalyticsDashboard {
    range: AnalyticsRange;
    /** The `now` this payload was computed against (ISO) — echoed for tests/caching. */
    generatedAt: string;
    /** "hour" only for range 1 (today); "day" for 7 and 30. */
    trendGranularity: TrendGranularity;
    /** Tenant's current daily rate, as a Decimal string. null when unset (informational only). */
    exchangeRate: string | null;
    kpis: AnalyticsKpis;
    /** Exactly `range` buckets, oldest → newest, ending today (local day). */
    trend: TrendPoint[];
    topProducts: {
        bySalesValue: ProductAggregate[];
        byQuantity: ProductAggregate[];
        byProfit: ProductAggregate[];
    };
    alerts: {
        needsReconciliation: AlertList<NeedsReconciliationAlert>;
        expiringSoon: AlertList<ExpiringSoonAlert>;
        largeBalances: AlertList<LargeBalanceAlert>;
    };
}

/** The longest window the chart can show (the 30-day toggle). */
export const WINDOW_DAYS = 30;

/**
 * "Nearing expiry" horizon in days. Deliberately IDENTICAL to T3c's
 * `expiring` filter in app/api/inventory/products/route.ts
 * (`if (daysToExpiry < 60)`), so an item that shows up here is the same item
 * T3c flags on the inventory screen.
 */
export const EXPIRING_SOON_DAYS = 60;

/** Every alert list is "a short list" (T4h §4) — the full count travels alongside. */
export const ALERT_LIST_LIMIT = 5;

/** Top-N for each of the two product lists (T4h §3). */
export const TOP_PRODUCT_LIMIT = 5;

/**
 * Syria's fixed offset (UTC+3 year-round since 2022). A platform-wide constant
 * because Tenant has no timezone field. The DAY MATH itself is deliberately
 * NOT re-implemented here: every local-calendar operation below delegates to
 * lib/utils/syria-time.ts — the ONE definition of Syria's calendar, shared by
 * the sales-log filters and this dashboard — with only the constant
 * re-exported under its T4h-era name for existing importers.
 */
export {
    SYRIA_UTC_OFFSET_HOURS as TENANT_TZ_OFFSET_HOURS,
    localDayKey,
    startOfLocalDay,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Local (Syria) hour 0–23 of `instant`. Fixed offset → plain arithmetic. */
function localHour(instant: Date): number {
    return Math.floor((instant.getTime() - startOfLocalDay(instant).getTime()) / HOUR_MS);
}

/** "YYYY-MM-DDTHH" — the hourly bucket key (local time). */
function hourBucketKey(instant: Date): string {
    return `${localDayKey(instant)}T${String(localHour(instant)).padStart(2, "0")}`;
}

/**
 * Calendar days from `now`'s local day to `target`'s local day. Negative when
 * `target` is on an earlier local day — so a batch that expired two hours ago
 * (same local day) is 0 and a batch that expired yesterday is -1, never a
 * fractional or "-0" value.
 */
function calendarDaysUntil(target: Date, now: Date): number {
    return Math.round(
        (startOfLocalDay(target).getTime() - startOfLocalDay(now).getTime()) / DAY_MS
    );
}

// === PURE HELPERS (exported — unit-testable with no database at all) ===

/**
 * @deprecated [v4.8] No longer used by this module. It multiplies by the
 * ROUNDED sale-unit `quantity`, which drifts for FIFO-split sales (a 3-way
 * split: 0.3333 × 3 = 0.9999). Profit is now Σ totalSYP − Σ costAmountSYP at
 * invoice level, and product revenue is built from baseQuantity. Kept only so
 * existing imports still compile; delete it with its tests when convenient.
 */
export function lineProfitSYP(
    unitPriceSYP: DecimalLike,
    quantity: DecimalLike,
    costAmountSYP: DecimalLike
): string {
    const revenue = multiplyMoney(dstr(unitPriceSYP), dstr(quantity));
    return subtractMoney(revenue, dstr(costAmountSYP));
}

/**
 * Aggregate raw InvoiceItem rows (already windowed) into one row per product.
 *
 * [v4.8] Works from `baseQuantity` (exact, base unit, negative on a void line)
 * and NEVER from the rounded sale-unit `quantity`:
 *   1. Rows of one sale line — same product, same SOLD unit, same unit price,
 *      i.e. a sale that FIFO split across batches — are collapsed, summing
 *      baseQuantity and costAmountSYP.
 *   2. Each collapsed line's base total is divided ONCE by the sold unit's
 *      factor (units.ts → saleQuantityFromBase), then × unitPriceSYP gives its
 *      revenue (money.ts). A sale and its void collapse to exactly 0.
 *   3. Lines add up per product. `quantity` is simply Σ baseQuantity.
 *   profitSYP = revenue − Σ costAmountSYP.
 *
 * A line whose unit has no factor in the map is a data-integrity bug (units
 * are never hard-deleted; InvoiceItem.unit is Restrict) — it throws rather
 * than silently ranking on a wrong number.
 *
 * `nameById` supplies display names; an id with no surviving product falls
 * back to UNKNOWN_PRODUCT_NAME so one historical row can never break the
 * dashboard. `baseUnitName` is filled in later, for the products that
 * actually surface.
 */
export function buildProductAggregates(
    items: Array<{
        productId: string;
        unitId: string;
        baseQuantity: DecimalLike;
        unitPriceSYP: DecimalLike;
        costAmountSYP: DecimalLike;
    }>,
    nameById: Map<string, string>,
    factorByUnitId: Map<string, string>
): ProductAggregate[] {
    // Step 1 — collapse the rows of one sale line.
    const lines = new Map<
        string,
        {
            productId: string;
            unitId: string;
            unitPriceSYP: string;
            baseQuantity: DecimalInstance;
            cost: string;
        }
    >();

    for (const item of items) {
        const unitPriceSYP = dstr(item.unitPriceSYP);
        const key = `${item.productId}|${item.unitId}|${unitPriceSYP}`;
        const line =
            lines.get(key) ??
            {
                productId: item.productId,
                unitId: item.unitId,
                unitPriceSYP,
                baseQuantity: new Decimal(0),
                cost: "0.0000",
            };
        line.baseQuantity = line.baseQuantity.plus(new Decimal(dstr(item.baseQuantity)));
        line.cost = addMoney(line.cost, dstr(item.costAmountSYP));
        lines.set(key, line);
    }

    // Steps 2 + 3 — revenue per collapsed line, then per product.
    const acc = new Map<
        string,
        { sales: string; cost: string; baseQuantity: DecimalInstance }
    >();

    for (const line of lines.values()) {
        const factor = factorByUnitId.get(line.unitId);
        if (factor === undefined) {
            throw new Error(
                `Analytics: no conversion factor found for unit ${line.unitId} ` +
                `(product ${line.productId}) — data-integrity problem.`
            );
        }

        const { saleQuantity } = saleQuantityFromBase([line.baseQuantity], factor);
        const revenue = multiplyMoney(line.unitPriceSYP, saleQuantity);

        const entry =
            acc.get(line.productId) ??
            { sales: "0.0000", cost: "0.0000", baseQuantity: new Decimal(0) };
        entry.sales = addMoney(entry.sales, revenue);
        entry.cost = addMoney(entry.cost, line.cost);
        entry.baseQuantity = entry.baseQuantity.plus(line.baseQuantity);
        acc.set(line.productId, entry);
    }

    const aggregates: ProductAggregate[] = [];
    for (const [productId, entry] of acc) {
        aggregates.push({
            productId,
            productName: nameById.get(productId) ?? UNKNOWN_PRODUCT_NAME,
            salesSYP: entry.sales,
            quantity: entry.baseQuantity.toFixed(4),
            baseUnitName: "",
            profitSYP: subtractMoney(entry.sales, entry.cost),
        });
    }
    return aggregates;
}

/** Shared descending sort: metric first, productId as a stable tie-break. */
function rank(
    aggregates: ProductAggregate[],
    metric: (a: ProductAggregate) => string,
    limit: number
): ProductAggregate[] {
    return [...aggregates]
        .sort((a, b) => {
            const cmp = compareMoney(metric(b), metric(a));
            if (cmp !== 0) return cmp;
            if (a.productId < b.productId) return -1;
            if (a.productId > b.productId) return 1;
            return 0;
        })
        .slice(0, limit);
}

/** Top-sellers by TOTAL SALES VALUE (SYP) — net of returns. */
export function rankTopBySalesValue(
    aggregates: ProductAggregate[],
    limit: number = TOP_PRODUCT_LIMIT
): ProductAggregate[] {
    return rank(aggregates, (a) => a.salesSYP, limit);
}

/** Top-sellers by QUANTITY SOLD, in BASE units — independent of price. */
export function rankTopByQuantity(
    aggregates: ProductAggregate[],
    limit: number = TOP_PRODUCT_LIMIT
): ProductAggregate[] {
    return rank(aggregates, (a) => a.quantity, limit);
}

/** Most profitable — net revenue minus frozen cost. */
export function rankTopByProfit(
    aggregates: ProductAggregate[],
    limit: number = TOP_PRODUCT_LIMIT
): ProductAggregate[] {
    return rank(aggregates, (a) => a.profitSYP, limit);
}

// === RAW ROW SHAPES (the `select`s the queries below narrow to) ===

interface RawInvoiceRow {
    totalSYP: DecimalLike;
    // [v4.9] Nullable — null for SYP-only sales with no frozen rate.
    totalUSD: DecimalLike | null;
    status: InvoiceStatus;
    createdAt: Date;
}

interface RawItemRow {
    productId: string;
    unitId: string;
    /** [v4.8] Exact base-unit quantity deducted from the batch (negative on a void line). */
    baseQuantity: DecimalLike;
    unitPriceSYP: DecimalLike;
    costAmountSYP: DecimalLike;
    invoice: { createdAt: Date; status: InvoiceStatus };
}

interface RawActiveCustomerRow {
    id: string;
    name: string;
}

interface RawDebtGroupRow {
    customerId: string;
    _sum: { debtAmountSYP: DecimalLike | null };
}

interface RawRepaymentGroupRow {
    customerId: string;
    _sum: { amountSYP: DecimalLike | null };
}

/**
 * WHY THIS EXISTS — lib/db/tenant-scope's client extension types each
 * delegate's `groupBy` as a UNION of generic overloads whose mutual
 * incompatibility makes a direct call fail to compile (TS2349: "none of the
 * signatures are compatible with each other"), even though the argument object
 * itself is perfectly valid. Narrowing the method to a single non-generic
 * signature BEFORE invoking it is the standard workaround; the awaited row
 * shape stays pinned by RawDebtGroupRow / RawRepaymentGroupRow above, so
 * nothing about the runtime query changes.
 */
function callGroupBy(groupFn: unknown, args: unknown): Promise<unknown> {
    return (groupFn as (a: unknown) => Promise<unknown>)(args);
}

export interface AnalyticsOptions {
    range: AnalyticsRange;
    /** Injected so tests are deterministic; the route passes `new Date()`. */
    now: Date;
}

export async function getAnalyticsDashboard(
    db: TxOrClient,
    tenantId: string,
    options: AnalyticsOptions
): Promise<AnalyticsDashboard> {
    const { range, now } = options;

    const todayStart = startOfLocalDay(now);
    const windowEnd = addLocalDays(todayStart, 1);
    const windowStart = addLocalDays(todayStart, -(range - 1));
    const todayKey = localDayKey(todayStart);

    // EXACT expiry boundary: a batch has "fewer than EXPIRING_SOON_DAYS days to
    // go" (calendarDaysUntil < N) if and only if its expiry instant is strictly
    // before the local start-of-day N days from today. The DB filter and the
    // displayed definition are therefore the same thing — no padding, no
    // second app-side re-check.
    const expiringBefore = addLocalDays(todayStart, EXPIRING_SOON_DAYS);

    // Independent reads, one batch. Every `where` carries an explicit
    // `tenantId` as well as relying on the extension. No raw SQL.
    const [invoices, items, activeCustomers, debtGroups, repaymentGroups, tenant, alertSets] =
        await Promise.all([
            db.invoice.findMany({
                where: { tenantId, createdAt: { gte: windowStart, lt: windowEnd } },
                select: {
                    totalSYP: true,
                    totalUSD: true,
                    status: true,
                    createdAt: true,
                },
            }) as Promise<RawInvoiceRow[]>,

            db.invoiceItem.findMany({
                where: {
                    tenantId,
                    invoice: { createdAt: { gte: windowStart, lt: windowEnd } },
                },
                select: {
                    productId: true,
                    unitId: true,
                    // [v4.8] baseQuantity, NOT quantity — see the header.
                    baseQuantity: true,
                    unitPriceSYP: true,
                    costAmountSYP: true,
                    invoice: { select: { createdAt: true, status: true } },
                },
            }) as Promise<RawItemRow[]>,

            db.customer.findMany({
                where: { tenantId, isActive: true },
                select: { id: true, name: true },
            }) as Promise<RawActiveCustomerRow[]>,

            // Per-customer SUM of debtAmountSYP across EVERY invoice status
            // (void mirrors are negative, so reversals net out) — what T4e's
            // balance equation consumes, without loading every invoice row.
            callGroupBy(db.invoice.groupBy, {
                by: ["customerId"],
                where: { tenantId },
                _sum: { debtAmountSYP: true },
            }) as Promise<RawDebtGroupRow[]>,

            // Only INDEPENDENT repayments count against a balance — an
            // invoiceId-having payment is already inside that invoice's own
            // debtAmountSYP (T4e's rule).
            callGroupBy(db.customerPayment.groupBy, {
                by: ["customerId"],
                where: { tenantId, invoiceId: null },
                _sum: { amountSYP: true },
            }) as Promise<RawRepaymentGroupRow[]>,

            db.tenant.findUnique({
                where: { id: tenantId },
                select: { dailyExchangeRate: true },
            }),

            listBatchAlertSets(db, tenantId, {
                expiringBefore,
                limit: ALERT_LIST_LIMIT,
            }),
        ]);

    // Names + unit factors only for what the window actually sold.
    const productIds = Array.from(new Set(items.map((i) => i.productId)));
    const unitIds = Array.from(new Set(items.map((i) => i.unitId)));
    const [nameById, factorByUnitId] = await Promise.all([
        listProductNamesByIds(db, tenantId, productIds),
        listUnitConversionFactors(db, tenantId, unitIds),
    ]);

    // === TODAY'S KPIs ===
    // [v4.8] Sales and returns are accumulated SEPARATELY from the same rows.
    let todaySalesSYP = "0.0000";
    // Σ of VOIDED totals — NEGATIVE (a void row carries negated money). Turned
    // into the positive `returnsSYP` figure below.
    let todayReturnsRawSYP = "0.0000";
    // [v4.9] Null-rate invoices contribute nothing to USD aggregates and are
    // never converted using today's rate. Null until a rated sale appears.
    let todaySalesUSD: string | null = null;
    let invoiceCount = 0;
    let returnsCount = 0;
    for (const inv of invoices) {
        if (localDayKey(inv.createdAt) !== todayKey) continue;
        if (inv.status === "VOIDED") {
            todayReturnsRawSYP = addMoney(todayReturnsRawSYP, dstr(inv.totalSYP));
            returnsCount += 1;
            continue;
        }
        todaySalesSYP = addMoney(todaySalesSYP, dstr(inv.totalSYP));
        if (inv.totalUSD !== null) {
            todaySalesUSD = addMoney(todaySalesUSD ?? "0.0000", dstr(inv.totalUSD));
        }
        // The COUNT is event-dated: COMPLETED rows created today, independent
        // of any later void.
        if (inv.status === "COMPLETED") invoiceCount += 1;
    }

    // === TREND ===
    // range 1 → hourly buckets 00..current local hour; otherwise exactly
    // `range` local days, oldest → newest, ending today.
    const trendGranularity: TrendGranularity = range === 1 ? "hour" : "day";
    const bucketOf = (instant: Date): string =>
        trendGranularity === "hour" ? hourBucketKey(instant) : localDayKey(instant);

    const trendKeys: string[] = [];
    if (trendGranularity === "hour") {
        const lastHour = localHour(now);
        for (let h = 0; h <= lastHour; h++) {
            trendKeys.push(`${todayKey}T${String(h).padStart(2, "0")}`);
        }
    } else {
        for (let i = range - 1; i >= 0; i--) {
            trendKeys.push(localDayKey(addLocalDays(todayStart, -i)));
        }
    }

    const salesByBucket = new Map<string, string>(trendKeys.map((k) => [k, "0.0000"]));
    // Σ of VOIDED totals per bucket — negative; shown to the client as positive.
    const returnsRawByBucket = new Map<string, string>(trendKeys.map((k) => [k, "0.0000"]));
    // Σ costAmountSYP of EVERY item per bucket (void lines are negative).
    const costByBucket = new Map<string, string>(trendKeys.map((k) => [k, "0.0000"]));

    for (const inv of invoices) {
        const key = bucketOf(inv.createdAt);
        const target = inv.status === "VOIDED" ? returnsRawByBucket : salesByBucket;
        const prev = target.get(key);
        if (prev === undefined) continue;
        target.set(key, addMoney(prev, dstr(inv.totalSYP)));
    }

    // [v4.8] Profit is invoice-level: Σ totalSYP − Σ costAmountSYP. Costs are
    // split by void/non-void ONLY for today's gross-vs-returns profit split.
    let todayGrossCostSYP = "0.0000";
    let todayReturnsCostSYP = "0.0000";
    for (const item of items) {
        const cost = dstr(item.costAmountSYP);

        const key = bucketOf(item.invoice.createdAt);
        const prev = costByBucket.get(key);
        if (prev !== undefined) costByBucket.set(key, addMoney(prev, cost));

        // The KPI is always the whole local DAY, whatever the trend granularity.
        if (localDayKey(item.invoice.createdAt) === todayKey) {
            if (item.invoice.status === "VOIDED") {
                todayReturnsCostSYP = addMoney(todayReturnsCostSYP, cost);
            } else {
                todayGrossCostSYP = addMoney(todayGrossCostSYP, cost);
            }
        }
    }

    const todayGrossProfitSYP = subtractMoney(todaySalesSYP, todayGrossCostSYP);
    // returnsRaw (negative total) − returnsCost (negative cost) = the negated
    // profit of the reversed sales, e.g. −3550 − (−3480) = −70.
    const todayReturnsProfitSYP = subtractMoney(todayReturnsRawSYP, todayReturnsCostSYP);
    const todayNetProfitSYP = addMoney(todayGrossProfitSYP, todayReturnsProfitSYP);

    // Today's KPI figures and the trend's buckets come from the SAME rows and
    // the SAME arithmetic, so a KPI card and the chart cannot disagree.
    const trend: TrendPoint[] = trendKeys.map((date) => {
        const sales = salesByBucket.get(date)!;
        const returnsRaw = returnsRawByBucket.get(date)!;
        const cost = costByBucket.get(date)!;
        return {
            date,
            salesSYP: sales,
            returnsSYP: subtractMoney("0.0000", returnsRaw),
            profitSYP: subtractMoney(addMoney(sales, returnsRaw), cost),
        };
    });

    // === TOP PRODUCTS (same window as the chart's selected range) ===
    const aggregates = buildProductAggregates(items, nameById, factorByUnitId);
    const bySalesValue = rankTopBySalesValue(aggregates);
    const byQuantity = rankTopByQuantity(aggregates);
    const byProfit = rankTopByProfit(aggregates);

    // Base-unit NAMES, only for the (≤ 15) products that actually surface. A
    // label is not money: if one product's base unit cannot be resolved, show
    // the figure without a unit name rather than failing the whole dashboard —
    // but LOG it, since a missing base unit is a data-integrity bug that must
    // not disappear silently.
    const surfacedIds = Array.from(
        new Set([...bySalesValue, ...byQuantity, ...byProfit].map((a) => a.productId))
    );
    const baseUnitNameByProduct = new Map<string, string>();
    try {
        const baseUnits = await requireBaseUnits(db, tenantId, surfacedIds);
        for (const [productId, unit] of baseUnits) {
            baseUnitNameByProduct.set(productId, unit.unitName);
        }
    } catch (error) {
        console.warn(
            "Analytics: could not resolve base-unit names; showing figures without a unit label.",
            { tenantId, error }
        );
    }
    const withUnitName = (list: ProductAggregate[]): ProductAggregate[] =>
        list.map((a) => ({ ...a, baseUnitName: baseUnitNameByProduct.get(a.productId) ?? "" }));

    // === CUSTOMER BALANCES (T4e's equation, per active customer) ===
    const debtByCustomer = new Map<string, string>();
    for (const g of debtGroups) {
        debtByCustomer.set(g.customerId, g._sum.debtAmountSYP ? dstr(g._sum.debtAmountSYP) : "0");
    }
    const repaidByCustomer = new Map<string, string>();
    for (const g of repaymentGroups) {
        repaidByCustomer.set(g.customerId, g._sum.amountSYP ? dstr(g._sum.amountSYP) : "0");
    }

    // Both outputs (the KPI total and the ranking) derive from these SAME
    // per-customer figures, so the alert and the KPI card cannot drift.
    const balances: LargeBalanceAlert[] = [];
    let outstandingDebtSYP = "0.0000";
    for (const c of activeCustomers) {
        const balanceSYP = computeBalanceSYP(
            [debtByCustomer.get(c.id) ?? "0"],
            [repaidByCustomer.get(c.id) ?? "0"]
        );
        outstandingDebtSYP = addMoney(outstandingDebtSYP, balanceSYP);
        // Only a POSITIVE balance is a "large balance" — a customer who has
        // overpaid is not listed.
        if (compareMoney(balanceSYP, 0) > 0) {
            balances.push({ customerId: c.id, customerName: c.name, balanceSYP });
        }
    }
    balances.sort((a, b) => {
        const cmp = compareMoney(b.balanceSYP, a.balanceSYP);
        if (cmp !== 0) return cmp;
        if (a.customerId < b.customerId) return -1;
        if (a.customerId > b.customerId) return 1;
        return 0;
    });

    // Informational only — every USD figure above is a stored per-invoice
    // value; this is just the tenant's current rate for display next to them.
    const rateRaw =
        tenant?.dailyExchangeRate != null ? dstr(tenant.dailyExchangeRate) : null;
    const hasValidRate = rateRaw !== null && compareMoney(rateRaw, 0) > 0;

    return {
        range,
        generatedAt: now.toISOString(),
        trendGranularity,
        exchangeRate: hasValidRate ? rateRaw : null,
        kpis: {
            salesSYP: todaySalesSYP,
            salesUSD: todaySalesUSD,
            returnsSYP: subtractMoney("0.0000", todayReturnsRawSYP),
            returnsCount,
            netSalesSYP: addMoney(todaySalesSYP, todayReturnsRawSYP),
            grossProfitSYP: todayGrossProfitSYP,
            returnsProfitSYP: todayReturnsProfitSYP,
            netProfitSYP: todayNetProfitSYP,
            invoiceCount,
            outstandingDebtSYP,
        },
        trend,
        topProducts: {
            bySalesValue: withUnitName(bySalesValue),
            byQuantity: withUnitName(byQuantity),
            byProfit: withUnitName(byProfit),
        },
        alerts: buildAlerts(alertSets, balances, now),
    };
}

/**
 * NOTE — on the balance ranking: schema.prisma records NO payment deadline or
 * amortization schedule for a customer balance (the ledger stores only
 * debtAmountSYP and a flat repayment trail). The balance alert therefore ranks
 * by net balance alone and computes no late-payment status anywhere.
 *
 * Batch alerts use the same definitions as T3c's inventory filters:
 * `needs_reconciliation` = negative quantity; `expiring` = fewer than
 * EXPIRING_SOON_DAYS to go (an already-expired batch with stock is the
 * extreme case of that, flagged `isExpired`). Selection, ordering, the cap and
 * the exact COUNT were all done in the database by listBatchAlertSets(); this
 * function only reshapes the rows and derives the display-only
 * `daysToExpiry`.
 */
function buildAlerts(
    alertSets: BatchAlertSets,
    balances: LargeBalanceAlert[],
    now: Date
): AnalyticsDashboard["alerts"] {
    const needsReconciliation: NeedsReconciliationAlert[] =
        alertSets.needsReconciliation.rows.map((b) => ({
            productId: b.productId,
            productName: b.productName,
            batchId: b.id,
            batchNumber: b.batchNumber,
            quantity: b.quantity,
            unitName: b.unitName,
        }));

    const expiringSoon: ExpiringSoonAlert[] = [];
    for (const b of alertSets.expiringSoon.rows) {
        // The DB filter guarantees a non-null expiryDate; this only narrows the type.
        if (!b.expiryDate) continue;
        const daysToExpiry = calendarDaysUntil(b.expiryDate, now);
        expiringSoon.push({
            productId: b.productId,
            productName: b.productName,
            batchId: b.id,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate.toISOString(),
            daysToExpiry,
            isExpired: daysToExpiry < 0,
            quantity: b.quantity,
            unitName: b.unitName,
        });
    }

    // Most-under first — the worst discrepancy is the one to reconcile first.
    // (Already DB-ordered; kept so the Arabic name tie-break is deterministic.)
    needsReconciliation.sort((a, b) => {
        const cmp = compareMoney(a.quantity, b.quantity);
        if (cmp !== 0) return cmp;
        return a.productName.localeCompare(b.productName, "ar");
    });
    // Soonest-expiring first (already-expired batches sort to the top).
    expiringSoon.sort((a, b) => {
        if (a.daysToExpiry !== b.daysToExpiry) return a.daysToExpiry - b.daysToExpiry;
        return a.productName.localeCompare(b.productName, "ar");
    });

    return {
        needsReconciliation: {
            count: alertSets.needsReconciliation.count,
            items: needsReconciliation,
        },
        expiringSoon: {
            count: alertSets.expiringSoon.count,
            items: expiringSoon,
        },
        // `balances` is already ranked descending and holds only customers with
        // a positive net balance.
        largeBalances: {
            count: balances.length,
            items: balances.slice(0, ALERT_LIST_LIMIT),
        },
    };
}