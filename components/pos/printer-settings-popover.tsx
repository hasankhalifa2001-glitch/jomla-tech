"use client";

/**
 * components/pos/printer-settings-popover.tsx
 *
 * T4f addendum — Rule 4's settings control. Per the approved decision it lives
 * ON THE POS SCREEN (mounted in pos-layout.tsx's top bar), not under
 * /settings/**, for one concrete reason: the sidebar's settings entries are
 * ADMIN-gated (components/dashboard/sidebar.tsx), while printing is a CASHIER
 * activity. A cashier on a fresh device would otherwise hit
 * PrinterNotConfiguredError with no way to configure the printer — a dead end
 * created by placement rather than by policy.
 *
 * [EVERY DECISION HERE IS A HUMAN ONE] Nothing in this file infers a
 * dots-per-line value:
 *   - Choosing a paper width PREFILLS the suggested number
 *     (suggestedDotsPerLine) and writes an UNCONFIRMED config. It cannot become
 *     usable by itself.
 *   - The value only becomes usable via «تأكيد» (confirmPrinterConfig), which is
 *     an explicit, timestamped human confirmation. This is T3a's BarcodeSource
 *     precedent applied to hardware: an unconfirmed value is its own state,
 *     never coerced into a usable one.
 *   - The override field lets the user enter what the printer's manual (or a
 *     test print) actually says, validated only for shape by
 *     validateDotsPerLine (positive integer, multiple of 8).
 *   - The test print exists so "verify against physical output" (Rule 4's second
 *     acceptance criterion) has a button, not a wiki page.
 *
 * [THE PAIRED DEVICE IS NEVER ASKED FOR A WIDTH] `handle.name` is displayed for
 * identification only. bluetooth-printer.ts is the only module that touches
 * Web Bluetooth, and it deliberately exposes no resolution information at all.
 */

import { useCallback, useEffect, useState } from "react";
import { Bluetooth, Check, Loader2, Printer, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  PAPER_WIDTH_SUGGESTED_DOTS,
  clearPrinterConfig,
  confirmPrinterConfig,
  createUnconfirmedPrinterConfig,
  readPrinterConfig,
  resolvePrintableWidth,
  savePrinterConfig,
  suggestedDotsPerLine,
  type PaperWidth,
  type PrinterConfig,
} from "@/lib/receipts/printer-config";
import {
  assertRasterMatchesConfiguredWidth,
  buildRasterCommands,
  buildTestPatternRaster,
} from "@/lib/receipts/escpos";
import {
  BLUETOOTH_UNSUPPORTED_MESSAGE,
  isWebBluetoothSupported,
  printEscPosBytes,
} from "@/lib/receipts/bluetooth-printer";
import { ensurePairedPrinter, setPairedPrinter, usePairedPrinter } from "@/lib/receipts/printer-session";

const PAPER_WIDTH_LABELS: Record<PaperWidth, string> = {
  "80mm": "80 مم",
  "58mm": "58 مم",
};

export interface PrinterSettingsPopoverProps {
  /**
   * Controlled open state, so a failed print can route the user straight here
   * (see receipt-actions.tsx's onPrinterSetupRequired).
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Rendered as the trigger when neither `open` nor a custom trigger is given. */
  className?: string;
}

