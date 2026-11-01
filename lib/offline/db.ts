/* db.ts */
import Dexie, { type Table } from "dexie";
import { generateOfflineId } from "./id";
import {
  serializeMoney,
  compareMoney,
  subtractMoney,
  multiplyMoney,
  isTotalWithinTolerance,
  sumMoney,
  deriveUsd,
  type MoneyInput,
} from "../utils/money";

export type OfflineSyncStatus = "PENDING" | "SYNCED" | "FAILED";

export type PaymentMethod =
  | "CASH"
  | "SHAM_CASH"
  | "SYRIATEL_CASH"
  | "BANK_TRANSFER"
  | "OTHER";

// ============================================================================
// [FIX — review pass 8] Two real gaps closed:
//
//   1. Neither createOfflineInvoiceRecord nor createOfflineVoidRecord ever
//      checked the SIGN of paidAmountSYP — every other financial field in
//      this file has an explicit, dedicated sign guard (debtAmountSYP >= 0
//      on a plain sale, debtAmountSYP <= 0 on a void, amountSYP > 0 on a
//      payment record), but paidAmountSYP had none. Without it, a caller
//      could submit e.g. totalSYP=100, paidAmountSYP=-10,
//      debtAmountSYP=110 — every EXISTING check in this file passes that
//      combination (110 >= 0 is true; 100 − (−10) = 110 matches the
//      supplied debtAmountSYP), yet it describes a nonsensical state: a
//      100 SYP sale somehow generating 110 SYP of debt via a "negative
//      payment." Fixed by adding an explicit, dedicated guard on
//      paidAmountSYP in both factories — >= 0 on the plain sale, <= 0 on
//      the void (mirroring its own negated-sign convention, exactly the
//      same treatment already applied to debtAmountSYP on each factory).
//      This also transitively guarantees debtAmountSYP can never exceed
//      totalSYP on a plain sale (since debtSYP = totalSYP − paidSYP, and
//      paidSYP >= 0 forces debtSYP <= totalSYP) without needing a
//      separate explicit check for that.
//
// See all prior review-pass notes preserved below for the full history of
// this file's defense-in-depth financial-invariant checks.
//
// ----------------------------------------------------------------------------
// [FIX — review pass 11, v6.2 HARDENING] Four gaps closed in this revision:
//
//   1. ONE DEFINITION OF "EFFECTIVE PRICE OVERRIDE". The server
//      (app/api/sync/route.ts) stores listUnitPriceSYP only when it DIFFERS
//      from unitPriceSYP (numeric comparison), and gates exactly that case on
//      an ADMIN author. This file used to store ANY non-null catalog price, so
//      a line whose catalog price merely equalled its final price made the
//      local record say hasPriceOverride: true while the server stored false.
//      hasEffectiveListPrice() / normalizeListUnitPrice() below are the single
//      client-side definition (equal => null), used by both factories' callers
//      and by lib/offline/pos-service.ts. Keep them byte-for-byte equivalent
//      to the server's own predicate if either is ever edited.
//
//   2. LEGACY TOLERANCE. Pending Dexie rows queued before v6.2 carry neither
//      OfflineInvoice.hasPriceOverride nor OfflineInvoiceItem.listUnitPriceSYP.
//      Both are now typed OPTIONAL so TypeScript forces every reader to handle
//      `undefined`; invoiceHasPriceOverride() is the one tolerant reader.
//      Both are plain, non-indexed value fields, so no Dexie version bump is
//      needed (the index lists below are unchanged).
//
//   3. ACTOR ATTRIBUTION. /api/sync resolves a record's author from the
//      DATABASE using `createdByUserId` and falls back to whoever happens to be
//      running the sync when it is absent. For v6.2 that matters: an ADMIN's
//      price-edited sale synced while a CASHIER is logged in on the same device
//      would be rejected FAILED (terminal, never retried) even though an ADMIN
//      made it. OfflineInvoice and OfflinePayment now carry an optional
//      createdByUserId which the factories persist when given. NOTE: the
//      sync worker must forward it in the request payload.
//
//   4. SIGN GUARD ON PRICES. createOfflineInvoiceRecord now rejects a negative
//      unitPriceSYP or listUnitPriceSYP (the server already did). A price of 0
//      is allowed (free/bonus lines) — see the server's "price >= 0" rule.
// ============================================================================

export interface OfflineInvoiceItem {
  productId: string;
  unitId: string;
  /**
   * Decimal-serialized string, never a native JS number. Mirrors
   * ProductBatch.quantity's Decimal(18,4) precision server-side — a
   * weighed/measured product (e.g. produce sold by the kilogram) can carry
   * a fractional quantity, and multiplying a native-number quantity
   * against a decimal.js price would risk reintroducing float drift
   * before the value ever reaches lib/utils/money.ts.
   */
  quantity: string;
  /** AUTHORITATIVE. */
  unitPriceSYP: string;
  /**
   * Derived/informational — unitPriceSYP converted at exchangeRateUsed.
   * Nullable: null whenever the parent invoice's exchangeRateUsed is null
   * (a SYP-only sale that never needed a rate).
   */
  unitPriceUSD: string | null;
  /**
   * [v6.2] Catalog price snapshot at sale time — the catalog price the
   * cashier saw. Null when sold at the catalog price (no override). Set
   * only when an ADMIN edited the line's price or added a one-off discount
   * AND the final price actually differs from it (see
   * normalizeListUnitPrice). SYP only.
   *
   * OPTIONAL on purpose: records created before v6.2 omit this key, so every
   * reader MUST treat `undefined` exactly like `null`. Plain non-indexed value
   * field, no Dexie version bump.
   */
  listUnitPriceSYP?: string | null;
}

