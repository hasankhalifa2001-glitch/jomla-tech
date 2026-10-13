/**
 * lib/data/store.ts
 *
 * T5a — the PUBLIC, no-login B2B storefront data gateway + the rate-limited
 * order-submission write path. There is NO session on a storefront visit: the
 * incoming `[tenantSlug]` IS the only tenant identifier, resolved to a real
 * Tenant row first (below), and every subsequent tenant-scoped read goes
 * through getTenantDb(tenantId) like any other gateway.
 *
 * ── ISOLATION POSTURE (lib/db.ts category 6) ────────────────────────────────
 * The ONE unscoped `prisma` call in this file is the tenant-by-slug resolution
 * (resolveStorefrontTenant). It carries a single inline
 * `eslint-disable-next-line no-restricted-imports` with a justification,
 * exactly as lib/db.ts prescribes — a public visitor has no tenantId until the
 * slug is resolved, so that lookup is unscoped by definition. EVERY other
 * read/write here uses getTenantDb(tenantId) (or a transaction client derived
 * from it). No $queryRaw. No nested writes.
 *
 * ── MODEL ACCESS ────────────────────────────────────────────────────────────
 * `product`/`productUnit` access is banned outside lib/data/products.ts
 * (eslint PRODUCT_MODEL_RULES); this file imports that gateway's storefront
 * helpers instead (spec §5.8 decision (b) — NO eslint.config.mjs change).
 * `productBatch` (stock), `invoiceItem` (best sellers), `b2BOrderRequest`,
 * `b2BOrderRequestItem`, `customer` and `verifiedRetailer` are NOT covered by
 * any model-level ESLint rule, so this file reads/writes them directly through
 * the tenant-scoped client.
 *
 * ── CACHING (spec §6.10) ────────────────────────────────────────────────────
 * Deployment is serverless (Vercel), so there are NO module-level in-memory
 * caches. The catalog and best-sellers reads use Next's Data Cache via
 * `unstable_cache` with a PER-TENANT key AND a per-tenant tag, revalidated on
 * a timer. The tenant gate (below) is a FRESH DB read that always runs BEFORE
 * any cache read, so a tenant that just became EXPIRED/PENDING never has its
 * catalog served from cache.
 *
 * NOTE: everything stored in the Data Cache is JSON-serialized, so cached
 * values must be JSON-safe (no Date, no Decimal). That is why CatalogListItem
 * carries `createdAt` as an ISO string.
 *
 * NOTE: nothing calls revalidateTag(storeCatalogTag(...)) yet, so a product
 * edit shows up within STORE_CATALOG_CACHE_SECONDS rather than instantly.
 * Wiring revalidateTag into the product-edit routes is a follow-up.
 */

import { unstable_cache } from "next/cache";
// eslint-disable-next-line no-restricted-imports -- T5a lib/db.ts category 6: the ONLY unscoped read in this file, the public storefront slug→tenant resolution (no session/tenantId exists yet).
import { prisma } from "@/lib/db";
import { getTenantDb } from "@/lib/db/tenant-scope";
import type { TxOrClient } from "@/lib/db/tenant-scope";
import { callGroupBy } from "@/lib/db/call-group-by";
import {
    STORE_BESTSELLERS_CACHE_SECONDS,
    STORE_BESTSELLERS_MIN_PRODUCTS,
    STORE_BESTSELLERS_WINDOW_DAYS,
    STORE_CATALOG_CACHE_SECONDS,
    STORE_DUPLICATE_SUBMIT_WINDOW_SECONDS,
    STORE_HOME_BESTSELLERS_COUNT,
    STORE_HOME_NEWEST_COUNT,
    STORE_PAGE_SIZE,
    STORE_UNCATEGORIZED_KEY,
} from "@/lib/config/storefront";
import {
    listProductNamesByIds,
    listStorefrontCatalogProducts,
    listStorefrontUnitsForProducts,
    listStorefrontProductHeaders,
    listUnitConversionFactors,
} from "@/lib/data/products";
import { buildProductAggregates, rankTopBySalesValue } from "@/lib/data/analytics";
import { addLocalDays, startOfLocalDay } from "@/lib/utils/syria-time";
import { orderReference } from "@/lib/utils/order-reference";
import { normalizeArabic, normalizeCategory } from "@/lib/utils/arabic-search";
import { breakdownForDisplay, type DisplayUnit } from "@/lib/inventory/units";
import { compareMoney, serializeMoney } from "@/lib/utils/money";

