/**
 * T4f addendum — Rule 3: FIRST-SHARE PDF GENERATION, CONCURRENCY GUARD.
 *
 *   COVERAGE → ACCEPTANCE CRITERIA
 *   1. Two simultaneous first-shares persist EXACTLY ONE receiptPdfUrl; the
 *      losing request's artifact never becomes the invoice's URL and is deleted
 *      rather than left orphaned in storage.
 *   2. A third, later share reuses the persisted URL with no generation at all —
 *      the route's own fast path, asserted on source order.
 *   3. The guard is ONE conditional UPDATE (`receiptPdfUrl: null` in the where
 *      clause) — no new lock, no new status column, and no new $queryRaw.
 *
 * [HONEST LIMITATION, STATED RATHER THAN IMPLIED — same posture as
 * lib/data/__tests__/t4d-void-refund.test.ts's header] This suite runs the REAL
 * cacheReceiptPdfOnce() against a fake `invoice` delegate whose updateMany is a
 * genuine compare-and-set (read-check-write in a single synchronous step, which
 * Node's single-threaded loop makes indivisible). That reproduces the race
 * faithfully for the code under test — both calls see receiptPdfUrl empty, both
 * upload, both attempt the claim, one wins — but it is NOT a live Postgres
 * test. Row-level locking semantics under MVCC are the database's guarantee, not
 * something a unit test can prove; what this test proves is that this code
 * relies on the conditional write and handles both outcomes correctly.
 *
 * Only the storage client is mocked (no network, no bucket); the conditional
 * claim itself, the re-read, and the discard path are the real implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

const { storageState } = vi.hoisted(() => ({
  storageState: {
    uploads: [] as string[],
    deletes: [] as string[],
    /** When set, the next upload reports this URL instead of the key's own. */
    overrideUrl: null as string | null,
    alreadyExisted: false,
  },
}));

vi.mock("@/lib/storage", () => ({
  PDF_CONTENT_TYPE: "application/pdf",
  buildDeterministicStorageKey: (params: {
    tenantId: string;
    invoiceId: string;
    kind: string;
    extension: string;
  }) => `${params.tenantId}/${params.kind}/${params.invoiceId}.${params.extension}`,
  uploadFileToStorageIfAbsent: async (params: { key: string }) => {
    storageState.uploads.push(params.key);
    return {
      key: params.key,
      url: storageState.overrideUrl ?? `https://cdn.example/${params.key}`,
      alreadyExisted: storageState.alreadyExisted,
    };
  },
  removeFileFromStorage: async (key: string) => {
    storageState.deletes.push(key);
  },
}));

import {
  buildInvoiceReceiptPdfKey,
  cacheReceiptPdfOnce,
} from "@/lib/data/receipts";

const rootDir = process.cwd();
const TENANT_ID = "tenant-t4f-race";
const INVOICE_ID = "invoice-race-1";

const EXPECTED_KEY = `${TENANT_ID}/invoice-pdfs/${INVOICE_ID}.pdf`;

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

/**
 * A fake `invoice` delegate whose updateMany is a real compare-and-set: it only
 * writes when the *passed* condition still holds against the live row, which is
 * what makes two concurrent claims resolve to one winner.
 */
function makeFakeDb(initialUrl: string | null, opts: { refuseWrite?: boolean } = {}) {
  const row: { id: string; tenantId: string; receiptPdfUrl: string | null } = {
    id: INVOICE_ID,
    tenantId: TENANT_ID,
    receiptPdfUrl: initialUrl,
  };
  const updateCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];

  const db = {
    invoice: {
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        updateCalls.push(args);

        if (opts.refuseWrite) return { count: 0 };

        // The condition is re-evaluated HERE, atomically with the write.
        const matches =
          row.id === args.where.id &&
          row.tenantId === args.where.tenantId &&
          args.where.receiptPdfUrl === null &&
          row.receiptPdfUrl === null;

        if (!matches) return { count: 0 };

        row.receiptPdfUrl = args.data.receiptPdfUrl as string;
        return { count: 1 };
      },
      findUnique: async () => ({ receiptPdfUrl: row.receiptPdfUrl }),
    },
  };

  // The signature the module actually needs; the double-cast keeps the test
  // free of Prisma types (nothing here touches a real client).
  return { db: db as never, row, updateCalls };
}

beforeEach(() => {
  storageState.uploads.length = 0;
  storageState.deletes.length = 0;
  storageState.overrideUrl = null;
  storageState.alreadyExisted = false;
});

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

describe("Rule 3 — the key is deterministic, so two racers cannot make two objects", () => {
  it("derives one key per (tenant, invoice) with no time or randomness in it", () => {
    const a = buildInvoiceReceiptPdfKey({ tenantId: TENANT_ID, invoiceId: INVOICE_ID });
    const b = buildInvoiceReceiptPdfKey({ tenantId: TENANT_ID, invoiceId: INVOICE_ID });

    expect(a).toBe(EXPECTED_KEY);
    expect(a).toBe(b);

    // A timestamped or random key would defeat the whole guard by giving each
    // racer its own object.
    const source = readSource("lib/data/receipts.ts");
    const builder = source.slice(
      source.indexOf("export function buildInvoiceReceiptPdfKey"),
      source.indexOf("export async function readReceiptPdfUrl")
    );
    expect(builder).not.toMatch(/Date\.now|randomUUID|nanoid|Math\.random/);
  });
});