export interface OfflineInvoice {
  id?: number;
  tenantId: string;
  offlineId: string;
  /**
   * [T4f] Persisted upon successful sync from the server's SyncItemResult.realId.
   * Allows local client surfaces (e.g. CheckoutSuccessModal or OfflineVoidPanel)
   * to immediately know the server-side Invoice.id when status === "SYNCED" without
   * requiring an extra network lookup.
   */
  serverId?: string | null;
  customerId?: string;
  offlineCustomerId?: string;
  items: OfflineInvoiceItem[];
  /**
   * [v6.2] true when at least one line carries an EFFECTIVE price override
   * (a non-null listUnitPriceSYP that differs from unitPriceSYP). Computed by
   * the factory from the items; copied from the original invoice on voids.
   * Denormalized flag mirroring Invoice.hasPriceOverride for cheap local
   * filtering.
   *
   * OPTIONAL on purpose: pending rows queued before v6.2 do not carry it.
   * Read it ONLY through invoiceHasPriceOverride() (undefined => false).
   */
  hasPriceOverride?: boolean;
  /** AUTHORITATIVE. */
  totalSYP: string;
  /** Derived/informational. */
  totalUSD: string | null;
  /** null for a SYP-only sale that never needed a rate to resolve. */
  exchangeRateUsed: string | null;
  /** AUTHORITATIVE. */
  paidAmountSYP: string;
  /** Derived/informational. */
  paidAmountUSD: string | null;
  /** AUTHORITATIVE. */
  debtAmountSYP: string;
  /** Derived/informational. */
  debtAmountUSD: string | null;
  paymentMethod?: PaymentMethod;
  voidsOfflineInvoiceId?: string;
  voidReason?: string;
  /**
   * [v4.8 FIX 5 / v6.2] The user who CREATED this record on the device. The
   * sync server looks this user up in the database (never trusting a
   * client-sent role) to decide whether the author was an ADMIN — which is
   * what gates price overrides and voids. Absent on records queued before this
   * field existed; the server then falls back to the syncing session's user.
   */
  createdByUserId?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

export interface OfflinePayment {
  id?: number;
  tenantId: string;
  offlineId: string;
  customerId?: string;
  offlineCustomerId?: string;
  invoiceId?: string;
  offlineInvoiceId?: string;
  /** AUTHORITATIVE. */
  amountSYP: string;
  /**
   * Derived/informational — amountSYP converted at exchangeRate.
   * Nullable: null whenever no rate was cached when the payment was queued
   * (never a sentinel 0/1).
   */
  amountUSD: string | null;
  /**
   * [v4.9] Nullable — null when no cached rate existed when the payment was
   * queued. An explicit rate <= 0 still throws in the factory below.
   */
  exchangeRate: string | null;
  paymentMethod: PaymentMethod;
  receiptNo?: string;
  notes?: string;
  /** [v6.2] See OfflineInvoice.createdByUserId. */
  createdByUserId?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

export interface OfflineCustomer {
  id?: number;
  tenantId: string;
  offlineId: string;
  name: string;
  phone?: string;
  shopName?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

export interface CachedTenantSettings {
  tenantId: string;
  dailyExchangeRate: string;
  cachedAt: Date;
}

/**
 * [T4f — Rule 4] A DEVICE-scoped setting row, keyed by a stable setting name.
 *
 * Deliberately carries NO `tenantId` and NO `userId`: Rule 4 requires the
 * thermal printer's width to persist on THIS DEVICE and "not follow the user
 * or tenant to a different device" — and the same tenant's cashiers may use
 * different physical printers on different devices, so a tenant-level field
 * would be wrong even if it were convenient. The absence of both fields is
 * asserted mechanically (lib/receipts/__tests__/t4f-printer-config.test.ts),
 * not merely intended.
 *
 * Fields are printer-specific rather than a generic JSON blob so that a
 * half-written or hand-edited row cannot be silently interpreted as "some
 * other shape": an unknown `key` is ignored by the reader, and a row whose
 * `printerIsConfirmed` is not an explicit `true` is treated as UNCONFIRMED —
 * never as "close enough".
 */
export interface DeviceSetting {
  /** Primary key — e.g. lib/receipts/printer-config.ts's "thermal-printer". */
  key: string;
  /** The paper width the human selected (80mm / 58mm). */
  printerPaperWidth?: "80mm" | "58mm";
  /**
   * The dots-per-line value in force. Only ever written together with
   * `printerIsConfirmed: true` — see printer-config.ts's confirmPrinterConfig().
   */
  printerDotsPerLine?: number;
  /**
   * Explicit human confirmation that this is the printer's real print-head
   * width. Mirrors T3a's BarcodeSource rule: an unconfirmed value is its own
   * distinct state and is NEVER silently coerced into a usable one.
   */
  printerIsConfirmed?: boolean;
  printerConfirmedAt?: Date;
  updatedAt: Date;
}

export interface CachedProductUnit {
  id: string;
  unitName: string;
  /**
   * Decimal-serialized string, never a native JS number — mirrors
   * ProductUnit.conversionFactor's server-side precision. Any client-side
   * conversion of a sale-unit quantity into the product's base unit —
   * while offline, before this record ever reaches the server — must go
   * through the same decimal.js discipline as every other quantity/price
   * figure in this file.
   */
  conversionFactor: string;
  priceWholesale: string;
  pricingCurrency?: "USD" | "SYP";
  // [v4.5] REPLACED the old single `barcode?: string; barcodeSource?: ...`
  // scalar pair. A unit may carry zero, one, or many barcodes.
  //
  // NOTE: this nested list is for DISPLAY and catalog search only. POS
  // barcode-scan resolution must NOT query it (Dexie cannot efficiently
  // index into a nested array) — it queries the flat `cachedProductBarcodes`
  // table below instead, which refreshProductCache() keeps in sync with
  // exactly these values.
  barcodes?: CachedUnitBarcode[];
  isActive?: boolean;
}

/**
 * [v4.5] One barcode row as cached on the device, nested inside
 * CachedProductUnit.barcodes. Mirrors ProductUnitBarcode's display fields.
 */
export interface CachedUnitBarcode {
  id: string;
  barcode: string;
  barcodeSource?: "GS1" | "INTERNAL";
}

/**
 * [v4.5] FLAT barcode -> location index, one row per cached barcode.
 *
 * Why a separate table instead of reading CachedProduct.units[].barcodes:
 * Dexie can only index top-level properties, so a scan lookup against a
 * nested array would degrade into a full in-memory scan of every cached
 * product on every keystroke/scan. This table is keyed by
 * [tenantId+barcode] (unique), so resolving a scanned barcode is a single
 * indexed get() — and it is the ONLY place a scan ever looks.
 *
 * Written exclusively by refreshProductCache() (delete-then-bulkPut, in the
 * same transaction as cachedProducts), so the two can never disagree.
 */
export interface CachedProductBarcode {
  tenantId: string;
  barcode: string;
  productId: string;
  unitId: string;
}

/**
 * [v4.5] The PRE-v4.5 shape of a cached unit — used only by version(3)'s
 * .upgrade() migration, which has to read rows written by an older build.
 * `barcode`/`barcodeSource` are the scalar pair that no longer exists on
 * CachedProductUnit; keeping this type means the migration can be written
 * without a single `any` (and without pretending today's type describes
 * yesterday's data).
 */
export type LegacyCachedProductUnit = CachedProductUnit & {
  barcode?: string | null;
  barcodeSource?: "GS1" | "INTERNAL" | null;
};

export type LegacyCachedProduct = Omit<CachedProduct, "units"> & {
  units: LegacyCachedProductUnit[];
};

export interface CachedProductBatch {
  id: string;
  unitId: string;
  batchNumber: string;
  /**
   * Decimal-serialized string, never a native JS number — mirrors
   * ProductBatch.quantity's Decimal(18,4) precision server-side.
   *
   * [NOTE] Under v4.0, ProductBatch.unitId is always the product's
   * current base unit for any batch created after the base-unit
   * architecture was adopted — see schema.prisma's ProductBatch.unitId
   * note. A batch may still reference a NON-base unit only as a legacy
   * artifact of data created before v4.0 (unitId cannot be rewritten
   * retroactively by a migration without a full manual audit — see
   * UNIT-ARCHITECTURE.md §8). getOfflineProducts() below converts via
   * each batch's own unit's conversionFactor specifically to stay correct
   * for that legacy case; for any batch created under v4.0, that unit's
   * conversionFactor is structurally always "1", making the conversion a
   * no-op.
   */
  quantity: string;
  expiryDate?: string;
}

export interface CachedProduct {
  id: string;
  tenantId: string;
  name: string;
  category?: string;
  // [v4.6] The ONE image for this product (moved here from ProductUnit).
  // Non-indexed plain value field — no Dexie version bump required.
  // Code reading this offline MUST tolerate `undefined` on devices whose
  // cache predates the next refreshProductCache call.
  imageUrl?: string;
  isActive?: boolean;
  units: CachedProductUnit[];
  batches: CachedProductBatch[];
  // NOTE: no top-level priceWholesale here — per T1's Local Offline
  // Database Schema, pricing lives only on each CachedProductUnit
  // (a single product can carry multiple packaging units at different
  // prices/currencies). Always resolve price from the specific unit
  // being sold (units[i].priceWholesale).
}

export interface CachedCustomer {
  id: string;
  tenantId: string;
  name: string;
  phone?: string;
  shopName?: string;
  /** AUTHORITATIVE client-side balance cache. */
  cachedBalanceDebtSYP: string;
  /** Derived/informational, optional — display cache only. */
  cachedBalanceDebtUSD?: string;
  isSystemGenerated?: boolean;
  /**
   * True when this customer has at least one Invoice on the server, of
   * any status — an established, documented relationship with the
   * merchant. Populated by /api/customers and consumed by
   * lib/offline/pos-service.ts's submitOfflineSale(): an offline credit
   * sale (debtAmountSYP > 0) is only permitted against a customer where
   * this is true. See pos-service.ts's isEligibleForCredit().
   *
   * Optional/undefined only for backward compatibility with any
   * previously-cached row written before this field existed; treated as
   * `false` (no credit) wherever it's read, never as "unknown, allow it."
   */
  hasPriorInvoices?: boolean;
}

export interface CachedSession {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "CASHIER";
  /** Required boolean — prevents ambiguous offline routing state. */
  isPlatformAdmin: boolean;
  name?: string;
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
  cachedAt: Date;
}

export class OfflineDatabase extends Dexie {
  offlineInvoices!: Table<OfflineInvoice, number>;
  offlinePayments!: Table<OfflinePayment, number>;
  offlineCustomers!: Table<OfflineCustomer, number>;
  cachedTenantSettings!: Table<CachedTenantSettings, string>;
  cachedProducts!: Table<CachedProduct, string>;
  /** [v4.5] Flat barcode -> unit lookup, keyed [tenantId+barcode]. */
  cachedProductBarcodes!: Table<CachedProductBarcode, [string, string]>;
  cachedCustomers!: Table<CachedCustomer, string>;
  cachedSession!: Table<CachedSession, string>;
  /** [T4f — Rule 4] Device-scoped settings (currently: the thermal printer). */
  deviceSettings!: Table<DeviceSetting, string>;