// ============================================================================
// Types
// ============================================================================

/** The public-facing tenant header (name, logo, phone) + the currency rate. */
export interface StorefrontTenant {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    phone: string | null;
    /** Current daily rate as a Decimal string, or null when unset/invalid. */
    dailyExchangeRate: string | null;
}

/** Result of resolving a slug: either a usable tenant row or a closed/404 store. */
export type TenantResolution =
    | { kind: "tenant"; tenant: StorefrontTenant }
    | { kind: "not_found" }
    | { kind: "unavailable" };

/** A light catalog row — what the search/filter/category surface works over. */
export interface CatalogListItem {
    id: string;
    name: string;
    category: string | null;
    /** ISO string: survives the Data Cache's JSON round-trip (a Date would not). */
    createdAt: string;
}

/** One category chip/card: the grouping key + the first-seen display spelling. */
export interface CategoryGroup {
    key: string;
    label: string;
    count: number;
}

/** A fully-hydrated product card, ready to render. */
export interface StorefrontCard {
    id: string;
    name: string;
    category: string | null;
    imageUrl: string | null;
    /** Active units with wholesale price (no retail, no cost, no barcode). */
    units: DisplayUnit[];
    /** Available base-unit quantity (D1/D2: positives only, expired included). */
    availableBaseQuantity: string;
    /** Per-unit display breakdown of `availableBaseQuantity` (via units.ts). */
    availability: Array<{ unitId: string; unitName: string; count: string }>;
    inStock: boolean;
}

/** One page of catalog results + the opaque cursor for the next page. */
export interface StorefrontPageResult {
    cards: StorefrontCard[];
    nextCursor: string | null;
}

// ============================================================================
// Tenant resolution & gate (spec §6.1) — ALWAYS a fresh DB read, never cached
// ============================================================================

/** Per-tenant Data-Cache tag, so a tenant's catalog can be invalidated alone. */
export function storeCatalogTag(tenantId: string): string {
    return `store-catalog:${tenantId}`;
}

/** Per-tenant Data-Cache tag for best sellers. */
export function storeBestsellersTag(tenantId: string): string {
    return `store-bestsellers:${tenantId}`;
}

/**
 * Resolve an incoming `[tenantSlug]` to a real Tenant row. This is the single
 * unscoped lookup permitted here (lib/db.ts category 6): a public visitor has
 * no tenantId until this resolves.
 *
 * Returns:
 *  - { kind: "tenant", tenant }      — known AND not EXPIRED/PENDING (open)
 *  - { kind: "unavailable" }         — known but EXPIRED/PENDING (D7: closed)
 *  - { kind: "not_found" }           — no such slug → the page renders 404
 *
 * The subscription check is the SAME "not EXPIRED/PENDING" rule
 * assertTenantWritable enforces (available ⟺ status === ACTIVE), read fresh
 * here every time. Never the JWT (there is none) and never a cached value, so
 * it can never serve a just-closed store.
 */
export async function resolveStorefrontTenant(
    slug: string
): Promise<TenantResolution> {
    if (!slug || typeof slug !== "string" || !slug.trim()) {
        return { kind: "not_found" };
    }

    // The single unscoped read permitted here — see the import's disable note.
    const row = await prisma.tenant.findUnique({
        where: { slug: slug.trim() },
        select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            phone: true,
            dailyExchangeRate: true,
            subscriptionStatus: true,
        },
    });

    if (!row) return { kind: "not_found" };

    if (row.subscriptionStatus !== "ACTIVE") {
        return { kind: "unavailable" };
    }

    return {
        kind: "tenant",
        tenant: {
            id: row.id,
            name: row.name,
            slug: row.slug,
            logo: row.logo,
            phone: row.phone,
            dailyExchangeRate: normalizeRate(row.dailyExchangeRate),
        },
    };
}

/**
 * Standalone fresh gate used by the API endpoints (products/orders) which are
 * keyed by slug in the body/query rather than by a resolved row. Returns the
 * tenant when open, or null when the slug is unknown or the store is closed —
 * the caller maps that to 404 vs 403 STORE_UNAVAILABLE. Fresh DB read, never
 * cached (§6.10 order: gate before any cache read).
 */
export async function assertStorefrontOpen(
    slug: string
): Promise<StorefrontTenant | null> {
    const resolution = await resolveStorefrontTenant(slug);
    return resolution.kind === "tenant" ? resolution.tenant : null;
}

