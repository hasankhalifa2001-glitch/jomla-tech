/**
 * T4f addendum — Rule 4, at the BYTE level: the ESC/POS raster the printer
 * actually receives must describe exactly the configured dots-per-line.
 *
 *   COVERAGE → ACCEPTANCE CRITERIA
 *   1. bytes-per-row is derived, never assumed: 576 → 72, 384 → 48, and a width
 *      that is not a whole number of bytes THROWS (a silent round would produce
 *      exactly the clipped receipt Rule 4 exists to prevent).
 *   2. The GS v 0 band header carries the width in BYTES, little-endian, and the
 *      row count likewise.
 *   3. A raster whose width disagrees with the configured width is refused
 *      before any byte is written — no scaling, no cropping.
 *   4. Pixel packing is MSB-first (leftmost dot in the high bit) and a
 *      transparent pixel prints as paper, not ink.
 *   5. A receipt taller than one GS v 0 band (255 rows) streams as multiple
 *      bands, each with its own correct header.
 *
 * Everything here is pure byte arithmetic — no canvas, no DOM, no Bluetooth —
 * which is precisely why the encoder was separated from the transport.
 */

import { describe, it, expect } from "vitest";

import {
  ESC_POS_MAX_BAND_ROWS,
  assertRasterMatchesConfiguredWidth,
  buildRasterCommands,
  buildTestPatternRaster,
  bytesPerRowForWidth,
  toMonochromeRaster,
  type MonochromeRaster,
} from "@/lib/receipts/escpos";

const WIDTH_80MM = 576;
const WIDTH_58MM = 384;

describe("Rule 4 — bytes per row is derived from the confirmed width", () => {
  it("maps the two supported widths to their byte counts", () => {
    expect(bytesPerRowForWidth(WIDTH_80MM)).toBe(72);
    expect(bytesPerRowForWidth(WIDTH_58MM)).toBe(48);
  });

  it("refuses a width that is not a whole number of bytes", () => {
    expect(() => bytesPerRowForWidth(570)).toThrow(/multiple of 8/);
    expect(() => bytesPerRowForWidth(0)).toThrow();
    expect(() => bytesPerRowForWidth(-384)).toThrow();
    expect(() => bytesPerRowForWidth(1.5)).toThrow();
  });
});

describe("Rule 4 — the calibration pattern exists at both widths", () => {
  for (const dotsPerLine of [WIDTH_80MM, WIDTH_58MM]) {
    it(`builds a ${dotsPerLine}-dot pattern whose payload matches its own width`, () => {
      const raster = buildTestPatternRaster(dotsPerLine, 240);
      const bytesPerRow = bytesPerRowForWidth(dotsPerLine);

      expect(raster.widthDots).toBe(dotsPerLine);
      expect(raster.heightDots).toBe(240);
      expect(raster.data.length).toBe(bytesPerRow * 240);

      // The border is what makes a mis-sized bitmap visible on paper: the
      // leftmost dot of row 0 sits in the high bit of byte 0, and the rightmost
      // dot sits in the low bit of that row's last byte.
      expect(raster.data[0] & 0x80).toBe(0x80);
      expect(raster.data[bytesPerRow - 1] & 0x01).toBe(0x01);

      // And nothing is written outside the configured width.
      expect(() => assertRasterMatchesConfiguredWidth(raster, dotsPerLine)).not.toThrow();
    });
  }
});

