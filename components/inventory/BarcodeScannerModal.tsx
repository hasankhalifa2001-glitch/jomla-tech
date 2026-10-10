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

/**
 * In continuous mode, a DIFFERENT barcode is accepted this soon after the
 * previous accepted scan — so two different items can be scanned back-to-back
 * without waiting out the full cooldown.
 */
const DIFFERENT_BARCODE_DEBOUNCE_MS = 400;

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
   * still-visible barcode (see `continuousCooldownMs` and `repeatGapMs`).
   */
  mode?: "single" | "continuous";
  /**
   * "toast" (default): show this modal's own generic "تم مسح الباركود
   * بنجاح: X" confirmation AND its own beep. "silent": suppress BOTH and let
   * the caller give its own, more contextual feedback (e.g. POS's per-scan
   * banner + sound) — avoids doubled toasts/beeps during rapid continuous
   * scanning.
   */
  feedback?: "toast" | "silent";
  /**
   * Continuous mode: minimum time before the SAME barcode can be accepted
   * again after it was accepted, ms.
   */
  continuousCooldownMs?: number;
  /**
   * Continuous mode: the same barcode only counts again after it has been OUT
   * of the camera's view for at least this long, ms. This is what stops a box
   * that is simply still held in front of the camera from being added twice
   * (the cooldown alone would let it through the moment it expired), while
   * still letting a cashier scan two identical items one after the other.
   * Raise it if a steady hand still double-counts; lower it if scanning
   * identical items back-to-back feels sluggish.
   */
  repeatGapMs?: number;
  /**
   * Optional heading override. Defaults to the generic per-mode title, so
   * existing callers (POS, Inventory search) are unchanged.
   */
  title?: string;
  /**
   * Optional description override. The built-in continuous-mode text talks
   * about adding items to the CART (POS-specific); a caller using continuous
   * mode for something else (e.g. collecting several barcodes for one unit)
   * passes its own wording here.
   */
  description?: string;
  /**
   * Optional label for the bottom button. Defaults to "إنهاء المسح"
   * (continuous) / "إغلاق" (single). POS uses it to show the running
   * "5 أصناف · 450,000 ل.س" on the button that finishes the session.
   */
  finishLabel?: string;
  /**
   * Optional caller content rendered directly under the video frame — e.g. a
   * live list of what has been scanned so far in this session.
   */
  children?: React.ReactNode;
}

export function BarcodeScannerModal({
  open,
  onOpenChange,
  onScan,
  mode = "single",
  feedback = "toast",
  continuousCooldownMs = 1200,
  repeatGapMs = 1000,
  title,
  description,
  finishLabel,
  children,
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

    // "single" mode: byte-for-byte the original behavior — lock forever,
    // reset + close on the first hit.
    let locked = false;

    // "continuous" mode bookkeeping.
    //  - lastSeen*: the most recent barcode the decoder reported, whether or
    //    not it was accepted — so we know whether a barcode is STILL in view.
    //  - accepted*: the most recent barcode that was actually reported out.
    //
    // Rules (see the callback): the SAME barcode is accepted again only when
    // the cooldown has passed AND it left the camera's view for `repeatGapMs`;
    // a DIFFERENT barcode only needs a short debounce. Before this, a plain
    // timer unlocked everything after the cooldown, so a box held steady in
    // front of the camera was added a second time.
    let lastSeenText: string | null = null;
    let lastSeenAt = 0;
    let acceptedText: string | null = null;
    let acceptedAt = 0;
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
          if (!result || cancelled) return;

          const currentMode = modeRef.current;
          const currentFeedback = feedbackRef.current;
          const now = Date.now();
          const barcodeText = result.getText();

          // Was this exact barcode ALSO reported a moment ago (i.e. it has not
          // left the frame)? Computed before lastSeen* is refreshed below.
          const stillInView = barcodeText === lastSeenText && now - lastSeenAt < repeatGapMs;
          lastSeenText = barcodeText;
          lastSeenAt = now;

          if (currentMode === "single") {
            if (locked) return;
            locked = true;
            // Unchanged original behavior: stop immediately, this is the
            // only scan this session will accept.
            if (readerRef.current) readerRef.current.reset();
          } else {
            const sinceAccepted = now - acceptedAt;
            if (barcodeText === acceptedText) {
              // Same item: it must have left the frame AND the cooldown passed.
              if (stillInView || sinceAccepted < continuousCooldownMs) return;
            } else if (sinceAccepted < DIFFERENT_BARCODE_DEBOUNCE_MS) {
              // A different item, but suspiciously soon — likely a half-read.
              return;
            }

            acceptedText = barcodeText;
            acceptedAt = now;

            // Continuous: keep the reader running; flash the indicator for the
            // cooldown window so the cashier can see the scan registered.
            setAwaitingCooldown(true);
            if (cooldownTimer) clearTimeout(cooldownTimer);
            cooldownTimer = setTimeout(() => {
              setAwaitingCooldown(false);
            }, continuousCooldownMs);
          }

          // Own beep + toast only in the default "toast" feedback mode. With
          // "silent" the caller supplies its own (POS plays its own tone), so
          // two beeps never stack on one scan.
          if (currentFeedback === "toast") {
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
  }, [open, videoEl, retryToken, handleOpenChange, continuousCooldownMs, repeatGapMs]);

  const resolvedTitle =
    title ?? (mode === "continuous" ? "مسح مستمر للأصناف" : "مسح الباركود بالكاميرا");

  const resolvedDescription =
    description ??
    (mode === "continuous"
      ? "وجّه الكاميرا نحو كل صنف بالتتابع — سيُضاف تلقائياً إلى السلة عند كل مسح ناجح."
      : "وجه كاميرا الجهاز نحو الباركود المطبوع على المنتج للمسح التلقائي.");

  const resolvedFinishLabel = finishLabel ?? (mode === "continuous" ? "إنهاء المسح" : "إغلاق");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* [UX] Capped at 92% of the dynamic viewport height and scrollable, so
          video + caller content (e.g. the POS cart strip) + the finish button
          can never push the dialog off a short phone screen. */}
      <DialogContent className="max-w-md max-h-[92dvh] overflow-y-auto p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
        <div className={m.m}>
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Camera className={`w-5 h-5 ${m.titleIcon}`} aria-hidden />
              <span>{resolvedTitle}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              {resolvedDescription}
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
                <span className={m.cooldownCaption}>تم المسح — جاهز للصنف التالي...</span>
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

          {/* Caller-supplied content (e.g. the list scanned so far). */}
          {children}

          {/* Sticky: stays reachable at the bottom while the content above
              scrolls on a small screen. */}
          <DialogFooter className="sticky bottom-0 -mx-6 mt-3 bg-white px-6 pt-2 pb-1 dark:bg-zinc-900">
            <button type="button" onClick={() => handleOpenChange(false)} className={`${m.btn} ${m.btnOutline} ${m.btnFull}`}>
              {resolvedFinishLabel}
            </button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}