/**
 * A Decimal-string rate that is usable (> 0), else null. The comparison goes
 * through money.ts (decimal.js) — no native-number arithmetic. A malformed
 * value is treated as "no rate" rather than failing the whole storefront.
 */
function normalizeRate(value: unknown): string | null {
    if (value == null) return null;
    const str =
        typeof value === "string"
            ? value
            : (value as { toString(): string })?.toString?.() ?? String(value);
    if (!str || !str.trim()) return null;
    try {
        return compareMoney(str, 0) > 0 ? str : null;
    } catch {
        return null;
    }
}

// ============================================================================
// Catalog read gateway (spec §6.2–§6.5)
// ============================================================================

/**
 * The light catalog list (id/name/category/createdAt), CACHED per tenant via
 * Next's Data Cache. This is the surface the server-side search, category
 * filter and pagination all run over — the storefront never loads the full
 * hydrated catalog. Cache key + tag both include tenantId; revalidate is the
 * owner-tunable STORE_CATALOG_CACHE_SECONDS.
 *
 * LIMITATION (documented per spec §6.4): the list is loaded whole and
 * filtered/sorted IN THE APPLICATION (arabic-search.ts — the DB cannot fold
 * Arabic and raw SQL is forbidden). This is designed for up to a few thousand
 * products per tenant; beyond that it should move to a search index. The
 * tenant gate runs before this is ever read (see the callers), so a closed
 * tenant never gets a cached catalog.
 */
export function loadStorefrontCatalog(tenantId: string): Promise<CatalogListItem[]> {
    return unstable_cache(
        async () => {
            const db = getTenantDb(tenantId);
            const rows = await listStorefrontCatalogProducts(db, tenantId);
            return rows.map((r) => ({
                id: r.id,
                name: r.name,
                category: r.category,
                // ISO string, not Date: the Data Cache JSON-serializes values.
                createdAt: r.createdAt.toISOString(),
            }));
        },
        ["storefront-catalog", tenantId],
        {
            tags: [storeCatalogTag(tenantId)],
            revalidate: STORE_CATALOG_CACHE_SECONDS,
        }
    )();
}

/**
 * Distinct categories of listable products, as chips/cards (spec §6.3.3).
 * Grouping key = normalizeCategory; display = first-seen original spelling.
 * Products with NO category (normalizeCategory → "") map to
 * STORE_UNCATEGORIZED_KEY and are displayed as "أخرى". A real category
 * literally named "أخرى" is its own group and never collides with __none__.
 */
export async function getStorefrontCategories(
    tenantId: string
): Promise<CategoryGroup[]> {
    const list = await loadStorefrontCatalog(tenantId);
    const groups = new Map<string, { label: string; count: number }>();

    for (const item of list) {
        const key = normalizeCategory(item.category);
        const groupKey = key === "" ? STORE_UNCATEGORIZED_KEY : key;
        const existing = groups.get(groupKey);
        if (existing) {
            existing.count += 1;
        } else {
            groups.set(groupKey, {
                label:
                    groupKey === STORE_UNCATEGORIZED_KEY
                        ? "أخرى"
                        : (item.category ?? "أخرى").trim() || "أخرى",
                count: 1,
            });
        }
    }

    // Uncategorized last, everything else in first-seen order (Map preserves it).
    const ordered = [...groups.entries()].map(([key, v]) => ({
        key,
        label: v.label,
        count: v.count,
    }));
    ordered.sort((a, b) => {
        if (a.key === STORE_UNCATEGORIZED_KEY) return 1;
        if (b.key === STORE_UNCATEGORIZED_KEY) return -1;
        return 0;
    });
    return ordered;
}

/** The newest STORE_HOME_NEWEST_COUNT listable product ids (spec §6.3.4). */
export async function getStorefrontNewestIds(
    tenantId: string
): Promise<string[]> {
    const list = await loadStorefrontCatalog(tenantId);
    // The light list is already ordered createdAt desc, id desc.
    return list.slice(0, STORE_HOME_NEWEST_COUNT).map((p) => p.id);
}

