/**
 * lib/receipts/receipt-layout.ts
 *
 * T4f — the pure geometry pass: ReceiptModel (semantic blocks) → a flat,
 * absolutely-positioned list of draw operations for a canvas of a known pixel
 * width.
 *
 * WHY A SEPARATE, MEASURER-INJECTED MODULE:
 * The one thing that makes text layout untestable is reading font metrics off
 * a real canvas — which needs a DOM, which this repo's vitest environment
 * (vitest.config.ts: `environment: "node"`, no jsdom) deliberately does not
 * have. So the measuring step is INJECTED (`ReceiptMeasurer`) rather than
 * imported: the browser passes `ctx.measureText(...).width`, and a unit test
 * passes `(text) => text.length * 8`. Both call the identical wrapping,
 * row-splitting and width-verification code, which is what makes the Rule 5 /
 * Condition 4 acceptance criteria ("مرتجع: N unit", absolute values, correct
 * at BOTH 80 mm and 58 mm) verifiable without a browser.
 *
 * [FAIL-LOUD WIDTH INVARIANT] Per Rule 4, a receipt's bitmap width must match
 * the configured dots-per-line exactly. Layout is where that can silently go
 * wrong (a long product name or a two-column total row that overflows), and a
 * silently clipped receipt is worse than a loud failure — so every emitted
 * text op is re-measured against the content width and layout THROWS if one
 * exceeds it. Long unbreakable tokens are hard-split inside wrapText(), so
 * this assertion is reachable only by a genuine bug.
 *
 * [DESIGN FIX — visual density pass] The original constants produced a
 * cramped receipt: 12px page padding, a single reused 6px gap regardless of
 * whether it separated two lines of the same block or two whole sections, and
 * the total row was only marginally bigger than everything else. This pass:
 *   - widens the page margin (12 → 22px) so nothing sits flush against the
 *     physical/PDF edge;
 *   - introduces distinct named gaps for a section boundary (SECTION_GAP_PX,
 *     used after the title and around dividers) versus an in-item gap
 *     (ITEM_GAP_PX, used after each item block) instead of one magic "6"
 *     reused everywhere;
 *   - gives the primary total row its own top gap plus a further-enlarged
 *     font, so "إجمالي الفاتورة" reads as the one clear focal point.
 * No block ordering or business logic changed — only WHERE and HOW MUCH
 * vertical space each op gets.
 */

import type { ReceiptBlock, ReceiptModel } from "./receipt-model";

export type ReceiptMeasurer = (
  text: string,
  fontPx: number,
  bold: boolean
) => number;

export interface ReceiptFontSet {
  title: number;
  subtitle: number;
  body: number;
  small: number;
}

/** Sized for a 576-dot (80 mm @ 203 dpi) canvas; scaled by the caller if a
 * narrower head is configured — see receipt-canvas.ts.
 * [DESIGN FIX] title bumped 34→38 (more presence as the one centered line),
 * subtitle trimmed 22→20 (more contrast against title/body — meta info now
 * reads clearly as secondary), body/small unchanged. */
export const DEFAULT_RECEIPT_FONTS: ReceiptFontSet = {
  title: 38,
  subtitle: 20,
  body: 26,
  small: 22,
};

export type ReceiptTone = "normal" | "warn" | "danger" | "muted" | "primary";

export interface ReceiptTextOp {
  kind: "text";
  text: string;
  /**
   * "start" = the RTL start edge (right), "end" = the left edge, "center" =
   * centered — used for the document title only. All three are expressed as an
   * intent, so the canvas renderer (components/receipts/receipt-canvas.ts)
   * remains the single place that knows about `textAlign`.
   */
  align: "start" | "center" | "end";
  fontPx: number;
  bold: boolean;
  /** Inclusive top edge, in pixels from the top of the bitmap. */
  y: number;
  heightPx: number;
  tone: ReceiptTone;
  /** Rule 5 — set for a reversed line so the renderer can add the badge/bold. */
  isReturn: boolean;
}

export interface ReceiptDividerOp {
  kind: "divider";
  y: number;
  heightPx: number;
}

export type ReceiptOp = ReceiptTextOp | ReceiptDividerOp;

export interface LayoutReceiptOptions {
  /** Full bitmap width in pixels — the configured dots-per-line, or the fixed
   * PDF raster width. Every op is guaranteed to fit inside this. */
  widthPx: number;
  measure: ReceiptMeasurer;
  fonts?: ReceiptFontSet;
  paddingPx?: number;
}

export interface ReceiptLayout {
  widthPx: number;
  heightPx: number;
  /** The left/right margin used, so renderers can anchor to the same gutters. */
  paddingPx: number;
  ops: ReceiptOp[];
}

