"use client";

/**
 * components/receipts/receipt-canvas.ts
 *
 * T4f — the ONLY place a receipt becomes pixels. Everything upstream of this
 * file is pure and unit-tested (receipt-model → receipt-layout); everything
 * downstream is a byte stream (escpos.ts) that is also unit-tested. The canvas
 * is the one irreducibly browser-bound step, so it is kept as thin as
 * possible:
 *
 *   - It owns exactly three decisions: which font stack, which colors, and
 *     where the three alignments anchor. Layout owns everything else.
 *   - It provides the real width measurer to the pure layout engine
 *     (`ctx.measureText`), which is the seam that lets the whole layout be
 *     tested in Node with a stub measurer — see receipt-layout.ts's header.
 *   - It never chooses a width. The caller passes `widthPx`: the confirmed
 *     per-device dots-per-line for thermal printing (Rule 4), or
 *     lib/receipts/constraints.ts's fixed RECEIPT_PDF_RASTER_WIDTH for the
 *     shared PDF. A source image whose width disagrees with the configured
 *     width then fails loudly in escpos.ts's toMonochromeRaster() rather than
 *     being scaled.
 *
 * [RTL AND ARABIC SHAPING] `ctx.direction = "rtl"` plus physical
 * left/right/center anchors means Arabic is shaped and ordered by the
 * browser's own text engine — which is precisely why the PDF strategy is
 * "raster here, wrap server-side" (the approved plan's Condition 1/2): no
 * server font, no shaper, no bidi library can render Arabic as correctly as
 * the browser that already displays it.
 *
 * [FONT LOADING] The app's Arabic UI font (Cairo) is loaded by next/font and
 * may not be ready on the first paint of a cold page. Rendering a receipt
 * before it resolves would silently fall back to a system font, changing every
 * line's width — so both public functions await document.fonts.ready first.
 */

import {
  DEFAULT_RECEIPT_FONTS,
  layoutReceipt,
  type ReceiptFontSet,
  type ReceiptLayout,
  type ReceiptMeasurer,
} from "@/lib/receipts/receipt-layout";
import { toMonochromeRaster, type MonochromeRaster } from "@/lib/receipts/escpos";
import {
  RECEIPT_PDF_RASTER_WIDTH,
} from "@/lib/receipts/constraints";
import type { ReceiptModel } from "@/lib/receipts/receipt-model";

const RECEIPT_FONT_STACK = "Cairo, Tajawal, 'Segoe UI', system-ui, sans-serif";

const TONE_COLORS: Record<string, string> = {
  normal: "#111827",
  primary: "#065f46",
  muted: "#6b7280",
  warn: "#92400e",
  danger: "#b91c1c",
};

function createCanvas(widthPx: number, heightPx: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(widthPx));
  canvas.height = Math.max(1, Math.round(heightPx));
  return canvas;
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("تعذّر إنشاء سياق الرسم (canvas 2D) في هذا المتصفح.");
  }
  // RTL text shaping/ordering is delegated to the browser's text engine.
  ctx.direction = "rtl";
  return ctx;
}

/** The real measurer handed to the pure layout engine. */
export function createCanvasMeasurer(
  ctx: CanvasRenderingContext2D
): ReceiptMeasurer {
  return (text, fontPx, bold) => {
    ctx.font = `${bold ? "700" : "400"} ${fontPx}px ${RECEIPT_FONT_STACK}`;
    return ctx.measureText(text).width;
  };
}

async function waitForFonts(): Promise<void> {
  if (typeof document === "undefined") return;
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  try {
    await fonts.ready;
  } catch {
    // A font-loading failure must not block printing: the system fallback is
    // measured correctly by the same canvas, so the layout stays consistent.
  }
}

export interface RenderedReceipt {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  layout: ReceiptLayout;
}

/**
 * Lays the model out at exactly `widthPx` and paints it onto a white canvas.
 * Returns the context so callers can read the pixels back without creating a
 * second (differently configured) context.
 */