  constructor() {
    super("JomlaTechOffline");

    this.version(1).stores({
      offlineInvoices:
        "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
      offlinePayments:
        "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
      offlineCustomers: "++id, &offlineId, tenantId, status, createdAt",
      cachedTenantSettings: "tenantId, cachedAt",
      cachedProducts: "id, tenantId, isActive, [tenantId+isActive]",
      cachedCustomers: "id, tenantId, phone, isSystemGenerated, [tenantId+phone]",
      cachedSession: "userId, tenantId, cachedAt",
    });

    // [T4f — Rule 4] version(2): the device-scoped settings table.
    //
    // Restates all seven v1 schemas verbatim alongside the new one, so the
    // complete shape of version 2 is readable in a single place rather than
    // having to be mentally merged from two deltas (Dexie merges version
    // blocks either way; restating just removes the ambiguity).
    //
    // `deviceSettings` is keyed by a plain setting name ("thermal-printer") and
    // is intentionally NOT tenant- or user-scoped — see the DeviceSetting
    // interface above and lib/receipts/printer-config.ts.
    this.version(2)
      .stores({
        offlineInvoices:
          "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
        offlinePayments:
          "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
        offlineCustomers: "++id, &offlineId, tenantId, status, createdAt",
        cachedTenantSettings: "tenantId, cachedAt",
        cachedProducts: "id, tenantId, isActive, [tenantId+isActive]",
        cachedCustomers: "id, tenantId, phone, isSystemGenerated, [tenantId+phone]",
        cachedSession: "userId, tenantId, cachedAt",
        deviceSettings: "key",
      })
      .upgrade(async () => {
        // Intentional no-op. `deviceSettings` is a brand-new table with no
        // predecessor, so there is no existing row to backfill or rewrite —
        // Dexie creates it empty on open. The callback exists because this
        // file's own rule below requires a matching .upgrade() for every new
        // version block: an explicit "nothing to migrate" is a statement that
        // the upgrade path was considered, not an omission.
      });

    // [v4.5] version(3): MULTI-BARCODE SUPPORT — the flat barcode lookup table.
    //
    // Restates all eight v2 schemas verbatim alongside the new one, per this
    // file's standing rule: a new table/field lands as a NEW version(N) block
    // with a MATCHING .upgrade(); an already-shipped version(N) block is never
    // edited, because Dexie will not retroactively create a table on a device
    // that already opened the database at an earlier version.
    //
    // `cachedProductBarcodes` is keyed by [tenantId+barcode] (unique): a
    // barcode resolves to at most one unit WITHIN a tenant, but the same GS1
    // barcode legitimately exists for two different tenants (that is the whole
    // point of the shared catalog), so `barcode` alone cannot be the primary
    // key. A secondary plain `barcode` index is kept for queries that don't
    // know the tenant (diagnostics).
    this.version(3)
      .stores({
        offlineInvoices:
          "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
        offlinePayments:
          "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
        offlineCustomers: "++id, &offlineId, tenantId, status, createdAt",
        cachedTenantSettings: "tenantId, cachedAt",
        cachedProducts: "id, tenantId, isActive, [tenantId+isActive]",
        cachedProductBarcodes: "&[tenantId+barcode], barcode, tenantId, productId, unitId",
        cachedCustomers: "id, tenantId, phone, isSystemGenerated, [tenantId+phone]",
        cachedSession: "userId, tenantId, cachedAt",
        deviceSettings: "key",
      })
      .upgrade(async (tx) => {
        // Migrate an already-cached device IN PLACE, so a device that was
        // cached before this release can still scan immediately rather than
        // waiting for its next refreshProductCache():
        //   1. rewrite every CachedProductUnit's old scalar barcode/barcodeSource
        //      into the new barcodes[] array ([] when it had no barcode);
        //   2. backfill the new flat table from those values.
        // Both run inside Dexie's own version-change transaction, so a failure
        // rolls the entire version bump back — no device is left half-migrated.
        //
        // A legacy unit's barcode becomes a row with a locally-generated id
        // (`legacy-...`): the old schema had no ProductUnitBarcode row id to
        // carry over, and a stable id keeps React keys — and any id-based
        // delete call — working. The next refreshProductCache() replaces it
        // with the server's real row ids.
        let seq = 0;

        await tx
          .table<LegacyCachedProduct>("cachedProducts")
          .toCollection()
          .modify((product) => {
            if (!product?.units) return;
            product.units = product.units.map((unit) => {
              if (Array.isArray(unit.barcodes)) return unit; // already v3-shaped
              const legacy = typeof unit.barcode === "string" ? unit.barcode.trim() : "";
              const migrated: CachedUnitBarcode[] = legacy
                ? [
                  {
                    id: `legacy-${unit.id}-${seq++}`,
                    barcode: legacy,
                    barcodeSource: unit.barcodeSource ?? undefined,
                  },
                ]
                : [];
              const migratedUnit: CachedProductUnit = {
                id: unit.id,
                unitName: unit.unitName,
                conversionFactor: unit.conversionFactor,
                priceWholesale: unit.priceWholesale,
                pricingCurrency: unit.pricingCurrency,
                barcodes: migrated,
                isActive: unit.isActive,
              };
              return migratedUnit;
            });
          });

        const barcodeTable = tx.table<CachedProductBarcode, [string, string]>("cachedProductBarcodes");
        // Idempotent by construction: the table is brand new in v3, and the
        // clear() keeps this safe if a later version ever reuses this shape.
        await barcodeTable.clear();

        const products = await tx.table<LegacyCachedProduct>("cachedProducts").toArray();
        const rows: CachedProductBarcode[] = [];
        for (const product of products) {
          for (const unit of product.units ?? []) {
            for (const b of unit.barcodes ?? []) {
              if (!b?.barcode) continue;
              rows.push({
                tenantId: product.tenantId,
                barcode: b.barcode,
                productId: product.id,
                unitId: unit.id,
              });
            }
          }
        }
        if (rows.length > 0) await barcodeTable.bulkPut(rows);
      });

    // Any future table/field addition must land as a NEW
    // version(N).stores({...}) block with a matching .upgrade()
    // migration, never as an edit to an already-shipped version(N) block
    // — Dexie will not retroactively create a table/index on a device
    // that already opened this database at an earlier version. This does
    // NOT apply to a plain value field's TypeScript type or nullability
    // (e.g. OfflineInvoice's USD fields, CachedProductUnit.conversionFactor's
    // type, [v6.2] OfflineInvoice.hasPriceOverride / createdByUserId and
    // OfflineInvoiceItem.listUnitPriceSYP) as long as that field is not part
    // of any indexed key above — only offlineId/tenantId/customerId/
    // offlineCustomerId/status/createdAt are indexed on offlineInvoices, and
    // only id/tenantId/isActive on cachedProducts.
  }
}

let offlineDbInstance: OfflineDatabase | null = null;

export function getOfflineDb(): OfflineDatabase {
  if (typeof indexedDB === "undefined") {
    throw new Error("Offline database is only available in the browser.");
  }
  if (!offlineDbInstance) {
    offlineDbInstance = new OfflineDatabase();
  }
  return offlineDbInstance;
}

export function isOfflineDbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

/** Closes and deletes the Dexie instance so tests can start from an empty DB. */
export async function resetOfflineDbForTests(): Promise<void> {
  if (offlineDbInstance) {
    offlineDbInstance.close();
    offlineDbInstance = null;
  }
  if (typeof indexedDB === "undefined") return;

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("JomlaTechOffline");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to delete offline DB"));
    // [FIX — review pass 9] Reject, not resolve, on "blocked." This
    // function's ENTIRE purpose is guaranteeing a genuinely clean slate
    // before a test runs — a blocked delete means another open
    // connection (e.g. a previous test's un-closed instance, or a
    // leftover browser tab) prevented the database from actually being
    // removed. Resolving anyway would let a subsequent test silently run
    // against stale, un-reset state, and any failure it then produces
    // would have no visible connection back to this function as the real
    // cause. Failing loud here, with a message naming the actual reason,
    // surfaces the problem at its source instead of as a mysterious
    // downstream test failure.
    request.onblocked = () =>
      reject(
        new Error(
          "resetOfflineDbForTests: deleteDatabase was blocked by another " +
          "open connection to 'JomlaTechOffline' — close every other tab/" +
          "instance holding this database open before resetting, or call " +
          "offlineDbInstance.close() on it first."
        )
      );
  });
}

// ============================================================================
// [v6.2] PRICE-OVERRIDE HELPERS — the ONE client-side definition.
//
// "Effective override" = the line carries a catalog price AND it differs
// (numerically, never as strings: "100" and "100.0000" are the same price)
// from the final unit price. This is the same predicate the sync server uses
// both to gate an ADMIN author and to decide what it stores, so a record
// built here and the row the server writes can never disagree about whether
// an invoice "has a price override".
// ============================================================================

/**
 * True when `item` carries a catalog price that differs from its final price.
 * Tolerates `undefined` (pre-v6.2 rows). May throw MoneyError on a malformed
 * decimal — callers validate prices first (see assertValidLinePrices in
 * pos-service.ts and the factory guards below).
 */
export function hasEffectiveListPrice(item: {
  unitPriceSYP: MoneyInput;
  listUnitPriceSYP?: MoneyInput | null;
}): boolean {
  if (item.listUnitPriceSYP === undefined || item.listUnitPriceSYP === null) return false;
  return (
    compareMoney(serializeMoney(item.listUnitPriceSYP), serializeMoney(item.unitPriceSYP)) !== 0
  );
}

/**
 * Normalizes a catalog-price snapshot against the line's final price:
 *   - absent / null            -> null (sold at the catalog price)
 *   - equal to the final price -> null (there is no override to record)
 *   - otherwise                -> the serialized 4-dp catalog price
 * Throws on a negative catalog price (a catalog price of 0 is allowed).
 */
export function normalizeListUnitPrice(
  listUnitPriceSYP: MoneyInput | null | undefined,
  finalUnitPriceSYP: MoneyInput
): string | null {
  if (listUnitPriceSYP === undefined || listUnitPriceSYP === null) return null;
  const list = serializeMoney(listUnitPriceSYP);
  if (compareMoney(list, 0) < 0) {
    throw new Error("listUnitPriceSYP must not be negative.");
  }
  return compareMoney(list, serializeMoney(finalUnitPriceSYP)) === 0 ? null : list;
}

/**
 * The ONE tolerant reader for the denormalized invoice flag. A pending row
 * queued before v6.2 has no `hasPriceOverride` (undefined) and means "no
 * override" — never treat a missing flag as true.
 */
export function invoiceHasPriceOverride(invoice: { hasPriceOverride?: boolean }): boolean {
  return invoice.hasPriceOverride === true;
}

export function createOfflineInvoiceRecord(data: {
  tenantId: string;
  offlineId?: string;
  customerId?: string;
  offlineCustomerId?: string;
  isSystemCustomer?: boolean;
  requiresExchangeRate?: boolean;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: MoneyInput;
    unitPriceSYP: MoneyInput;
    // [v6.2] Catalog price snapshot at sale time — null when sold at the
    // catalog price (no override). Optional for backward compatibility with
    // records created before v6.2. A value equal to unitPriceSYP is
    // normalized to null (no effective override).
    listUnitPriceSYP?: MoneyInput | null;
  }>;
  totalSYP: MoneyInput;
  exchangeRateUsed?: MoneyInput | null;
  paidAmountSYP: MoneyInput;
  debtAmountSYP: MoneyInput;
  paymentMethod?: PaymentMethod;
  /** [v6.2] The user who created this sale on the device (see OfflineInvoice). */
  createdByUserId?: string;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflineInvoice {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create an offline invoice record.");
  }
  if (data.customerId && data.offlineCustomerId) {
    throw new Error("Offline invoice cannot have both customerId and offlineCustomerId.");
  }
  if (!data.customerId && !data.offlineCustomerId) {
    throw new Error(
      "Offline invoice must reference a customer via either customerId or offlineCustomerId."
    );
  }
  if (!data.items || data.items.length === 0) {
    throw new Error("An offline invoice must have at least one line item.");
  }

  const serializedItems = data.items.map((item) => {
    const unitPriceSYP = serializeMoney(item.unitPriceSYP);
    return {
      productId: item.productId,
      unitId: item.unitId,
      quantity: serializeMoney(item.quantity),
      unitPriceSYP,
      // [v6.2] Catalog price snapshot, normalized: null when absent, null
      // (pre-v6.2) or EQUAL to the final price — only a genuine difference is
      // kept, exactly like the sync server. Throws on a negative value.
      listUnitPriceSYP: normalizeListUnitPrice(item.listUnitPriceSYP, unitPriceSYP),
    };
  });

  if (serializedItems.some((item) => compareMoney(item.quantity, 0) <= 0)) {
    throw new Error("Every line item on a sale must have a strictly positive quantity.");
  }

  // [v6.2] The server rejects a negative unit price; reject it here too so a
  // bad record never reaches the queue. A price of 0 is allowed (free line).
  if (serializedItems.some((item) => compareMoney(item.unitPriceSYP, 0) < 0)) {
    throw new Error("unitPriceSYP must not be negative.");
  }

  const requiresExchangeRate = data.requiresExchangeRate ?? true;

  let rateUsed: string | null = null;
  if (data.exchangeRateUsed !== undefined && data.exchangeRateUsed !== null) {
    rateUsed = serializeMoney(data.exchangeRateUsed);
    if (compareMoney(rateUsed, 0) <= 0) {
      throw new Error("exchangeRateUsed must be strictly greater than 0 when provided.");
    }
  }

  if (requiresExchangeRate && rateUsed === null) {
    throw new Error(
      "exchangeRateUsed is required — this sale contains at least one USD-priced item " +
      "(or requiresExchangeRate was not explicitly disabled)."
    );
  }

  const paidSYP = serializeMoney(data.paidAmountSYP);

  // [FIX — review pass 8] paidAmountSYP had no dedicated sign guard,
  // unlike every other financial field in this file. Without this, e.g.
  // totalSYP=100, paidAmountSYP=-10, debtAmountSYP=110 passed every
  // existing check (110 >= 0; 100 − (−10) = 110) despite describing a
  // nonsensical state — a 100 SYP sale generating 110 SYP of debt via a
  // negative "payment." This also transitively guarantees debtAmountSYP
  // can never exceed totalSYP on a plain sale, since debtSYP = totalSYP
  // − paidSYP and paidSYP >= 0 forces debtSYP <= totalSYP.
  if (compareMoney(paidSYP, 0) < 0) {
    throw new Error("paidAmountSYP must not be negative.");
  }

  if (compareMoney(paidSYP, 0) > 0 && !data.paymentMethod) {
    throw new Error("paymentMethod is required whenever paidAmountSYP > 0.");
  }
  if (compareMoney(paidSYP, 0) === 0 && data.paymentMethod) {
    throw new Error(
      "paymentMethod must not be set on a fully-on-credit sale (paidAmountSYP === 0)."
    );
  }

  const debtSYP = serializeMoney(data.debtAmountSYP);
  if (compareMoney(debtSYP, 0) < 0) {
    throw new Error(
      "debtAmountSYP must not be negative on a plain sale — negative debt is only valid on a void record."
    );
  }

  if (data.isSystemCustomer && compareMoney(debtSYP, 0) > 0) {
    throw new Error(
      "An invoice cannot reference the system-generated cash customer while " +
      "debtAmountSYP > 0 — a sale carrying debt requires a real, identified customer."
    );
  }

  const totalSYP = serializeMoney(data.totalSYP);

  const unitPricesSYP = serializedItems.map((item) => item.unitPriceSYP);
  const computedTotal = sumMoney(
    serializedItems.map((item) => multiplyMoney(item.quantity, item.unitPriceSYP))
  );
  if (!isTotalWithinTolerance(computedTotal, totalSYP, unitPricesSYP)) {
    throw new Error(
      `totalSYP (${totalSYP}) must equal the sum of item.quantity × item.unitPriceSYP ` +
      `(${computedTotal}) within the by-amount rounding tolerance (half a quantity step per line).`
    );
  }

  if (compareMoney(subtractMoney(totalSYP, paidSYP), debtSYP) !== 0) {
    throw new Error("debtAmountSYP must equal totalSYP − paidAmountSYP (SYP is authoritative).");
  }

  const totalUSD = deriveUsd(totalSYP, rateUsed);
  const paidAmountUSD = deriveUsd(paidSYP, rateUsed);
  const debtAmountUSD = deriveUsd(debtSYP, rateUsed);

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    items: serializedItems.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      unitPriceSYP: item.unitPriceSYP,
      // [v4.9] Single helper decides "USD unavailable" — null when no rate.
      unitPriceUSD: deriveUsd(item.unitPriceSYP, rateUsed),
      // [v6.2] Catalog price snapshot carried on the persisted record —
      // already normalized above (null unless it genuinely differs).
      listUnitPriceSYP: item.listUnitPriceSYP,
    })),
    // [v6.2] true when at least one line carries an EFFECTIVE override
    // (a non-null snapshot, which after normalization always differs from the
    // final price). Written once here; never updated after.
    hasPriceOverride: serializedItems.some((item) => item.listUnitPriceSYP !== null),
    totalSYP,
    totalUSD,
    exchangeRateUsed: rateUsed,
    paidAmountSYP: paidSYP,
    paidAmountUSD,
    debtAmountSYP: debtSYP,
    debtAmountUSD,
    paymentMethod: data.paymentMethod,
    createdByUserId: data.createdByUserId?.trim() || undefined,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