// ============================================================================
// Best sellers (spec §6.6) — "الأكثر مبيعاً"
//
// Ranking metric = net sales value in SYP over the last
// STORE_BESTSELLERS_WINDOW_DAYS Syrian business days, net of voids, built by
// REUSING the analytics aggregation core (buildProductAggregates — never
// copied): baseQuantity only (never the rounded sale-unit `quantity`),
// split-batch lines collapsed before pricing, a sale + its void nets to
// exactly zero. USD-priced and SYP-priced products rank on the same SYP
// basis because every InvoiceItem carries its own frozen unitPriceSYP.
//
// The public payload is the ranked product ids ONLY — hydration into cards
// (via hydrateStorefrontCards) carries no sales figures, counts or revenue.
// Fewer than STORE_BESTSELLERS_MIN_PRODUCTS qualifying products → [] (the
// caller omits the section). Cached per tenant for
// STORE_BESTSELLERS_CACHE_SECONDS under store-bestsellers:<tenantId>; the
// caller runs the tenant gate BEFORE this is ever read (§6.1/§6.10), so a
// closed tenant never gets a cached ranking.
//
// This is the only public read of InvoiceItem. It needs NO eslint.config.mjs
// change: no model-level rule bans invoiceItem access (the ban family covers
// product/productUnit and the two barcode models only), and every
// product/productUnit touch here goes through lib/data/products.ts gateway
// helpers (listProductNamesByIds / listUnitConversionFactors /
// listStorefrontProductHeaders), exactly as the rest of this file does.
// ============================================================================

type BestSellerItemRow = {
    productId: string;
    unitId: string;
    baseQuantity: { toString(): string };
    unitPriceSYP: { toString(): string };
    costAmountSYP: { toString(): string };
};

/**
 * The ranked best-seller product ids (up to STORE_HOME_BESTSELLERS_COUNT),
 * or [] when there is not enough data. `now` is injected so tests are
 * deterministic; production callers pass `new Date()`.
 */
export async function getStorefrontBestSellerIds(
    tenantId: string,
    now: Date = new Date()
): Promise<string[]> {
    return unstable_cache(
        async () => {
            const db = getTenantDb(tenantId);
            const todayStart = startOfLocalDay(now);
            const windowEnd = addLocalDays(todayStart, 1);
            const windowStart = addLocalDays(todayStart, -(STORE_BESTSELLERS_WINDOW_DAYS - 1));

            // Same row shape analytics.ts reads: baseQuantity (exact, negative
            // on a void line), unitPriceSYP per sold unit, costAmountSYP.
            // The rounded sale-unit `quantity` is deliberately NOT selected.
            const items = (await db.invoiceItem.findMany({
                where: {
                    tenantId,
                    invoice: { createdAt: { gte: windowStart, lt: windowEnd } },
                },
                select: {
                    productId: true,
                    unitId: true,
                    baseQuantity: true,
                    unitPriceSYP: true,
                    costAmountSYP: true,
                },
            })) as BestSellerItemRow[];

            if (items.length === 0) return [];

            const productIds = [...new Set(items.map((i) => i.productId))];
            const unitIds = [...new Set(items.map((i) => i.unitId))];
            const [nameById, factorByUnitId] = await Promise.all([
                listProductNamesByIds(db, tenantId, productIds),
                listUnitConversionFactors(db, tenantId, unitIds),
            ]);

            // REUSED core: collapses FIFO-split lines, nets voids to zero.
            const aggregates = buildProductAggregates(items, nameById, factorByUnitId);

            // Non-listable products (unpublished / inactive / no image / no
            // active unit) are excluded — best sellers must never surface a
            // product the catalog would not show.
            const headers = await listStorefrontProductHeaders(
                db,
                tenantId,
                aggregates.map((a) => a.productId)
            );

            const ranked = rankTopBySalesValue(aggregates, STORE_HOME_BESTSELLERS_COUNT);
            const qualifying = ranked.filter((a) => {
                if (!headers.has(a.productId)) return false;
                try {
                    // Net value ≤ 0 (voided-out, fully returned) drops out.
                    return compareMoney(a.salesSYP, 0) > 0;
                } catch {
                    return false;
                }
            });

            if (qualifying.length < STORE_BESTSELLERS_MIN_PRODUCTS) return [];
            return qualifying.map((a) => a.productId);
        },
        ["storefront-bestsellers", tenantId],
        {
            tags: [storeBestsellersTag(tenantId)],
            revalidate: STORE_BESTSELLERS_CACHE_SECONDS,
        }
    )();
}

/**
 * Available base-unit quantity per product (spec §6.5, D1/D2): SUM of
 * `quantity` over the product's batches WHERE quantity > 0 (positives only —
 * negatives count as 0), with NO expiry filter (expired batches still count).
 * ONE grouped query via the shared callGroupBy helper for all page ids — no
 * N+1. The result is cast to the row shape at the call site (the helper's
 * return type is `unknown` by design).
 *
 * Because the query itself filters `quantity > 0`, a product appears in the
 * returned map IF AND ONLY IF it has positive stock; absence means "0".
 */