// [DESIGN FIX] 12 → 22. The old margin left almost no breathing room on
// either physical (thermal) or digital (PDF) edge of the receipt.
const DEFAULT_PADDING_PX = 22;

// [DESIGN FIX] Named gaps instead of one reused magic "6" everywhere. A
// section boundary (after the title, around a divider) now reads as visually
// distinct from a tight in-block line gap, and each item block gets its own
// breathing room before the next one starts.
const SECTION_GAP_PX = 14;
const ITEM_GAP_PX = 12;
const DIVIDER_MARGIN_PX = 10;

function fontFor(block: ReceiptBlock, fonts: ReceiptFontSet): { px: number; bold: boolean } {
  switch (block.type) {
    case "title":
      return { px: fonts.title, bold: true };
    case "subtitle":
      return { px: fonts.subtitle, bold: false };
    case "item":
      return { px: fonts.body, bold: false };
    default:
      return { px: fonts.body, bold: false };
  }
}

/**
 * Greedy word wrap with a hard-split fallback for a token longer than the
 * available width (a 60-character product name on 58 mm paper). Every returned
 * line is guaranteed to measure <= maxWidthPx.
 */
export function wrapText(
  text: string,
  maxWidthPx: number,
  measure: (candidate: string) => number
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [""];

  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  const push = (line: string) => {
    if (line) lines.push(line);
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidthPx) {
      current = candidate;
      continue;
    }

    push(current);
    current = "";

    if (measure(word) <= maxWidthPx) {
      current = word;
      continue;
    }

    // Hard split: grow the chunk one character at a time while it still fits.
    let rest = word;
    while (rest.length > 0) {
      let take = 1;
      while (take < rest.length && measure(rest.slice(0, take + 1)) <= maxWidthPx) {
        take += 1;
      }
      const chunk = rest.slice(0, take);
      rest = rest.slice(take);
      if (rest.length === 0) current = chunk;
      else push(chunk);
    }
  }

  push(current);
  return lines.length > 0 ? lines : [""];
}

/** Pure stateful cursor used to stack ops top-to-bottom. */
class LayoutCursor {
  y = 0;
  readonly ops: ReceiptOp[] = [];

  constructor(private readonly padding: number) {
    this.y = padding;
  }

  get paddingPx(): number {
    return this.padding;
  }

  pushText(op: Omit<ReceiptTextOp, "kind">): void {
    this.ops.push({ kind: "text", ...op });
    this.y += op.heightPx;
  }

  pushSpacer(heightPx: number): void {
    this.y += heightPx;
  }

  /**
   * [DESIGN FIX] Gap BEFORE the divider line too (previously the divider sat
   * flush against whatever came before it — only a post-gap existed), and the
   * post-gap widened from 6 to DIVIDER_MARGIN_PX, so a divider reads as an
   * actual section break rather than a thin rule wedged between two lines.
   */
  pushDivider(): void {
    this.y += DIVIDER_MARGIN_PX;
    this.ops.push({ kind: "divider", y: this.y, heightPx: 2 });
    this.y += DIVIDER_MARGIN_PX;
  }
}

/** Emits a text op without advancing the cursor (two ops can share a line). */
function emit(
  cursor: LayoutCursor,
  op: Omit<ReceiptTextOp, "kind">
): void {
  cursor.ops.push({ kind: "text", ...op });
}

function lineHeightFor(fontPx: number): number {
  return Math.ceil(fontPx * 1.45);
}

/**
 * Lays out a `row` block (label + value). On a wide-enough canvas the two sit
 * on one line, label at the RTL start edge and value at the end edge — the
 * familiar "الإجمالي ......... 150,000 ل.س" shape. When they do not fit
 * together (a long label on 58 mm paper), the label wraps onto its own
 * line(s) and the value follows, end-aligned. Neither branch is allowed to
 * exceed the content width: that is the Rule 4 invariant this module guards.
 *
 * [DESIGN FIX] A primary-emphasis row (the invoice total) now gets its own
 * top gap (SECTION_GAP_PX) and a further-enlarged value font (body × 1.15)
 * instead of just reusing fonts.body, so it reads as the one clear focal
 * point on the receipt rather than merely "a bit bigger than the rest".
 */