export function createOfflineVoidRecord(data: {
  tenantId: string;
  offlineId?: string;
  voidsOfflineInvoiceId: string;
  voidReason: string;
  customerId?: string;
  offlineCustomerId?: string;
  isSystemCustomer?: boolean;
  requiresExchangeRate?: boolean;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: MoneyInput;
    unitPriceSYP: MoneyInput;
    // [v6.2] Catalog price snapshot copied from the original line
    // (null stays null, undefined — a pre-v6.2 original — becomes null).
    // Never from the payload. NOT normalized against the price: a void
    // mirrors its original line verbatim.
    listUnitPriceSYP?: MoneyInput | null;
  }>;
  originalTotalSYP?: MoneyInput;
  totalSYP?: MoneyInput;
  exchangeRateUsed?: MoneyInput | null;
  originalPaidAmountSYP?: MoneyInput;
  originalDebtAmountSYP?: MoneyInput;
  paidAmountSYP?: MoneyInput;
  debtAmountSYP?: MoneyInput;
  // [v6.2] Copied from the original invoice (undefined/false stay false,
  // true stays true). Never derived from the void's own items.
  hasPriceOverride?: boolean;
  /** [v6.2] The ADMIN who queued this void on the device (see OfflineInvoice). */
  createdByUserId?: string;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflineInvoice {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create an offline void record.");
  }
  if (data.customerId && data.offlineCustomerId) {
    throw new Error("Offline void cannot have both customerId and offlineCustomerId.");
  }
  if (!data.customerId && !data.offlineCustomerId) {
    throw new Error(
      "Offline void must reference a customer via either customerId or offlineCustomerId."
    );
  }
  if (!data.voidsOfflineInvoiceId) {
    throw new Error("voidsOfflineInvoiceId is required for a void record.");
  }
  if (!data.voidReason || !data.voidReason.trim()) {
    throw new Error("voidReason is required for a void record.");
  }
  if (!data.items || data.items.length === 0) {
    throw new Error("An offline void record must have at least one line item.");
  }

  const serializedItems = data.items.map((item) => ({
    productId: item.productId,
    unitId: item.unitId,
    quantity: serializeMoney(item.quantity),
    unitPriceSYP: serializeMoney(item.unitPriceSYP),
    // [v6.2] Catalog price snapshot copied from the original line
    // (null/undefined stay null).
    listUnitPriceSYP:
      item.listUnitPriceSYP === undefined || item.listUnitPriceSYP === null
        ? null
        : serializeMoney(item.listUnitPriceSYP),
  }));

  if (serializedItems.some((item) => compareMoney(item.quantity, 0) >= 0)) {
    throw new Error(
      "A void's line items must be the negated mirror of the original sale " +
      "(quantity strictly less than 0 for every item) — got a zero or " +
      "positive quantity."
    );
  }

  const requiresExchangeRate = data.requiresExchangeRate ?? true;

  let rateUsed: string | null = null;
  if (data.exchangeRateUsed !== undefined && data.exchangeRateUsed !== null) {
    rateUsed = serializeMoney(data.exchangeRateUsed);
    if (compareMoney(rateUsed, 0) <= 0) {
      throw new Error("exchangeRateUsed must be strictly greater than 0 when provided.");
    }
  }

  if (requiresExchangeRate && rateUsed === null) {
    throw new Error(
      "exchangeRateUsed is required to void this invoice — the original sale " +
      "contained at least one USD-priced item (or requiresExchangeRate was not " +
      "explicitly disabled to match the original invoice)."
    );
  }

  const totalSYP =
    data.originalTotalSYP !== undefined
      ? subtractMoney("0", data.originalTotalSYP)
      : serializeMoney(data.totalSYP ?? "0");
  const paidSYP =
    data.originalPaidAmountSYP !== undefined
      ? subtractMoney("0", data.originalPaidAmountSYP)
      : data.paidAmountSYP !== undefined
        ? serializeMoney(data.paidAmountSYP)
        : "0.0000";
  const debtSYP =
    data.originalDebtAmountSYP !== undefined
      ? subtractMoney("0", data.originalDebtAmountSYP)
      : data.debtAmountSYP !== undefined
        ? serializeMoney(data.debtAmountSYP)
        : "0.0000";

  // [FIX — review pass 8] Mirrors the debtAmountSYP guard immediately
  // below: paidAmountSYP on a void record must never end up positive — a
  // void only ever reverses a previously-collected (non-negative)
  // payment, never creates a new positive one. The same class of gap as
  // createOfflineInvoiceRecord's own missing paidAmountSYP sign check
  // above, just mirrored for the void's negated-sign convention. A
  // positive value reaching this point means something upstream failed
  // to negate correctly (or passed an already-negative
  // originalPaidAmountSYP by mistake, double-negating it).
  if (compareMoney(paidSYP, 0) > 0) {
    throw new Error(
      "paidAmountSYP on a void record must not be positive — a void only ever " +
      "reverses a previously-collected payment, never creates one."
    );
  }

  if (compareMoney(debtSYP, 0) > 0) {
    throw new Error(
      "debtAmountSYP on a void record must not be positive — a void only ever " +
      "reverses debt, never creates it."
    );
  }

  if (data.isSystemCustomer && compareMoney(debtSYP, 0) !== 0) {
    throw new Error(
      "A void record cannot reference the system-generated cash customer while " +
      "debtAmountSYP is nonzero — the system customer must never carry debt or credit."
    );
  }

  const unitPricesSYP = serializedItems.map((item) => item.unitPriceSYP);
  const computedTotal = sumMoney(
    serializedItems.map((item) => multiplyMoney(item.quantity, item.unitPriceSYP))
  );
  if (!isTotalWithinTolerance(computedTotal, totalSYP, unitPricesSYP)) {
    throw new Error(
      `totalSYP (${totalSYP}) must equal the sum of item.quantity × item.unitPriceSYP ` +
      `(${computedTotal}) within the by-amount rounding tolerance (half a quantity step per line).`
    );
  }

  if (compareMoney(subtractMoney(totalSYP, paidSYP), debtSYP) !== 0) {
    throw new Error(
      "debtAmountSYP must equal totalSYP − paidAmountSYP on the reversing void row as well."
    );
  }

  const totalUSD = deriveUsd(totalSYP, rateUsed);
  const paidAmountUSD = deriveUsd(paidSYP, rateUsed);
  const debtAmountUSD = deriveUsd(debtSYP, rateUsed);

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    items: serializedItems.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      unitPriceSYP: item.unitPriceSYP,
      // [v4.9] Null stays null on void rows via the single helper.
      unitPriceUSD: deriveUsd(item.unitPriceSYP, rateUsed),
      // [v6.2] Catalog price snapshot copied from the original line.
      listUnitPriceSYP: item.listUnitPriceSYP,
    })),
    totalSYP,
    totalUSD,
    exchangeRateUsed: rateUsed,
    paidAmountSYP: paidSYP,
    paidAmountUSD,
    debtAmountSYP: debtSYP,
    debtAmountUSD,
    paymentMethod: undefined,
    voidsOfflineInvoiceId: data.voidsOfflineInvoiceId,
    voidReason: data.voidReason,
    // [v6.2] Copied from the original invoice; never derived from items.
    // `=== true` so a pre-v6.2 original (undefined) yields false.
    hasPriceOverride: data.hasPriceOverride === true,
    createdByUserId: data.createdByUserId?.trim() || undefined,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

