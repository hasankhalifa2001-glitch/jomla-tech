/**
 * lib/receipts/escpos.ts
 *
 * T4f — the ESC/POS raster encoder: a monochrome bitmap in, printer command
 * bytes out. PURE and transport-free by design.
 *
 * WHY THE ENCODER IS SEPARATE FROM THE BLUETOOTH TRANSPORT:
 * Rule 4's acceptance criterion is "print output bitmap width exactly matches
 * the configured dots-per-line value for both 80mm and 58mm settings, verified
 * against physical/simulated output at each width." A byte stream is
 * verifiable by assertion; a Bluetooth write is not. So the transport
 * (lib/receipts/bluetooth-printer.ts) is a thin, dumb pipe that ships bytes
 * this file produced, and everything interesting — the width, the band
 * headers, the bit packing — is checkable in a plain Node test with no
 * hardware, no DOM, and no mock of the Web Bluetooth stack.
 *
 * COMMAND REFERENCE (Epson ESC/POS, the de-facto standard every cheap 58/80mm
 * BLE printer implements):
 *   ESC @             1B 40                 initialize
 *   GS v 0 m xL xH yL yH <data>            1D 76 30 ...  raster bit image
 *   ESC d n           1B 64 n               feed n lines
 *   GS V B n          1D 56 42 00           partial cut
 *
 * GS v 0 packs 8 horizontally-adjacent dots per byte, MSB first, leftmost
 * pixel in the highest bit, and takes the WIDTH IN BYTES (not dots) as a
 * little-endian 16-bit pair. That is the single place a "576 vs 384" mistake
 * could hide, so bytesPerRowForWidth() below is the only function in the
 * codebase allowed to compute it, and tests assert it against both configured
 * widths.
 */

import { RASTER_PIXEL_ALIGNMENT } from "./constraints";

export const ESC_POS_INIT = 0x1b; // ESC
export const ESC_POS_GS = 0x1d; // GS

/**
 * Per-band row cap actually enforced by this encoder. The GS v 0 protocol
 * itself allows up to 65535 rows per band (yL/yH is a 16-bit little-endian
 * pair, not a single byte) — 255 here is a deliberately conservative safety
 * margin against cheap 58/80mm printers' small raster input buffers, not a
 * protocol limit. Splitting into more, smaller bands than the protocol
 * strictly requires costs a little header overhead; it never risks a
 * malformed or truncated raster.
 */
export const ESC_POS_MAX_BAND_ROWS = 255;

/** Conservative BLE ATT payload: the default 23-byte MTU minus 3 bytes of
 * header. See bluetooth-printer.ts for why writes are chunked at all. */
export const BLE_DEFAULT_CHUNK_BYTES = 20;

/** A monochrome bitmap: 1 bit per pixel, MSB-first, one byte per 8 pixels,
 * row-major. Bit set = black dot = burned pixel. */
export interface MonochromeRaster {
  /** Must equal the printer's configured dots-per-line. */
  widthDots: number;
  heightDots: number;
  /** length === bytesPerRowForWidth(widthDots) * heightDots */
  data: Uint8Array;
}

export interface RgbImageLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** 4 = RGBA (a real canvas), 1 = grayscale. */
  channels: 1 | 4;
}

/**
 * The ONLY place a dots-per-line value becomes bytes-per-row. Thermal print
 * heads address whole bytes per line, so a width that is not a multiple of 8
 * cannot be printed as configured and must fail loudly rather than silently
 * round (which would produce exactly the "bitmap width doesn't match the
 * printer" defect Rule 4 exists to prevent).
 */
export function bytesPerRowForWidth(dotsPerLine: number): number {
  if (!Number.isInteger(dotsPerLine) || dotsPerLine <= 0) {
    throw new Error(
      `ESC/POS: dots-per-line must be a positive integer, received ${dotsPerLine}.`
    );
  }
  if (dotsPerLine % RASTER_PIXEL_ALIGNMENT !== 0) {
    throw new Error(
      `ESC/POS: dots-per-line must be a multiple of ${RASTER_PIXEL_ALIGNMENT} (one byte per 8 dots), received ${dotsPerLine}.`
    );
  }
  return dotsPerLine / RASTER_PIXEL_ALIGNMENT;
}