describe("Rule 4 — the encoder writes the width into the band header", () => {
  for (const dotsPerLine of [WIDTH_80MM, WIDTH_58MM]) {
    it(`encodes a job for ${dotsPerLine} dots`, () => {
      const bytesPerRow = bytesPerRowForWidth(dotsPerLine);
      const raster = buildTestPatternRaster(dotsPerLine, 200);
      const job = buildRasterCommands(raster, { feedLines: 4, cut: true });

      // ESC @ — initialize.
      expect(Array.from(job.slice(0, 2))).toEqual([0x1b, 0x40]);

      // GS v 0 m xL xH yL yH — width in BYTES, little-endian, then row count.
      expect(Array.from(job.slice(2, 6))).toEqual([0x1d, 0x76, 0x30, 0x00]);
      expect(job[6]).toBe(bytesPerRow & 0xff);
      expect(job[7]).toBe((bytesPerRow >> 8) & 0xff);
      expect(job[8]).toBe(200 & 0xff);
      expect(job[9]).toBe(0);

      // ESC d 4 — feed four lines clear of the print head.
      expect(Array.from(job.slice(-7, -4))).toEqual([0x1b, 0x64, 4]);
      // GS V B 0 — partial cut.
      expect(Array.from(job.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x00]);

      // 2 (init) + 8 (header) + payload + 3 (feed) + 4 (cut).
      expect(job.length).toBe(2 + 8 + bytesPerRow * 200 + 3 + 4);
    });
  }

  it("chunks a tall receipt into multiple bands, each with its own header", () => {
    const raster = buildTestPatternRaster(WIDTH_80MM, ESC_POS_MAX_BAND_ROWS + 45);
    const job = buildRasterCommands(raster, { cut: false });
    const bytesPerRow = bytesPerRowForWidth(WIDTH_80MM);

    let occurrences = 0;
    for (let i = 0; i < job.length - 3; i += 1) {
      if (job[i] === 0x1d && job[i + 1] === 0x76 && job[i + 2] === 0x30) occurrences += 1;
    }
    expect(occurrences).toBe(2);

    expect(job.length).toBe(
      2 + (8 + bytesPerRow * ESC_POS_MAX_BAND_ROWS) + (8 + bytesPerRow * 45) + 3
    );
  });
});

describe("Rule 4 — a wrong-width bitmap is refused, never scaled", () => {
  it("throws when the raster disagrees with the configured width", () => {
    const wide = buildTestPatternRaster(WIDTH_80MM, 120);

    expect(() => assertRasterMatchesConfiguredWidth(wide, WIDTH_80MM)).not.toThrow();
    expect(() => assertRasterMatchesConfiguredWidth(wide, WIDTH_58MM)).toThrow(
      /does not match the print head/
    );
  });

  it("throws when the payload is truncated for the declared height", () => {
    const raster = buildTestPatternRaster(WIDTH_80MM, 120);
    const truncated: MonochromeRaster = {
      widthDots: raster.widthDots,
      heightDots: raster.heightDots,
      data: raster.data.slice(0, raster.data.length - 10),
    };

    expect(() => assertRasterMatchesConfiguredWidth(truncated, WIDTH_80MM)).toThrow();
  });

  it("toMonochromeRaster refuses a source image of the wrong width", () => {
    expect(() =>
      toMonochromeRaster(
        { data: new Uint8Array(10), width: 10, height: 1, channels: 1 },
        { widthDots: 8 }
      )
    ).toThrow(/refusing to scale or crop/);
  });
});

describe("Rule 4 — pixel packing", () => {
  it("packs MSB-first, so the leftmost dot is the high bit", () => {
    const raster = toMonochromeRaster(
      {
        data: new Uint8Array([0, 255, 255, 255, 255, 255, 255, 0]),
        width: 8,
        height: 1,
        channels: 1,
      },
      { widthDots: 8 }
    );

    expect(Array.from(raster.data)).toEqual([0b10000001]);
  });

  it("prints a fully transparent pixel as paper, not ink", () => {
    // 8 dots wide (so the width check passes), RGBA. Pixel 0 is OPAQUE black —
    // ink. Pixel 1 is TRANSPARENT black: naively reading its RGB would burn a
    // dot, so it must composite to paper. Whatever the alpha bug would be, this
    // byte is the difference between 0x80 and 0xC0.
    const data = new Uint8Array(8 * 4);
    data.set([0, 0, 0, 255], 0); // opaque black
    data.set([0, 0, 0, 0], 4); // transparent black

    const raster = toMonochromeRaster(
      { data, width: 8, height: 1, channels: 4 },
      { widthDots: 8 }
    );

    expect(Array.from(raster.data)).toEqual([0b10000000]);
  });
});