export function PrinterSettingsPopover({
  open,
  onOpenChange,
  className,
}: PrinterSettingsPopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const paired = usePairedPrinter();

  const [config, setConfig] = useState<PrinterConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [dotsDraft, setDotsDraft] = useState<string>("");

  const setOpen = useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  // Read this device's persisted config whenever the popover opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    (async () => {
      try {
        const stored = await readPrinterConfig();
        if (cancelled) return;
        setConfig(stored);
        setDotsDraft(String(stored?.dotsPerLine ?? PAPER_WIDTH_SUGGESTED_DOTS["80mm"]));
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "تعذّر قراءة إعدادات الطابعة.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  async function handleSelectWidth(width: PaperWidth) {
    // A selection is ONLY a prefilled, UNCONFIRMED config — see the file header.
    const unconfirmed = createUnconfirmedPrinterConfig(width);
    setConfig(unconfirmed);
    setDotsDraft(String(suggestedDotsPerLine(width)));
    try {
      await savePrinterConfig(unconfirmed);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذّر حفظ إعدادات الطابعة.");
    }
  }

  async function handlePair() {
    setIsBusy(true);
    try {
      const handle = await ensurePairedPrinter();
      toast.success(`تم إقران الطابعة: ${handle.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذّر إقران الطابعة.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleConfirm() {
    setIsBusy(true);
    try {
      const base = config ?? createUnconfirmedPrinterConfig();
      // confirmPrinterConfig validates the entry and stamps `confirmedAt` — this
      // call IS the explicit human decision Rule 4 requires. Nothing else in the
      // codebase can set isConfirmed, so an unfinished setup can never become a
      // usable width on its own.
      const confirmed = confirmPrinterConfig(base, Number(dotsDraft));
      const persisted = await savePrinterConfig(confirmed);
      setConfig(persisted);
      setDotsDraft(String(persisted.dotsPerLine));
      toast.success("تم تأكيد عرض رأس الطابعة على هذا الجهاز.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "قيمة عرض غير صالحة.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleTestPrint() {
    if (!isWebBluetoothSupported()) {
      toast.error(BLUETOOTH_UNSUPPORTED_MESSAGE);
      return;
    }

    setIsBusy(true);
    try {
      const stored = config ?? (await readPrinterConfig());
      if (!stored || !stored.isConfirmed) {
        toast.error("أكّد عرض رأس الطابعة أولاً، ثم اطبع نموذجاً تجريبياً.");
        return;
      }

      // Same single source of truth as the real print path (Rule 4): this throws
      // for an unconfirmed config rather than picking a default.
      const dotsPerLine = resolvePrintableWidth(stored);

      const raster = buildTestPatternRaster(dotsPerLine);
      assertRasterMatchesConfiguredWidth(raster, dotsPerLine);

      const handle = await ensurePairedPrinter();
      await printEscPosBytes(handle, buildRasterCommands(raster, { cut: true, feedLines: 6 }));

      toast.success("تم إرسال النموذج التجريبي — تأكد من أن الإطار غير مقصوص.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذّرت طباعة النموذج التجريبي.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleClear() {
    setIsBusy(true);
    try {
      await clearPrinterConfig();
      setConfig(null);
      setDotsDraft(String(PAPER_WIDTH_SUGGESTED_DOTS["80mm"]));
      setPairedPrinter(null);
      toast.success("تم حذف إعدادات الطابعة من هذا الجهاز.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذّر حذف الإعدادات.");
    } finally {
      setIsBusy(false);
    }
  }

  const isConfirmed = config?.isConfirmed === true;

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={
            className ??
            "text-xs h-8 gap-1.5 text-zinc-600 hover:text-zinc-900 hover:border-zinc-400"
          }
          title={
            isConfirmed && config
              ? `إعدادات الطابعة الحرارية (${PAPER_WIDTH_LABELS[config.paperWidth]})`
              : "اضبط عرض رأس الطابعة على هذا الجهاز قبل الطباعة"
          }
        >
          <Printer className="h-3.5 w-3.5 text-emerald-600" />
          <span className="hidden lg:inline">الطابعة</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent dir="rtl" align="end" className="w-80 space-y-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-zinc-800 dark:text-zinc-200">
            إعدادات الطابعة الحرارية
          </span>
          <Badge
            variant="outline"
            className={
              isConfirmed
                ? "bg-emerald-50 text-emerald-700 text-[10px]"
                : "bg-amber-50 text-amber-700 text-[10px]"
            }
          >
            {isConfirmed ? "مضبوطة" : "غير مضبوطة"}
          </Badge>
        </div>

        <p className="text-[11px] leading-relaxed text-zinc-500">
          هذا الإعداد خاص بهذا الجهاز فقط — لا ينتقل مع المستخدم أو المتجر. اختر مقاس الورق،
          ثم أدخل عدد النقاط في السطر من دليل طابعتك (أو من نتيجة الطباعة التجريبية) واضغط
          «تأكيد».
        </p>

        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold">مقاس الورق</Label>
          <div className="flex gap-2">
            {(Object.keys(PAPER_WIDTH_LABELS) as PaperWidth[]).map((width) => (
              <Button
                key={width}
                type="button"
                size="sm"
                variant={config?.paperWidth === width ? "default" : "outline"}
                onClick={() => handleSelectWidth(width)}
                disabled={isBusy || isLoading}
                className="flex-1 text-[11px]"
              >
                {PAPER_WIDTH_LABELS[width]}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="printer-dots" className="text-[11px] font-semibold">
            عدد النقاط في السطر (dots per line)
          </Label>
          <Input
            id="printer-dots"
            inputMode="numeric"
            value={dotsDraft}
            onChange={(event) => setDotsDraft(event.target.value.replace(/[^0-9]/g, ""))}
            className="h-8 font-mono text-xs"
            placeholder="576"
          />
          <p className="text-[10px] text-zinc-400">
            القيمة المقترحة لمقاس{" "}
            {PAPER_WIDTH_LABELS[config?.paperWidth ?? "80mm"]}:{" "}
            <span className="font-mono">{suggestedDotsPerLine(config?.paperWidth ?? "80mm")}</span>{" "}
            — عدّلها إن اختلفت طابعتك.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={handleConfirm}
            disabled={isBusy || dotsDraft === ""}
            className="gap-1.5 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700"
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            <span>تأكيد</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handlePair}
            disabled={isBusy}
            className="gap-1.5 text-[11px]"
          >
            <Bluetooth className="h-3.5 w-3.5" />
            <span>{paired ? "إعادة الإقران" : "إقران الطابعة"}</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleTestPrint}
            disabled={isBusy}
            className="gap-1.5 text-[11px]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>طباعة تجريبية</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleClear}
            disabled={isBusy}
            className="gap-1.5 text-[11px] text-red-600 hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>حذف</span>
          </Button>
        </div>

        <p className="text-[10px] text-zinc-400">
          {paired ? `الطابعة المقترنة: ${paired.name}` : "لا توجد طابعة مقترنة في هذه الجلسة."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