async function loadAvailableBaseQuantities(
    db: TxOrClient,
    tenantId: string,
    productIds: readonly string[]
): Promise<Map<string, string>> {
    const byId = new Map<string, string>();
    if (productIds.length === 0) return byId;

    type StockGroupRow = { productId: string; _sum: { quantity: unknown } | null };
    const rows = (await callGroupBy(db.productBatch.groupBy, {
        by: ["productId"],
        where: { tenantId, productId: { in: [...productIds] }, quantity: { gt: 0 } },
        _sum: { quantity: true },
    })) as StockGroupRow[];

    for (const row of rows) {
        const sum = row._sum?.quantity;
        byId.set(row.productId, sum != null ? String(sum) : "0");
    }
    return byId;
}

/**
 * Hydrate a set of product ids into render-ready cards: image header, active
 * units (wholesale price only), and real available quantity per D1/D2, rendered
 * per unit through units.ts (breakdownForDisplay) — NO arithmetic here.
 *
 * Stock/units/headers are loaded for THESE ids only, in three batched queries —
 * never the whole catalog (spec §6.4/§6.5).
 */
export async function hydrateStorefrontCards(
    tenantId: string,
    productIds: readonly string[]
): Promise<StorefrontCard[]> {
    if (productIds.length === 0) return [];
    const db = getTenantDb(tenantId);

    const [headers, unitsByProduct, stockByProduct] = await Promise.all([
        listStorefrontProductHeaders(db, tenantId, productIds),
        listStorefrontUnitsForProducts(db, tenantId, productIds),
        loadAvailableBaseQuantities(db, tenantId, productIds),
    ]);

    const cards: StorefrontCard[] = [];
    for (const id of productIds) {
        const header = headers.get(id);
        // A product that is no longer listable (gate re-check above) is dropped.
        if (!header) continue;
        const units = unitsByProduct.get(id) ?? [];
        // §6.2 base rule: at least one ACTIVE unit. Units here are already
        // active-only, so an empty list means the product is not listable.
        if (units.length === 0) continue;

        const availableBaseQuantity = stockByProduct.get(id) ?? "0";
        // No arithmetic: the grouped query only returns products with positive
        // stock, so presence in the map IS "in stock".
        const inStock = stockByProduct.has(id);
        const availability = breakdownForDisplay(availableBaseQuantity, units).map(
            (entry) => ({
                unitId: entry.unitId,
                unitName: entry.unitName,
                count: entry.count.toString(),
            })
        );

        cards.push({
            id: header.id,
            name: header.name,
            category: header.category,
            imageUrl: header.imageUrl,
            units,
            availableBaseQuantity,
            availability,
            inStock,
        });
    }
    return cards;
}


// ============================================================================
// Products page: search + category filter + cursor pagination (spec §6.4)
// ============================================================================

/** Thrown for a malformed cursor; the route maps it to a 400. */
export class InvalidCursorError extends Error {
    constructor() {
        super("INVALID_CURSOR");
        this.name = "InvalidCursorError";
    }
}

/**
 * Opaque cursor carrying BOTH sort keys (createdAt + id) so pagination is
 * stable even when several products share createdAt. Encoded as base64 JSON
 * and treated as UNTRUSTED input on the way back in.
 */
function encodeCursor(createdAtIso: string, id: string): string {
    return Buffer.from(
        JSON.stringify({ c: createdAtIso, i: id })
    ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAtMs: number; id: string } {
    let parsed: unknown;
    try {
        const json = Buffer.from(cursor, "base64url").toString("utf8");
        parsed = JSON.parse(json);
    } catch {
        throw new InvalidCursorError();
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { c?: unknown }).c !== "string" ||
        typeof (parsed as { i?: unknown }).i !== "string"
    ) {
        throw new InvalidCursorError();
    }
    const createdAtMs = Date.parse((parsed as { c: string }).c);
    if (Number.isNaN(createdAtMs)) throw new InvalidCursorError();
    const id = (parsed as { i: string }).i;
    if (!id || id.length > 64) throw new InvalidCursorError();
    return { createdAtMs, id };
}

