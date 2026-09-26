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
import { Camera, RefreshCw, ScanLine } from "lucide-react";
import { toast } from "sonner";
import m from "./modals.module.css";

interface BarcodeScannerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScan: (barcode: string) => void;
  /**
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
   * "toast" (default): show this modal's own generic "تم مسح الباركود
   * بنجاح: X" confirmation. "silent": suppress it and let the caller show
   * its own, more contextual feedback (e.g. POS's "تمت إضافة X إلى
   * السلة" from handleAddToCart) — avoids two stacked toasts per scan
   * during rapid continuous scanning.
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
  // Was `useRef<HTMLVideoElement | null>(null)` read as
  // `videoRef.current!` inside the effect. DialogContent (Radix) mounts its
  // children in a Portal AFTER the first render, so when the effect ran the
  // ref was still null. @zxing/library then silently created a detached,
  // off-screen <video> element for the stream: the camera light turned on
  // and the decoder kept running (hence the NotFoundException spam in the
  // console), but the visible <video> in the modal never got a stream and
  // stayed black. Storing the element in STATE via a callback ref makes the
  // effect wait until the element really exists, and re-run when it changes.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // Visual "ready to scan next item" indicator for continuous mode — lets
  // the cashier see the cooldown window instead of wondering why a scan
  // didn't seem to register.
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
    // Do not start until the modal is open AND the <video> element has
    // actually been mounted (videoEl is non-null).
    if (!open || !videoEl) {
      if (readerRef.current) {
        readerRef.current.reset();
        readerRef.current = null;
      }
      return;
    }

    const codeReader = new BrowserMultiFormatReader();
    readerRef.current = codeReader;

    // Was a permanent one-shot `hasScannedRef.current = true` that never
    // reset for the lifetime of a scan session — meaning a "continuous"
    // mode built on top of the old version would have gone dead after
    // exactly one successful scan (the camera keeps running visually, but
    // the callback becomes a permanent no-op). Replaced with a `locked`
    // flag that DOES reset after `continuousCooldownMs` — but only when
    // mode === "continuous". In "single" mode the behavior is
    // byte-for-byte identical to before: lock forever, reset+close on the
    // first hit.
    let locked = false;
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
    // Guards against state updates / retries after this effect was cleaned up
    // (StrictMode double-invoke, modal closed mid-startup, etc.).
    let cancelled = false;

    // Laptop / no-rear-camera fallback: a bare `facingMode: "environment"`
    // string is spec'd as an IDEAL preference, not a hard requirement — a
    // device with only a front-facing camera (any laptop) is expected to
    // receive that camera as a fallback per the W3C mediacapture spec, with
    // no error at all. `attemptDecode` is a small wrapper solely so a
    // strict/non-standard browser or driver that throws
    // OverconstrainedError on the first attempt (rejecting the constraint
    // outright instead of falling back) gets one retry with a plain
    // `{ video: true }` — "any camera, no preference" — before this is
    // treated as a genuine camera-access failure. On a spec-compliant
    // browser this retry path is never reached at all; the first call
    // already succeeds with whatever camera is available.
    const attemptDecode = (constraints: MediaStreamConstraints) =>
      codeReader.decodeFromConstraints(
        constraints,
        videoEl, // real, mounted element instead of videoRef.current!
        (result) => {
          if (!result || locked || cancelled) return;
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
      );

    attemptDecode({ video: { facingMode: "environment" } }).catch((err) => {
      if (cancelled) return;

      const isOverconstrained =
        err && (err.name === "OverconstrainedError" || err.name === "ConstraintNotSatisfiedError");

      if (isOverconstrained) {
        // The device (a laptop with only a front camera, most commonly)
        // rejected the facingMode preference outright instead of falling
        // back on its own — retry with no camera preference at all.
        attemptDecode({ video: true }).catch((fallbackErr) => {
          if (cancelled) return;
          console.error("Barcode scanner camera error (fallback attempt):", fallbackErr);
          setCameraError(
            "تعذّر الوصول إلى الكاميرا. يرجى التأكد من السماح باستخدام الكاميرا."
          );
        });
        return;
      }

      console.error("Barcode scanner camera error:", err);
      setCameraError(
        "تعذّر الوصول إلى الكاميرا. يرجى التأكد من السماح باستخدام الكاميرا."
      );
    });

    return () => {
      cancelled = true;
      if (cooldownTimer) clearTimeout(cooldownTimer);
      if (readerRef.current) {
        readerRef.current.reset();
        readerRef.current = null;
      }
    };
  }, [open, videoEl, retryToken, handleOpenChange, continuousCooldownMs]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
        <div className={m.m}>
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Camera className={`w-5 h-5 ${m.titleIcon}`} aria-hidden />
              <span>{mode === "continuous" ? "مسح مستمر للأصناف" : "مسح الباركود بالكاميرا"}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              {mode === "continuous"
                ? "وجّه الكاميرا نحو كل صنف بالتتابع — سيُضاف تلقائياً إلى السلة عند كل مسح ناجح."
                : "وجه كاميرا الجهاز نحو الباركود المطبوع على المنتج للمسح التلقائي."}
            </DialogDescription>
          </DialogHeader>

          <div className={m.videoFrame} style={{ marginBlock: 8 }}>
            <video ref={setVideoEl} className={m.video} autoPlay muted playsInline />

            {isScanning && !awaitingCooldown && (
              <div className={m.scanOverlay}>
                <div className={m.scanFrame} />
                <span className={m.scanCaption}>جاري البحث عن باركود...</span>
              </div>
            )}

            {/* Continuous-mode cooldown indicator — tells the cashier the
                last item registered and the camera will accept the next
                one in a moment, instead of leaving them guessing whether
                the scan worked. */}
            {isScanning && awaitingCooldown && (
              <div className={m.cooldownOverlay}>
                <ScanLine size={40} color="#6ee7b7" aria-hidden />
                <span className={m.cooldownCaption}>تمت الإضافة — جاهز للصنف التالي...</span>
              </div>
            )}

            {cameraError && (
              <div className={m.cameraErrorBox}>
                <p>{cameraError}</p>
                <button type="button" onClick={handleRetry} className={`${m.btn} ${m.btnXs} ${m.btnOutlineRed}`}>
                  <RefreshCw size={14} aria-hidden />
                  <span>إعادة المحاولة</span>
                </button>
              </div>
            )}
          </div>

          <DialogFooter>
            <button type="button" onClick={() => handleOpenChange(false)} className={`${m.btn} ${m.btnOutline} ${m.btnFull}`}>
              {mode === "continuous" ? "إنهاء المسح" : "إغلاق"}
            </button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}