function layoutRowBlock(
  cursor: LayoutCursor,
  block: Extract<ReceiptBlock, { type: "row" }>,
  options: LayoutReceiptOptions,
  fonts: ReceiptFontSet,
  contentWidth: number
): void {
  const isPrimary = block.emphasis === "primary";

  if (isPrimary) {
    cursor.pushSpacer(SECTION_GAP_PX);
  }

  const labelFont = fonts.small;
  const valueFont = isPrimary ? Math.round(fonts.body * 1.15) : fonts.small;
  const valueBold = isPrimary;
  const tone: ReceiptTone =
    isPrimary ? "primary" : block.emphasis === "danger" ? "danger" : "normal";
  const gap = 8;
  const singleLineHeight = Math.max(lineHeightFor(labelFont), lineHeightFor(valueFont));

  const labelFits = options.measure(block.label, labelFont, false);
  const valueFits = options.measure(block.value, valueFont, valueBold);

  if (labelFits + gap + valueFits <= contentWidth) {
    const y = cursor.y;
    emit(cursor, {
      text: block.label,
      align: "start",
      fontPx: labelFont,
      bold: false,
      y,
      heightPx: singleLineHeight,
      tone,
      isReturn: false,
    });
    emit(cursor, {
      text: block.value,
      align: "end",
      fontPx: valueFont,
      bold: valueBold,
      y,
      heightPx: singleLineHeight,
      tone,
      isReturn: false,
    });
    cursor.pushSpacer(singleLineHeight);
    return;
  }

  const labelLines = wrapText(
    block.label,
    contentWidth,
    (candidate) => options.measure(candidate, labelFont, false)
  );
  for (const line of labelLines) {
    emit(cursor, {
      text: line,
      align: "start",
      fontPx: labelFont,
      bold: false,
      y: cursor.y,
      heightPx: lineHeightFor(labelFont),
      tone,
      isReturn: false,
    });
    cursor.pushSpacer(lineHeightFor(labelFont));
  }

  const valueLines = wrapText(
    block.value,
    contentWidth,
    (candidate) => options.measure(candidate, valueFont, valueBold)
  );
  for (const line of valueLines) {
    emit(cursor, {
      text: line,
      align: "end",
      fontPx: valueFont,
      bold: valueBold,
      y: cursor.y,
      heightPx: lineHeightFor(valueFont),
      tone,
      isReturn: false,
    });
    cursor.pushSpacer(lineHeightFor(valueFont));
  }
}

/**
 * Lays out an `item` block: the product name, then "<qty> × <unit price>" with
 * the line total pushed to the opposite edge (or onto its own line when the
 * two would collide on narrow paper), then the optional USD "≈" line (unused
 * post SYP-only fix, but the rendering path is kept for a future opt-in).
 *
 * `block.isReturn` drives the tone only — the RULE 5 text itself ("مرتجع: 3
 * طرد") was already produced by lib/receipts/receipt-lines.ts, so there is
 * exactly one place in this feature where the negative sign is turned into a
 * labelled absolute value.
 *
 * [DESIGN FIX] Trailing gap after the whole item block widened 6 → ITEM_GAP_PX
 * so consecutive items no longer read as visually glued together.
 */
function layoutItemBlock(
  cursor: LayoutCursor,
  block: Extract<ReceiptBlock, { type: "item" }>,
  options: LayoutReceiptOptions,
  fonts: ReceiptFontSet,
  contentWidth: number
): void {
  const nameLines = wrapText(
    block.name,
    contentWidth,
    (candidate) => options.measure(candidate, fonts.body, true)
  );
  for (const line of nameLines) {
    emit(cursor, {
      text: line,
      align: "start",
      fontPx: fonts.body,
      bold: true,
      y: cursor.y,
      heightPx: lineHeightFor(fonts.body),
      tone: block.isReturn ? "danger" : "normal",
      isReturn: block.isReturn,
    });
    cursor.pushSpacer(lineHeightFor(fonts.body));
  }

  const detailFont = fonts.small;
  const totalFont = fonts.small;
  const gap = 8;
  const lineHeight = lineHeightFor(detailFont);
  const detailWidth = options.measure(block.detail, detailFont, false);
  const totalWidth = options.measure(block.total, totalFont, true);

  if (detailWidth + gap + totalWidth <= contentWidth) {
    const y = cursor.y;
    emit(cursor, {
      text: block.detail,
      align: "start",
      fontPx: detailFont,
      bold: false,
      y,
      heightPx: lineHeight,
      tone: block.isReturn ? "danger" : "muted",
      isReturn: block.isReturn,
    });
    emit(cursor, {
      text: block.total,
      align: "end",
      fontPx: totalFont,
      bold: true,
      y,
      heightPx: lineHeight,
      tone: block.isReturn ? "danger" : "normal",
      isReturn: block.isReturn,
    });
    cursor.pushSpacer(lineHeight);
  } else {
    const detailLines = wrapText(
      block.detail,
      contentWidth,
      (candidate) => options.measure(candidate, detailFont, false)
    );
    for (const line of detailLines) {
      emit(cursor, {
        text: line,
        align: "start",
        fontPx: detailFont,
        bold: false,
        y: cursor.y,
        heightPx: lineHeight,
        tone: block.isReturn ? "danger" : "muted",
        isReturn: block.isReturn,
      });
      cursor.pushSpacer(lineHeight);
    }

    const totalLines = wrapText(
      block.total,
      contentWidth,
      (candidate) => options.measure(candidate, totalFont, true)
    );
    for (const line of totalLines) {
      emit(cursor, {
        text: line,
        align: "end",
        fontPx: totalFont,
        bold: true,
        y: cursor.y,
        heightPx: lineHeight,
        tone: block.isReturn ? "danger" : "normal",
        isReturn: block.isReturn,
      });
      cursor.pushSpacer(lineHeight);
    }
  }

  if (block.sub) {
    const subLines = wrapText(
      block.sub,
      contentWidth,
      (candidate) => options.measure(candidate, detailFont, false)
    );
    for (const line of subLines) {
      emit(cursor, {
        text: line,
        align: "end",
        fontPx: detailFont,
        bold: false,
        y: cursor.y,
        heightPx: lineHeight,
        tone: "muted",
        isReturn: false,
      });
      cursor.pushSpacer(lineHeight);
    }
  }

  cursor.pushSpacer(ITEM_GAP_PX);
}