/** Does this light-list row match the `?category=` filter? */
function matchesCategory(item: CatalogListItem, categoryKey: string): boolean {
    if (categoryKey === STORE_UNCATEGORIZED_KEY) {
        // __none__ = "products with NO category" ONLY. A real category literally
        // named "أخرى" (or "__none__") has a non-empty normalizeCategory and is
        // therefore NOT matched here.
        return normalizeCategory(item.category) === "";
    }
    return normalizeCategory(item.category) === categoryKey;
}

export interface StorefrontPageParams {
    /** Raw search text (?q=), folded via arabic-search. */
    q?: string | null;
    /** Category grouping key (?category=), or STORE_UNCATEGORIZED_KEY. */
    category?: string | null;
    /** Opaque cursor from a previous page, or null/"" for the first page. */
    cursor?: string | null;
    /** Page size; defaults to STORE_PAGE_SIZE. */
    pageSize?: number;
}

/**
 * One page of the products list (spec §6.4). Server-side Arabic-folded search,
 * category filter, ordered createdAt desc + id desc, cursor-paginated. Only
 * the page's ids are hydrated into cards (units + stock for those ids only).
 * Never returns the whole catalog. Throws InvalidCursorError on a bad cursor.
 */
export async function getStorefrontPage(
    tenantId: string,
    params: StorefrontPageParams
): Promise<StorefrontPageResult> {
    const pageSize = params.pageSize ?? STORE_PAGE_SIZE;
    const list = await loadStorefrontCatalog(tenantId);

    // 1. Filter (search + category) in the application.
    const query = normalizeArabic(params.q ?? "");
    let filtered = list;
    if (query) {
        filtered = filtered.filter((item) => normalizeArabic(item.name).includes(query));
    }
    if (params.category) {
        filtered = filtered.filter((item) => matchesCategory(item, params.category!));
    }

    // 2. Order (already createdAt desc, id desc from the gateway — re-assert
    //    defensively so the cursor contract is explicit and independent of the
    //    gateway's orderBy).
    filtered = [...filtered].sort((a, b) => {
        const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (byDate !== 0) return byDate;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    // 3. Apply the cursor by POSITION, not by finding the cursor row: the first
    //    row strictly AFTER (createdAt, id) under (createdAt desc, id desc).
    //    The cursor row itself need not exist any more (deleted, unpublished or
    //    filtered out between pages) and nothing is repeated or skipped.
    let startIndex = 0;
    if (params.cursor) {
        const { createdAtMs, id } = decodeCursor(params.cursor);
        startIndex = filtered.findIndex((item) => {
            const t = Date.parse(item.createdAt);
            return t < createdAtMs || (t === createdAtMs && item.id < id);
        });
        // No row after the cursor: it was the last one — an empty final page.
        if (startIndex === -1) startIndex = filtered.length;
    }

    const pageItems = filtered.slice(startIndex, startIndex + pageSize);
    const lastItem = pageItems[pageItems.length - 1];
    const hasMore = startIndex + pageSize < filtered.length;
    const nextCursor =
        hasMore && lastItem ? encodeCursor(lastItem.createdAt, lastItem.id) : null;

    // 4. Hydrate ONLY the page's ids.
    const cards = await hydrateStorefrontCards(
        tenantId,
        pageItems.map((p) => p.id)
    );

    return { cards, nextCursor };
}

// ============================================================================
// Order submission — guards (§6.8 steps 5–8). Every function here takes an
// explicit `tx` and carries `tenantId` in its own `where`, so it is safe to
// call from inside the submission transaction and from a plain tenant-scoped
// client alike.
// ============================================================================

/** One submitted line, exactly as the client sent it (never trusted). */
export interface StorefrontOrderLineInput {
    productId: string;
    unitId: string;
    /** Decimal string in the sale unit `unitId`. Validated by the route. */
    quantity: string;
}

/** Everything §6.8 needs to persist one order. */
export interface StorefrontOrderInput {
    retailerName: string;
    /** ALREADY NORMALIZED (09XXXXXXXX) by the route via normalizePhone(). */
    retailerPhone: string;
    retailerShopName: string | null;
    lines: StorefrontOrderLineInput[];
}

export interface StorefrontOrderResult {
    orderId: string;
    /** Display-only reference (last 6 chars, upper-cased). */
    orderRef: string;
    /** Set when this submission was a duplicate inside the guard window. */
    wasDuplicate: boolean;
    /** The pre-approval customer hint, or null. Never exposed to the retailer. */
    matchedCustomerId: string | null;
}

/** Thrown when a line names an unpublished/inactive product or a bad unit. */
export class InvalidOrderLineError extends Error {
    readonly lineNumber: number;
    constructor(lineNumber: number, detail: string) {
        super(`${detail} (السطر ${lineNumber})`);
        this.name = "InvalidOrderLineError";
        this.lineNumber = lineNumber;
    }
}

/** Thrown when an unverified phone already has the max pending orders. */
export class PendingLimitError extends Error {
    constructor(public readonly limit: number) {
        super(
            `لديك ${limit} طلبات قيد المراجعة لهذا المتجر. ` +
            `يرجى انتظار رد التاجر قبل إرسال طلب جديد.`
        );
        this.name = "PendingLimitError";
    }
}

/**
 * §6.8 step 6 — is this phone exempt from the per-phone pending cap?
 *
 * VerifiedRetailer has NO tenantId column (schema [v5.0]); it is a
 * PLATFORM-WIDE behavioral signal keyed on the @unique normalized phone. The
 * tenant-scope extension therefore injects nothing for it — that is correct
 * and deliberate, so a `where: { tenantId }` here would be a type error. The
 * exemption is deterrent-level convenience, NOT proof of identity (D5): the
 * per-IP limit still applies to every submission regardless of this answer.
 */
export async function isVerifiedRetailerPhone(
    tx: TxOrClient,
    retailerPhone: string
): Promise<boolean> {
    const row = await tx.verifiedRetailer.findUnique({
        where: { phone: retailerPhone },
        select: { id: true },
    });
    return row !== null;
}

/**
 * §6.8 step 6 — how many PENDING_REVIEW orders this phone already has at this
 * tenant. Served by the existing (tenantId, retailerPhone, status) index.
 */
export async function countPendingStorefrontOrders(
    tx: TxOrClient,
    tenantId: string,
    retailerPhone: string
): Promise<number> {
    return tx.b2BOrderRequest.count({
        where: { tenantId, retailerPhone, status: "PENDING_REVIEW" },
    });
}

/**
 * §6.8 step 5 — the duplicate-submit guard.
 *
 * Looks for a PENDING_REVIEW order from the same phone at this tenant created
 * within STORE_DUPLICATE_SUBMIT_WINDOW_SECONDS whose lines are IDENTICAL
 * (productId, unitId, quantity). When found, the caller returns that order's
 * reference and writes NOTHING — so a double-click or a retried request can
 * never produce a second request.
 *
 * Line comparison is order-insensitive (a reordered cart is the same order)
 * and quantity comparison goes through money.ts so "3" and "3.0000" are
 * recognized as the same line.
 *
 * Served by the existing (tenantId, retailerPhone, status) index; the extra
 * createdAt bound and the item read are the only work added on top.
 */
export async function findDuplicateStorefrontOrder(
    tx: TxOrClient,
    tenantId: string,
    input: StorefrontOrderInput
): Promise<StorefrontOrderResult | null> {
    const windowStart = new Date(
        Date.now() - STORE_DUPLICATE_SUBMIT_WINDOW_SECONDS * 1000
    );

    const candidates = await tx.b2BOrderRequest.findMany({
        where: {
            tenantId,
            retailerPhone: input.retailerPhone,
            status: "PENDING_REVIEW",
            createdAt: { gte: windowStart },
        },
        select: { id: true },
        // Newest first: a burst of resubmissions resolves to the latest order.
        orderBy: { createdAt: "desc" },
    });

    if (candidates.length === 0) return null;

    // Canonical keys for the submitted lines (order-insensitive once sorted).
    const submittedKeys = canonicalLineKeys(input.lines);

    const items = await tx.b2BOrderRequestItem.findMany({
        where: {
            tenantId,
            orderRequestId: { in: candidates.map((c) => c.id) },
        },
        select: {
            orderRequestId: true,
            productId: true,
            unitId: true,
            quantity: true,
        },
    });

    const byOrder = new Map<
        string,
        Array<{ productId: string; unitId: string; quantity: string }>
    >();
    for (const item of items) {
        const list = byOrder.get(item.orderRequestId);
        const line = {
            productId: item.productId,
            unitId: item.unitId,
            quantity: item.quantity.toString(),
        };
        if (list) list.push(line);
        else byOrder.set(item.orderRequestId, [line]);
    }

    for (const candidate of candidates) {
        const existing = byOrder.get(candidate.id) ?? [];
        if (existing.length !== input.lines.length) continue;
        if (!sameLineKeys(canonicalLineKeys(existing), submittedKeys)) continue;

        return {
            orderId: candidate.id,
            orderRef: orderReference(candidate.id),
            wasDuplicate: true,
            matchedCustomerId: null,
        };
    }

    return null;
}

/** Sorted, canonical "productId|unitId|quantity" keys for one set of lines. */
function canonicalLineKeys(
    lines: ReadonlyArray<{ productId: string; unitId: string; quantity: string }>
): string[] {
    return lines
        .map((l) => `${l.productId}|${l.unitId}|${serializeMoney(l.quantity)}`)
        .sort();
}

/** Do two canonical key sets describe exactly the same order? */
function sameLineKeys(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((key, i) => key === b[i]);
}


/**
 * §6.8 step 8 (matchedCustomerId) — the pre-approval hint.
 *
 * Set ONLY when exactly ONE active, non-system Customer of this tenant carries
 * the same NORMALIZED phone. Two or more matches is ambiguous → null; zero is
 * the ordinary case for a first-time submitter → null.
 *
 * RECON FINDING (reported, deliberately not "fixed"): `Customer.phone` is
 * stored as the merchant/POS typed it — whitespace-trimmed only, never
 * normalized (see lib/offline/pos-service.ts's normalizeCustomerPhone, which
 * only strips whitespace, and prisma/seed.ts's "+963933112233"). A Customer
 * saved as "+963…", "963…", with spaces, or in Arabic digits therefore CANNOT
 * match this lookup. The effect is benign: matchedCustomerId is a hint only,
 * and T5c's approval path already creates a Customer from retailerPhone when
 * it is null, so a miss costs at most one duplicate Customer row at approval.
 * Per the task instructions, existing data is NOT normalized.
 */
export async function findMatchedCustomerId(
    tx: TxOrClient,
    tenantId: string,
    retailerPhone: string
): Promise<string | null> {
    const matches = await tx.customer.findMany({
        where: {
            tenantId,
            phone: retailerPhone,
            isActive: true,
            isSystemGenerated: false,
        },
        select: { id: true },
    });
    return matches.length === 1 ? matches[0].id : null;
}

/**
 * §6.8 step 8 — the ONE write of T5a. Opens no transaction of its own; the
 * route supplies `tx` so the header create and every item create share one
 * atomic unit.
 *
 * WRITE DISCIPLINE (project rule 1):
 *   - Every write is its own TOP-LEVEL `tx.model.create()` call. No nested
 *     create/update/connect/upsert/disconnect anywhere — the tenant-scope
 *     extension only intercepts top-level model operations, so a nested write
 *     would silently skip tenantId injection.
 *   - `tenantId` is written explicitly (belt-and-suspenders: the extension
 *     injects it too).
 *
 * NOTHING FINANCIAL OR PHYSICAL HAPPENS HERE: no Invoice, no InvoiceItem, no
 * CustomerPayment, no ProductBatch, no VerifiedRetailer write. `approvedQuantity`
 * stays NULL — only T5c writes it. No item ever carries a batch.
 *
 * Price snapshots come from the server-side re-read (§6.8 step 7); a client
 * price is never trusted.
 */
export async function createStorefrontOrder(
    tx: TxOrClient,
    tenantId: string,
    input: StorefrontOrderInput,
    snapshots: ReadonlyArray<{
        priceWholesale: string;
        pricingCurrency: "SYP" | "USD";
    }>,
    matchedCustomerId: string | null
): Promise<StorefrontOrderResult> {
    const order = await tx.b2BOrderRequest.create({
        data: {
            tenantId,
            retailerName: input.retailerName,
            retailerPhone: input.retailerPhone,
            retailerShopName: input.retailerShopName,
            // status defaults to PENDING_REVIEW; never set explicitly.
            matchedCustomerId,
        },
        select: { id: true },
    });

    for (let i = 0; i < input.lines.length; i++) {
        const line = input.lines[i];
        const snapshot = snapshots[i];
        await tx.b2BOrderRequestItem.create({
            data: {
                tenantId,
                orderRequestId: order.id,
                productId: line.productId,
                unitId: line.unitId,
                quantity: serializeMoney(line.quantity),
                priceWholesaleSnapshot: snapshot.priceWholesale,
                pricingCurrencySnapshot: snapshot.pricingCurrency,
                // approvedQuantity is deliberately NOT set — null until T5c.
            },
        });
    }

    return {
        orderId: order.id,
        orderRef: orderReference(order.id),
        wasDuplicate: false,
        matchedCustomerId,
    };
}