export function renderReceiptToCanvas(
  model: ReceiptModel,
  options: { widthPx: number; fonts?: ReceiptFontSet; paddingPx?: number }
): RenderedReceipt {
  const fonts = options.fonts ?? DEFAULT_RECEIPT_FONTS;

  // Scratch context purely for measuring; layout does not draw.
  const measure = createCanvasMeasurer(get2dContext(createCanvas(1, 1)));
  const layout = layoutReceipt(model, {
    widthPx: options.widthPx,
    measure,
    fonts,
    paddingPx: options.paddingPx,
  });

  const canvas = createCanvas(options.widthPx, layout.heightPx);
  const ctx = get2dContext(canvas);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "top";

  for (const op of layout.ops) {
    if (op.kind === "divider") {
      ctx.save();
      ctx.strokeStyle = "#9ca3af";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(0, op.y + 1);
      ctx.lineTo(canvas.width, op.y + 1);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    // Physical anchors, never direction-relative ones: "start" is the RTL
    // right edge, "end" is the left edge, regardless of the direction flag.
    ctx.textAlign =
      op.align === "start" ? "right" : op.align === "end" ? "left" : "center";

    const anchorX =
      op.align === "start"
        ? layout.widthPx - layout.paddingPx
        : op.align === "end"
          ? layout.paddingPx
          : layout.widthPx / 2;

    ctx.fillStyle = TONE_COLORS[op.tone] ?? TONE_COLORS.normal;
    // A reversed line is bolded as well as labelled (Rule 5: the label itself
    // is already in the text — this only makes it catch the eye on paper).
    ctx.font = `${op.bold || op.isReturn ? "700" : "400"} ${op.fontPx}px ${RECEIPT_FONT_STACK}`;
    ctx.fillText(op.text, anchorX, op.y + (op.heightPx - op.fontPx) / 2);
  }

  return { canvas, ctx, layout };
}

/**
 * The thermal path: a 1-bit raster whose width is EXACTLY `dotsPerLine`.
 *
 * The width check is not performed here — it is performed by
 * toMonochromeRaster() (which throws if the canvas width disagrees) and again
 * by assertRasterMatchesConfiguredWidth() immediately before the bytes are
 * written, so a mis-sized bitmap can never reach a print head.
 */
export async function rasterizeReceipt(
  model: ReceiptModel,
  options: { dotsPerLine: number; fonts?: ReceiptFontSet; paddingPx?: number }
): Promise<MonochromeRaster> {
  await waitForFonts();

  const { canvas, ctx } = renderReceiptToCanvas(model, {
    widthPx: options.dotsPerLine,
    fonts: options.fonts,
    paddingPx: options.paddingPx,
  });

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);

  return toMonochromeRaster(
    {
      data: image.data,
      width: image.width,
      height: image.height,
      channels: 4,
    },
    { widthDots: options.dotsPerLine }
  );
}

/**
 * The share/PDF path: a PNG sized to the FIXED, device-independent
 * RECEIPT_PDF_RASTER_WIDTH — never the local printer's dots-per-line, since
 * the cached artifact is shared across devices (see constraints.ts).
 */
export async function renderReceiptPngBlob(
  model: ReceiptModel,
  options: { widthPx?: number; fonts?: ReceiptFontSet } = {}
): Promise<{ blob: Blob; widthPx: number; heightPx: number }> {
  await waitForFonts();

  const widthPx = options.widthPx ?? RECEIPT_PDF_RASTER_WIDTH;
  const { canvas, layout } = renderReceiptToCanvas(model, {
    widthPx,
    fonts: options.fonts,
  });

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), "image/png");
  });

  if (!blob) {
    throw new Error("تعذّر توليد صورة الإيصال (PNG) من المتصفح.");
  }

  return { blob, widthPx, heightPx: layout.heightPx };
}