describe("Rule 3 — two concurrent first-shares produce exactly one URL", () => {
  it("one claim wins, both callers receive the SAME persisted URL, nothing is orphaned", async () => {
    const { db, row, updateCalls } = makeFakeDb(null);

    // Both requests start with receiptPdfUrl empty — the race's precondition.
    const [first, second] = await Promise.all([
      cacheReceiptPdfOnce({ db, tenantId: TENANT_ID, invoiceId: INVOICE_ID, pdf: PDF_BYTES }),
      cacheReceiptPdfOnce({ db, tenantId: TENANT_ID, invoiceId: INVOICE_ID, pdf: PDF_BYTES }),
    ]);

    // Exactly one conditional UPDATE actually claimed the row.
    const winners = [first.wonRace, second.wonRace].filter(Boolean);
    expect(winners).toHaveLength(1);

    // Both callers serve the SAME url — the one the invoice now points at.
    expect(first.url).toBe(second.url);
    expect(row.receiptPdfUrl).toBe(first.url);

    // Two uploads, but at the SAME deterministic key, so there is one object and
    // no orphan to clean up.
    expect(storageState.uploads).toEqual([EXPECTED_KEY, EXPECTED_KEY]);
    expect(storageState.deletes).toEqual([]);

    // And both attempts used the conditional UPDATE — not a blind write.
    expect(updateCalls).toHaveLength(2);
    for (const call of updateCalls) {
      expect(call.where).toEqual({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        receiptPdfUrl: null,
      });
      expect(call.data).toEqual({ receiptPdfUrl: expect.any(String) });
    }
  });

  it("a losing request never leaves its own artifact referenced, and deletes it", async () => {
    // The winner already persisted a URL (as a previous, crashed attempt would
    // have); our upload reports a DIFFERENT url, so our bytes are not the ones
    // the invoice references.
    const winnerUrl = `https://cdn.example/${EXPECTED_KEY}`;
    const { db, row } = makeFakeDb(winnerUrl);
    storageState.overrideUrl = "https://cdn.example/some/other/object.pdf";

    const result = await cacheReceiptPdfOnce({
      db,
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      pdf: PDF_BYTES,
    });

    expect(result.wonRace).toBe(false);
    // The invoice still points at the WINNER's url...
    expect(result.url).toBe(winnerUrl);
    expect(row.receiptPdfUrl).toBe(winnerUrl);
    expect(result.url).not.toBe(storageState.overrideUrl);
    // ...and our own upload was discarded rather than left behind.
    expect(result.discardedOwnUpload).toBe(true);
    expect(storageState.deletes).toEqual([EXPECTED_KEY]);
  });

  it("reuses an already-existing object instead of failing forever (crash recovery)", async () => {
    // A previous attempt uploaded the bytes and died before its UPDATE landed.
    const { db, row } = makeFakeDb(null);
    storageState.alreadyExisted = true;

    const result = await cacheReceiptPdfOnce({
      db,
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      pdf: PDF_BYTES,
    });

    expect(result.wonRace).toBe(true);
    expect(result.reusedExistingObject).toBe(true);
    expect(row.receiptPdfUrl).toBe(result.url);
    // Nothing was deleted: the object it re-used IS the referenced one.
    expect(storageState.deletes).toEqual([]);
  });

  it("refuses rather than inventing a URL when the claim does not take", async () => {
    const { db } = makeFakeDb(null, { refuseWrite: true });

    await expect(
      cacheReceiptPdfOnce({ db, tenantId: TENANT_ID, invoiceId: INVOICE_ID, pdf: PDF_BYTES })
    ).rejects.toThrow();
  });
});

describe("Rule 3 — a later share reuses the persisted URL, and no raw query is involved", () => {
  it("the route reuses a cached URL BEFORE validating or generating anything", () => {
    const route = readSource("app/api/invoices/[id]/receipt/route.ts");

    const iFastPath = route.indexOf("if (invoice.receiptPdfUrl)");
    const iValidate = route.indexOf("validateReceiptRasterPng(");
    const iPdf = route.indexOf("buildReceiptPdfFromPng(");
    const iCache = route.indexOf("cacheReceiptPdfOnce(");

    expect(iFastPath).toBeGreaterThan(-1);
    expect(iFastPath).toBeLessThan(iValidate);
    expect(iFastPath).toBeLessThan(iPdf);
    expect(iFastPath).toBeLessThan(iCache);

    // And that fast path returns the cached flag the client relies on.
    expect(route.slice(iFastPath, iFastPath + 200)).toContain("cached: true");
  });

  it("the guard is a Prisma conditional update — no new lock, no new raw query", () => {
    const source = readSource("lib/data/receipts.ts");

    expect(source).toContain("updateMany(");
    expect(source).toContain("receiptPdfUrl: null");
    expect(source).not.toContain("$queryRaw");
    expect(source).not.toContain("$executeRaw");
    expect(source).not.toContain("FOR UPDATE");
  });
});