/**
 * The public entry point: ReceiptModel → positioned draw ops, verified against
 * the bitmap width.
 *
 * `options.widthPx` is the caller's bitmap width — the configured thermal
 * dots-per-line (Rule 4) for printing, or lib/receipts/constraints.ts's fixed
 * RECEIPT_PDF_RASTER_WIDTH for the shared PDF. This function does not care
 * which; it only guarantees that nothing it emits exceeds the width it was
 * given.
 */
export function layoutReceipt(
  model: ReceiptModel,
  options: LayoutReceiptOptions
): ReceiptLayout {
  if (!Number.isFinite(options.widthPx) || options.widthPx <= 0) {
    throw new Error(`Receipt layout: invalid bitmap width (${options.widthPx}).`);
  }

  const fonts = options.fonts ?? DEFAULT_RECEIPT_FONTS;
  const padding = options.paddingPx ?? DEFAULT_PADDING_PX;
  const contentWidth = options.widthPx - padding * 2;

  if (contentWidth <= 0) {
    throw new Error(
      `Receipt layout: bitmap width ${options.widthPx}px leaves no content area after ${padding}px padding on each side.`
    );
  }

  const cursor = new LayoutCursor(padding);

  for (const block of model.blocks) {
    switch (block.type) {
      case "title":
      case "subtitle":
      case "notice": {
        const { px, bold } = fontFor(block, fonts);
        const tone: ReceiptTone =
          block.type === "notice"
            ? block.tone === "danger"
              ? "danger"
              : "warn"
            : block.type === "title"
              ? "primary"
              : "muted";
        const align: ReceiptTextOp["align"] = block.type === "title" ? "center" : "start";
        const lines = wrapText(
          block.text,
          contentWidth,
          (candidate) => options.measure(candidate, px, bold)
        );

        for (const line of lines) {
          emit(cursor, {
            text: line,
            align,
            fontPx: px,
            bold,
            y: cursor.y,
            heightPx: lineHeightFor(px),
            tone,
            isReturn: false,
          });
          cursor.pushSpacer(lineHeightFor(px));
        }

        // [DESIGN FIX] Section gap after the title (was a flat 6px reused for
        // both title and notice). A notice block also gets the fuller
        // section gap now, since it functionally closes a distinct block
        // (the sync warning, a void reason) rather than continuing one.
        if (block.type !== "subtitle") cursor.pushSpacer(SECTION_GAP_PX);
        break;
      }
      case "row":
        layoutRowBlock(cursor, block, options, fonts, contentWidth);
        break;
      case "item":
        layoutItemBlock(cursor, block, options, fonts, contentWidth);
        break;
      case "divider":
        cursor.pushDivider();
        break;
      case "spacer":
        cursor.pushSpacer(lineHeightFor(fonts.body));
        break;
      default:
        break;
    }
  }

  // Rule 4's fail-loud width invariant: re-measure every emitted line and
  // refuse to produce a layout that would be silently clipped by the printer
  // or by the PDF page. wrapText()'s hard-split fallback makes this
  // unreachable except through a genuine bug, which is exactly why it throws
  // instead of trimming.
  for (const op of cursor.ops) {
    if (op.kind !== "text") continue;
    const measured = options.measure(op.text, op.fontPx, op.bold);
    if (measured > contentWidth + 0.5) {
      throw new Error(
        `Receipt layout overflow at ${options.widthPx}px: "${op.text}" measures ${measured}px > ${contentWidth}px content width.`
      );
    }
  }

  return {
    widthPx: options.widthPx,
    heightPx: cursor.y + padding,
    paddingPx: padding,
    ops: cursor.ops,
  };
}