/**
 * Converts an RGBA/grayscale canvas image into a 1-bit raster of exactly
 * `widthDots` dots per row.
 *
 * [NO SCALING, EVER] A source whose width differs from `widthDots` is a bug
 * upstream (the canvas was created at the wrong size), not something to paper
 * over: cropping or scaling here would produce output that "works" while
 * quietly not matching the printer's print head, which is the exact failure
 * Rule 4 forbids. So it throws.
 */
export function toMonochromeRaster(
  image: RgbImageLike,
  options: { widthDots: number; threshold?: number }
): MonochromeRaster {
  const { widthDots } = options;
  // Throws for a non-byte-aligned width, before any pixel work.
  const bytesPerRow = bytesPerRowForWidth(widthDots);
  const threshold = options.threshold ?? 128;

  if (image.width !== widthDots) {
    throw new Error(
      `ESC/POS: source image is ${image.width}px wide but the printer is configured for ${widthDots} dots per line — refusing to scale or crop.`
    );
  }
  if (image.height <= 0) {
    throw new Error(`ESC/POS: source image has no rows (${image.height}).`);
  }

  const { data, height, channels } = image;
  const expectedLength = widthDots * height * channels;
  if (data.length < expectedLength) {
    throw new Error(
      `ESC/POS: pixel buffer is ${data.length} bytes, expected at least ${expectedLength} for ${widthDots}×${height} at ${channels} channel(s).`
    );
  }

  const out = new Uint8Array(bytesPerRow * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * bytesPerRow;

    for (let x = 0; x < widthDots; x += 1) {
      const pixelIndex = (y * widthDots + x) * channels;
      let luminance: number;

      if (channels === 1) {
        luminance = data[pixelIndex];
      } else {
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        const a = data[pixelIndex + 3];
        // Composite onto white first: a transparent pixel inside a receipt
        // must print as paper, never as ink.
        const alpha = a / 255;
        const composited = (channel: number) => channel * alpha + 255 * (1 - alpha);
        luminance =
          0.299 * composited(r) + 0.587 * composited(g) + 0.114 * composited(b);
      }

      if (luminance < threshold) {
        // MSB-first: pixel 0 of the byte is the leftmost dot.
        out[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return { widthDots, heightDots: height, data: out };
}

/** Splits a byte stream into transport-sized writes (BLE ATT payloads). */
export function chunkBytes(
  bytes: Uint8Array,
  chunkSize: number = BLE_DEFAULT_CHUNK_BYTES
): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`ESC/POS: chunk size must be a positive integer, received ${chunkSize}.`);
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return chunks;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The 8-byte GS v 0 header for one band:
 *   1D 76 30 00, then the row width in BYTES as a little-endian pair, then the
 *   band's row count as a little-endian pair.
 */
export function rasterBandHeader(bytesPerRow: number, bandRows: number): Uint8Array {
  if (bytesPerRow <= 0 || bytesPerRow > 0xffff) {
    throw new Error(`ESC/POS: bytes-per-row ${bytesPerRow} does not fit the GS v 0 width field.`);
  }
  if (bandRows <= 0 || bandRows > ESC_POS_MAX_BAND_ROWS) {
    throw new Error(
      `ESC/POS: band height ${bandRows} must be between 1 and ${ESC_POS_MAX_BAND_ROWS} rows.`
    );
  }

  return new Uint8Array([
    ESC_POS_GS,
    0x76,
    0x30,
    0x00,
    bytesPerRow & 0xff,
    (bytesPerRow >> 8) & 0xff,
    bandRows & 0xff,
    (bandRows >> 8) & 0xff,
  ]);
}

export interface BuildRasterOptions {
  /** Rows per GS v 0 block. Defaults to the protocol maximum. */
  maxBandRows?: number;
  /** Blank lines fed after the image, so the receipt clears the print head. */
  feedLines?: number;
  /** Send the partial-cut command at the end. */
  cut?: boolean;
}

/**
 * Encodes a raster as a complete, ready-to-write ESC/POS job: initialize,
 * one or more GS v 0 bands, feed, optional cut.
 *
 * The band count and each band's row header are derived from the raster's own
 * height, so a receipt of any length streams correctly — and the row WIDTH is
 * taken from the raster's `widthDots` via bytesPerRowForWidth(), meaning the
 * bytes on the wire can only ever describe the configured width.
 */
export function buildRasterCommands(
  raster: MonochromeRaster,
  options: BuildRasterOptions = {}
): Uint8Array {
  const bytesPerRow = bytesPerRowForWidth(raster.widthDots);
  const maxBandRows = options.maxBandRows ?? ESC_POS_MAX_BAND_ROWS;
  const feedLines = options.feedLines ?? 4;

  // ESC d n's n is a single byte (0-255). A value outside that range would
  // previously be silently truncated by the `& 0xff` mask below (e.g. 260
  // would become 4) — now it fails loudly instead, consistent with every
  // other width/size validation in this file.
  if (!Number.isInteger(feedLines) || feedLines < 0 || feedLines > 0xff) {
    throw new Error(
      `ESC/POS: feedLines must be an integer between 0 and 255, received ${feedLines}.`
    );
  }

  if (raster.data.length !== bytesPerRow * raster.heightDots) {
    throw new Error(
      `ESC/POS: raster buffer is ${raster.data.length} bytes but ${bytesPerRow} bytes/row × ${raster.heightDots} rows = ${bytesPerRow * raster.heightDots
      } was expected.`
    );
  }

  const parts: Uint8Array[] = [new Uint8Array([ESC_POS_INIT, 0x40])];

  for (let startRow = 0; startRow < raster.heightDots; startRow += maxBandRows) {
    const bandRows = Math.min(maxBandRows, raster.heightDots - startRow);
    parts.push(rasterBandHeader(bytesPerRow, bandRows));
    parts.push(
      raster.data.slice(startRow * bytesPerRow, (startRow + bandRows) * bytesPerRow)
    );
  }

  parts.push(new Uint8Array([ESC_POS_INIT, 0x64, feedLines & 0xff]));
  if (options.cut) {
    parts.push(new Uint8Array([ESC_POS_GS, 0x56, 0x42, 0x00]));
  }

  return concatBytes(parts);
}

/**
 * The last gate before bytes reach a print head: the raster must describe
 * exactly the width the device is configured for (Rule 4), or nothing is
 * written at all. Called by the print pipeline —
 * see components/receipts/receipt-actions.tsx.
 */
export function assertRasterMatchesConfiguredWidth(
  raster: MonochromeRaster,
  configuredDotsPerLine: number
): void {
  if (raster.widthDots !== configuredDotsPerLine) {
    throw new Error(
      `ESC/POS: raster is ${raster.widthDots} dots wide but this device is configured for ${configuredDotsPerLine} dots per line — refusing to print a bitmap whose width does not match the print head.`
    );
  }

  const expectedBytes = bytesPerRowForWidth(configuredDotsPerLine) * raster.heightDots;
  if (raster.data.length !== expectedBytes) {
    throw new Error(
      `ESC/POS: raster payload is ${raster.data.length} bytes, expected ${expectedBytes} for ${configuredDotsPerLine
      } dots × ${raster.heightDots} rows.`
    );
  }
}

/**
 * A calibration pattern, at an explicitly chosen width: a border, evenly
 * spaced tick marks every 64 dots, and an 8-dot checkerboard. Exists so Rule
 * 4's "verified against physical/simulated output at each width" criterion
 * has something objective to look at — a mis-sized bitmap shows up
 * immediately as a clipped border or a skipped tick, on paper, without
 * printing a real invoice.
 */
export function buildTestPatternRaster(
  dotsPerLine: number,
  heightDots = 240
): MonochromeRaster {
  const bytesPerRow = bytesPerRowForWidth(dotsPerLine);
  const data = new Uint8Array(bytesPerRow * heightDots);

  const setPixel = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= dotsPerLine || y >= heightDots) return;
    data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
  };

  for (let y = 0; y < heightDots; y += 1) {
    for (let thickness = 0; thickness < 2; thickness += 1) {
      setPixel(thickness, y);
      setPixel(dotsPerLine - 1 - thickness, y);
    }
  }
  for (let x = 0; x < dotsPerLine; x += 1) {
    for (let thickness = 0; thickness < 2; thickness += 1) {
      setPixel(x, thickness);
      setPixel(x, heightDots - 1 - thickness);
    }
  }

  const tickTop = 40;
  for (let x = 0; x < dotsPerLine; x += 64) {
    for (let y = tickTop; y < tickTop + 40; y += 1) {
      setPixel(x, y);
      setPixel(x + 1, y);
    }
  }

  const checkerTop = 120;
  const checkerBottom = 200;
  for (let y = checkerTop; y < checkerBottom; y += 1) {
    for (let x = 0; x < dotsPerLine; x += 1) {
      if (((x >> 3) + (y >> 3)) % 2 === 0) setPixel(x, y);
    }
  }

  return { widthDots: dotsPerLine, heightDots, data };
}