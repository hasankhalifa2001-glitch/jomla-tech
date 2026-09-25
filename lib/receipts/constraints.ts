/**
 * lib/receipts/constraints.ts
 *
 * T4f — the SINGLE source of truth for the receipt-PDF raster contract, and
 * the only place these numbers are allowed to be written down.
 *
 * WHY THIS FILE EXISTS AS ITS OWN MODULE:
 * The share path (Rule 1 / Rule 3 of the T4f addendum) has a client half
 * (components/receipts/receipt-canvas.ts renders the receipt to a PNG) and a
 * server half (app/api/invoices/[id]/receipt/route.ts validates and wraps
 * that PNG into a PDF). If either half carried its own copy of "how wide is
 * a receipt", the two would be free to drift, and validation would silently
 * degrade into "whatever the client happened to send". Importing one shared
 * constant makes the contract explicit and reviewable in one place.
 *
 * [IMPORTANT — this width is NOT the thermal printer's dots-per-line]
 * RECEIPT_PDF_RASTER_WIDTH is deliberately FIXED and device-INDEPENDENT.
 * The PDF is a server-side artifact cached ONCE per invoice and shared to
 * any number of recipients across any number of devices, so it must not
 * change shape depending on which physical printer this particular browser
 * profile happens to be paired with. The per-device thermal width lives in
 * lib/receipts/printer-config.ts (Rule 4) and applies to the THERMAL BITMAP
 * only — see that file's header for the full separation.
 *
 * The route re-validates every one of these bounds independently and never
 * trusts a client-supplied copy of them (the same posture
 * app/api/upload/receipt/route.ts already takes toward client-claimed
 * content types): a client-side constant is a UX nicety, never a security
 * boundary.
 */

/**
 * Fixed raster width for the cached PDF artifact, in pixels at 203 dpi
 * (80 mm thermal paper). Chosen to match the most common 80 mm thermal
 * print head so a PDF and a thermal print of the same invoice read the same
 * way — but pinned here as a CONSTANT precisely so no device's configured
 * dots-per-line can ever change it.
 *
 * NOTE: 576px at 203dpi is ~72mm — the printable area of an 80mm thermal
 * head, not the full 80mm paper width (a thermal head cannot print to the
 * physical edge of the paper). RECEIPT_PDF_PAGE_WIDTH_PT below is
 * deliberately based on the full 80mm instead: see pdf.ts for why the two
 * numbers differ on purpose and how that's reconciled when the raster is
 * placed on the page.
 */
export const RECEIPT_PDF_RASTER_WIDTH = 576;

/** 8-pixel (1 byte) alignment is required by every ESC/POS raster mode. */
export const RASTER_PIXEL_ALIGNMENT = 8;

export const MIN_RECEIPT_RASTER_HEIGHT = 200;

/**
 * A pathological ceiling, not a layout expectation: a 576-px-wide receipt
 * with hundreds of line items is still well under 2,000 px tall. Anything
 * past this is a malformed/hostile upload, refused before any decode.
 */
export const MAX_RECEIPT_RASTER_HEIGHT = 12_000;

/** 1 MB — a 576 × 4000 grayscale PNG of pure text is ~100 KB. */
export const MAX_RECEIPT_RASTER_BYTES = 1_048_576;

/**
 * MIME type of the intermediate client-rendered raster (the file uploaded
 * to POST /api/invoices/[id]/receipt as the `raster` field) — NOT the MIME
 * type of the final cached PDF artifact. Named RECEIPT_RASTER_MIME
 * (previously, incorrectly, RECEIPT_PDF_MIME) specifically so nothing
 * mistakes this for the Content-Type of Invoice.receiptPdfUrl.
 */
export const RECEIPT_RASTER_MIME = "image/png";

/**
 * MIME type of the final, cached PDF artifact — Invoice.receiptPdfUrl.
 * Distinct from RECEIPT_RASTER_MIME above; do not conflate the two when
 * setting a Content-Type header or storing/serving the cached file.
 */
export const RECEIPT_PDF_MIME = "application/pdf";

/** The 8-byte PNG signature (RFC 2083 §3.1), as a plain number array so this
 * module stays usable from both the browser and the Node runtime. */
export const PNG_MAGIC_BYTES: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
];

/** Byte offsets inside a well-formed PNG, for the header checks below. */
export const PNG_IHDR_TYPE_OFFSET = 12; // "IHDR" chunk type
export const PNG_WIDTH_OFFSET = 16; // IHDR width,  big-endian uint32
export const PNG_HEIGHT_OFFSET = 20; // IHDR height, big-endian uint32

/**
 * 80 mm page width in PDF points (80 mm / 25.4 × 72) — the FULL paper width,
 * deliberately larger than RECEIPT_PDF_RASTER_WIDTH's ~72mm printable area.
 * See pdf.ts: the raster is scaled uniformly (aspect ratio preserved) to
 * fill this page edge-to-edge, since a PDF viewed on screen has no
 * thermal-head mechanical margin to reproduce.
 */
export const RECEIPT_PDF_PAGE_WIDTH_PT = (80 / 25.4) * 72;