export function createOfflinePaymentRecord(data: {
  tenantId: string;
  offlineId?: string;
  customerId?: string;
  offlineCustomerId?: string;
  invoiceId?: string;
  offlineInvoiceId?: string;
  amountSYP: MoneyInput;
  exchangeRate: MoneyInput;
  paymentMethod: PaymentMethod;
  receiptNo?: string;
  notes?: string;
  /** [v6.2] The ADMIN who queued this repayment on the device. */
  createdByUserId?: string;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflinePayment {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create an offline payment record.");
  }
  if (data.customerId && data.offlineCustomerId) {
    throw new Error("Offline payment cannot have both customerId and offlineCustomerId.");
  }
  if (!data.customerId && !data.offlineCustomerId) {
    throw new Error(
      "Offline payment must reference a customer via either customerId or offlineCustomerId."
    );
  }
  if (data.invoiceId && data.offlineInvoiceId) {
    throw new Error("Offline payment cannot have both invoiceId and offlineInvoiceId.");
  }

  const rate = serializeMoney(data.exchangeRate);
  if (compareMoney(rate, 0) <= 0) {
    throw new Error("exchangeRate must be strictly greater than 0.");
  }

  const amountSYP = serializeMoney(data.amountSYP);
  if (compareMoney(amountSYP, 0) <= 0) {
    throw new Error("amountSYP must be strictly greater than 0 for a payment record.");
  }

  const amountUSD = deriveUsd(amountSYP, rate);

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    invoiceId: data.invoiceId,
    offlineInvoiceId: data.offlineInvoiceId,
    amountSYP,
    amountUSD,
    exchangeRate: rate,
    paymentMethod: data.paymentMethod,
    receiptNo: data.receiptNo,
    notes: data.notes,
    createdByUserId: data.createdByUserId?.trim() || undefined,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

export function createOfflineCustomerRecord(data: {
  tenantId: string;
  offlineId?: string;
  name: string;
  phone?: string;
  shopName?: string;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflineCustomer {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create an offline customer record.");
  }
  if (!data.name || !data.name.trim()) {
    throw new Error("name is required to create an offline customer record.");
  }

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    name: data.name,
    phone: data.phone,
    shopName: data.shopName,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

export function createCachedProductRecord(data: {
  tenantId: string;
  id: string;
  name: string;
  category?: string;
  // [v4.6] The ONE image for this product. Optional so existing callers
  // that pre-date this change don't need to be updated all at once.
  imageUrl?: string;
  isActive?: boolean;
  units: Array<{
    id: string;
    unitName: string;
    conversionFactor: MoneyInput;
    priceWholesale: MoneyInput;
    pricingCurrency?: "USD" | "SYP";
    // [v4.5] Zero, one, or many barcodes per unit (was a single `barcode` /
    // `barcodeSource` scalar pair).
    barcodes?: Array<{ id: string; barcode: string; barcodeSource?: "GS1" | "INTERNAL" }>;
    isActive?: boolean;
  }>;
  batches: Array<{
    id: string;
    unitId: string;
    batchNumber: string;
    quantity: MoneyInput;
    expiryDate?: string;
  }>;
}): CachedProduct {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create a cached product record.");
  }

  return {
    id: data.id,
    tenantId: data.tenantId,
    name: data.name,
    category: data.category,
    // [v4.6] Carry the product-level image through.
    imageUrl: data.imageUrl,
    isActive: data.isActive !== false,
    units: data.units.map((u) => ({
      id: u.id,
      unitName: u.unitName,
      conversionFactor: serializeMoney(u.conversionFactor),
      priceWholesale: serializeMoney(u.priceWholesale),
      pricingCurrency: u.pricingCurrency,
      // [v4.5] The unit's full barcode list. Always an array (possibly empty),
      // never the old scalar pair — see CachedProductUnit.barcodes.
      barcodes: (u.barcodes ?? []).map((b) => ({
        id: b.id,
        barcode: b.barcode,
        barcodeSource: b.barcodeSource,
      })),
      isActive: u.isActive,
    })),
    batches: data.batches.map((b) => ({
      id: b.id,
      unitId: b.unitId,
      batchNumber: b.batchNumber,
      quantity: serializeMoney(b.quantity),
      expiryDate: b.expiryDate,
    })),
  };
}

export function createCachedCustomerRecord(data: {
  tenantId: string;
  id: string;
  name: string;
  phone?: string;
  shopName?: string;
  cachedBalanceDebtSYP: MoneyInput;
  cachedBalanceDebtUSD?: MoneyInput;
  isSystemGenerated?: boolean;
  hasPriorInvoices?: boolean;
}): CachedCustomer {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create a cached customer record.");
  }

  return {
    id: data.id,
    tenantId: data.tenantId,
    name: data.name,
    phone: data.phone,
    shopName: data.shopName,
    cachedBalanceDebtSYP: serializeMoney(data.cachedBalanceDebtSYP),
    cachedBalanceDebtUSD:
      data.cachedBalanceDebtUSD !== undefined
        ? serializeMoney(data.cachedBalanceDebtUSD)
        : undefined,
    isSystemGenerated: data.isSystemGenerated,
    hasPriorInvoices: data.hasPriorInvoices === true,
  };
}

export function createCachedSessionRecord(data: {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "CASHIER";
  isPlatformAdmin: boolean;
  name?: string;
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
  cachedAt?: Date;
}): CachedSession {
  if (!data.userId || !data.userId.trim()) {
    throw new Error("userId is required to create a cached session record.");
  }
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create a cached session record.");
  }
  if (data.role !== "ADMIN" && data.role !== "CASHIER") {
    throw new Error(`Invalid role '${data.role}': must be ADMIN or CASHIER.`);
  }
  if (typeof data.isPlatformAdmin !== "boolean") {
    throw new Error("isPlatformAdmin is required and must be a boolean.");
  }

  return {
    userId: data.userId.trim(),
    tenantId: data.tenantId.trim(),
    tenantName: data.tenantName,
    tenantSlug: data.tenantSlug,
    role: data.role,
    isPlatformAdmin: data.isPlatformAdmin,
    name: data.name,
    subscriptionStatus: data.subscriptionStatus,
    cachedAt: data.cachedAt ? new Date(data.cachedAt) : new Date(),
  };
}