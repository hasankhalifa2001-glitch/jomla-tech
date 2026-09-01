"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/library";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface BarcodeScannerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScan: (barcode: string) => void;
}

export function BarcodeScannerModal({ open, onOpenChange, onScan }: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);

  // تم حذف isScanning كـ State تماماً
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // [الحل الجذري] استنتاج حالة المسح مباشرة (Derived State)
  const isScanning = open && !cameraError;

  const onScanRef = useRef(onScan);
  const onOpenChangeRef = useRef(onOpenChange);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  // تصفير الأخطاء يتم عبر التفاعل المباشر (Event Handlers) وليس الـ Effect
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen) {
      setCameraError(null);
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

    // تم إزالة جميع عمليات setState المتزامنة من هنا!

    codeReader
      .decodeFromConstraints(
        { video: { facingMode: "environment" } },
        videoRef.current!,
        (result) => {
          if (result) {
            const barcodeText = result.getText();
            try {
              const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

            toast.success(`تم مسح الباركود بنجاح: ${barcodeText}`);
            onScanRef.current(barcodeText);
            handleOpenChange(false);
          }
        }
      )
      .catch((err) => {
        console.error("Barcode scanner camera error:", err);
        // تحديث الـ State بشكل غير متزامن (Asynchronous) مسموح تماماً ولا يسبب مشاكل
        setCameraError("تعذّر الوصول إلى الكاميرا. يرجى التأكد من السماح باستخدام الكاميرا.");
      });

    return () => {
      if (readerRef.current) {
        readerRef.current.reset();
        readerRef.current = null;
      }
    };
  }, [open, retryToken, handleOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-bold flex items-center gap-2">
            <Camera className="w-5 h-5 text-emerald-600" />
            <span>مسح الباركود بالكاميرا</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            وجه كاميرا الجهاز نحو الباركود المطبوع على المنتج للمسح التلقائي.
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black flex items-center justify-center border border-zinc-800">
          <video ref={videoRef} className="w-full h-full object-cover" />

          {isScanning && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
              <div className="w-48 h-32 border-2 border-dashed border-emerald-500 rounded-lg animate-pulse" />
              <span className="text-[11px] text-emerald-400 bg-black/60 px-2 py-0.5 rounded mt-2 font-mono">
                جاري البحث عن باركود...
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
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} className="w-full">
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}