"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/library";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, RefreshCw, ScanLine } from "lucide-react";
import { toast } from "sonner";

interface BarcodeScannerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScan: (barcode: string) => void;
  /**
   * [ADDED — POS integration]
   * "single" (default, unchanged behavior from the original Inventory-only
   * version): scan once, close automatically. Matches "find one product"
   * use cases (Inventory's search-by-barcode).
   * "continuous": the modal stays open and the camera keeps running after
   * a successful scan, so a cashier can scan item after item without
   * reopening this dialog each time. Guards against re-firing on the SAME
   * still-visible barcode via a short cooldown instead of a permanent
   * one-shot lock.
   */
  mode?: "single" | "continuous";
  /**
   * [ADDED] "toast" (default): show this modal's own generic
   * "تم مسح الباركود بنجاح: X" confirmation. "silent": suppress it and let
   * the caller show its own, more contextual feedback (e.g. POS's
   * "تمت إضافة X إلى السلة" from handleAddToCart) — avoids two stacked
   * toasts per scan during rapid continuous scanning.
   */
  feedback?: "toast" | "silent";
  /** Cooldown between accepted scans in continuous mode, ms. */
  continuousCooldownMs?: number;
}

export function BarcodeScannerModal({
  open,
  onOpenChange,
  onScan,
  mode = "single",
  feedback = "toast",
  continuousCooldownMs = 1200,
}: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // [ADDED] Visual "ready to scan next item" indicator for continuous mode
  // — lets the cashier see the cooldown window instead of wondering why a
  // scan didn't seem to register.
  const [awaitingCooldown, setAwaitingCooldown] = useState(false);

  const isScanning = open && !cameraError;

  const onScanRef = useRef(onScan);
  const onOpenChangeRef = useRef(onOpenChange);
  const modeRef = useRef(mode);
  const feedbackRef = useRef(feedback);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen) {
      setCameraError(null);
      setAwaitingCooldown(false);
    }
    onOpenChangeRef.current(newOpen);
  }, []);

  const handleRetry = useCallback(() => {
    setCameraError(null);
    setRetryToken((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!open) {
      if (readerRef.current) {
        readerRef.current.reset();
        readerRef.current = null;
      }
      return;
    }

    const codeReader = new BrowserMultiFormatReader();
    readerRef.current = codeReader;

    // [CHANGED] Was a permanent one-shot `hasScannedRef.current = true`
    // that never reset for the lifetime of a scan session — meaning a
    // "continuous" mode built on top of the old version would have gone
    // dead after exactly one successful scan (the camera keeps running
    // visually, but the callback becomes a permanent no-op). Replaced
    // with a `locked` flag that DOES reset after `continuousCooldownMs` —
    // but only when mode === "continuous". In "single" mode the behavior
    // is byte-for-byte identical to before: lock forever, reset+close on
    // the first hit.
    let locked = false;
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

    codeReader
      .decodeFromConstraints(
        { video: { facingMode: "environment" } },
        videoRef.current!,
        (result) => {
          if (!result || locked) return;
          locked = true;

          const currentMode = modeRef.current;
          const currentFeedback = feedbackRef.current;

          if (currentMode === "single") {
            // Unchanged original behavior: stop immediately, this is the
            // only scan this session will accept.
            if (readerRef.current) readerRef.current.reset();
          } else {
            // Continuous: keep the reader running. Show the cooldown
            // indicator, then unlock after continuousCooldownMs so the
            // NEXT distinct item can be scanned.
            setAwaitingCooldown(true);
            cooldownTimer = setTimeout(() => {
              locked = false;
              setAwaitingCooldown(false);
            }, continuousCooldownMs);
          }

          const barcodeText = result.getText();
          try {
            const AudioCtx =
              window.AudioContext ||
              (window as unknown as { webkitAudioContext: typeof AudioContext })
                .webkitAudioContext;
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            osc.connect(ctx.destination);
            osc.frequency.value = 800;
            osc.start();
            osc.stop(ctx.currentTime + 0.1);
            osc.onended = () => ctx.close();
          } catch {
            // ignore
          }

          if (currentFeedback === "toast") {
            toast.success(`تم مسح الباركود بنجاح: ${barcodeText}`, {
              duration: 1200,
            });
          }

          onScanRef.current(barcodeText);

          if (currentMode === "single") {
            handleOpenChange(false);
          }
        }
      )
      .catch((err) => {
        console.error("Barcode scanner camera error:", err);
        setCameraError(
          "تعذّر الوصول إلى الكاميرا. يرجى التأكد من السماح باستخدام الكاميرا."
        );
      });

    return () => {
      if (cooldownTimer) clearTimeout(cooldownTimer);
      if (readerRef.current) {
        readerRef.current.reset();
        readerRef.current = null;
      }
    };
  }, [open, retryToken, handleOpenChange, continuousCooldownMs]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-bold flex items-center gap-2">
            <Camera className="w-5 h-5 text-emerald-600" />
            <span>{mode === "continuous" ? "مسح مستمر للأصناف" : "مسح الباركود بالكاميرا"}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            {mode === "continuous"
              ? "وجّه الكاميرا نحو كل صنف بالتتابع — سيُضاف تلقائياً إلى السلة عند كل مسح ناجح."
              : "وجه كاميرا الجهاز نحو الباركود المطبوع على المنتج للمسح التلقائي."}
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black flex items-center justify-center border border-zinc-800">
          <video ref={videoRef} className="w-full h-full object-cover" />

          {isScanning && !awaitingCooldown && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
              <div className="w-48 h-32 border-2 border-dashed border-emerald-500 rounded-lg animate-pulse" />
              <span className="text-[11px] text-emerald-400 bg-black/60 px-2 py-0.5 rounded mt-2 font-mono">
                جاري البحث عن باركود...
              </span>
            </div>
          )}

          {/* [ADDED] Continuous-mode cooldown indicator — tells the cashier
              the last item registered and the camera will accept the next
              one in a moment, instead of leaving them guessing whether the
              scan worked. */}
          {isScanning && awaitingCooldown && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center bg-emerald-950/40">
              <ScanLine className="w-10 h-10 text-emerald-400 animate-pulse" />
              <span className="text-[11px] text-emerald-300 bg-black/60 px-2 py-0.5 rounded mt-2 font-mono">
                تمت الإضافة — جاهز للصنف التالي...
              </span>
            </div>
          )}

          {cameraError && (
            <div className="p-4 text-center text-xs text-red-400 space-y-3">
              <p>{cameraError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRetry}
                className="gap-1.5 text-[11px] h-7 border-red-400 text-red-300 hover:bg-red-950/40"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>إعادة المحاولة</span>
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            className="w-full"
          >
            {mode === "continuous" ? "إنهاء المسح" : "إغلاق"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}