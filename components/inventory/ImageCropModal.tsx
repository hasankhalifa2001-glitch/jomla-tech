"use client";

import { useRef, useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Crop, Upload, RotateCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import m from "./modals.module.css";

interface ImageCropModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCropComplete: (url: string) => void;
}

export function ImageCropModal({ open, onOpenChange, onCropComplete }: ImageCropModalProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [rotation, setRotation] = useState<number>(0);
  const [brightness, setBrightness] = useState<number>(100);
  const [uploading, setUploading] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Previously this reset ran inside a `useEffect` watching `open`, which
  // React's lint rule flags: "Calling setState synchronously within an
  // effect can trigger cascading renders." An effect is for synchronizing
  // with something external — reacting to a prop AFTER it changed just to
  // immediately set more state is exactly the pattern the rule warns
  // against, and it's pure overhead here since we already know the reset
  // is needed at the moment the modal closes.
  //
  // Fixed by moving the reset into a local `handleOpenChange` wrapper —
  // the exact same pattern already used in AddProductModal.tsx. Every
  // internal close path (Cancel button, successful upload) now goes
  // through this wrapper instead of calling the `onOpenChange` prop
  // directly, so the reset happens as part of the same state transition,
  // not as a delayed reaction to it.
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setImageSrc(null);
      setRotation(0);
      setBrightness(100);
      setUploading(false);
    }
    onOpenChange(nextOpen);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setImageSrc(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const drawCanvas = () => {
    if (!imageSrc || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imageSrc;
    img.onload = () => {
      canvas.width = 400;
      canvas.height = 400;

      ctx.save();
      ctx.filter = `brightness(${brightness}%)`;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 400, 400);

      ctx.translate(200, 200);
      ctx.rotate((rotation * Math.PI) / 180);

      const minDim = Math.min(img.width, img.height);
      const sx = (img.width - minDim) / 2;
      const sy = (img.height - minDim) / 2;

      ctx.drawImage(img, sx, sy, minDim, minDim, -200, -200, 400, 400);
      ctx.restore();
    };
  };

  useEffect(() => {
    if (imageSrc) {
      drawCanvas();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc, rotation, brightness]);

  const handleSaveCrop = async () => {
    if (!canvasRef.current || !imageSrc) {
      toast.error("يرجى اختيار صورة أولاً.");
      return;
    }

    setUploading(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvasRef.current!.toBlob((b) => resolve(b), "image/jpeg", 0.85);
      });

      if (!blob) {
        throw new Error("تعذّر إنشاء ملف الصورة من اللوحة (Canvas).");
      }

      const formData = new FormData();
      formData.append("file", blob, "product-image.jpg");
      formData.append("type", "product");

      const res = await fetch("/api/upload/receipt", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok || !data.success || !data.url) {
        throw new Error(data.message || "فشل رفع الصورة إلى التخزين السحابي.");
      }

      onCropComplete(data.url);
      toast.success("تم رفع صورة المنتج بنجاح.");
      // Routes through the local wrapper (not the raw prop) so the reset
      // happens immediately as part of this same close action.
      handleOpenChange(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "حدث خطأ أثناء رفع الصورة.";
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
        <div className={m.m}>
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Crop className={`w-5 h-5 ${m.titleIcon}`} aria-hidden />
              <span>قص ومعالجة صورة المنتج (Canvas Crop)</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              تأطير الصورة بشكل مربعي قياسي للظهور في المتجر.
            </DialogDescription>
          </DialogHeader>

          <div className={m.stack} style={{ marginBlock: 8 }}>
            {!imageSrc ? (
              <div className={m.uploadDrop}>
                <Upload size={32} className={m.uploadIcon} aria-hidden />
                <p className={m.uploadText}>اختر صورة المنتج من جهازك</p>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  disabled={uploading}
                  className={m.fileInput}
                />
              </div>
            ) : (
              <div className={m.stack}>
                <div className={m.canvasWrap}>
                  <canvas ref={canvasRef} className={m.canvas} />
                </div>

                <div className={m.cropControls}>
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => setRotation((prev) => (prev + 90) % 360)}
                    className={`${m.btn} ${m.btnXs} ${m.btnOutline}`}
                  >
                    <RotateCw size={14} aria-hidden />
                    <span>تدوير 90°</span>
                  </button>

                  <div className={m.brightnessRow}>
                    <span className={m.brightnessLabel}>السطوع:</span>
                    <input
                      type="range"
                      min="50"
                      max="150"
                      value={brightness}
                      disabled={uploading}
                      onChange={(e) => setBrightness(Number(e.target.value))}
                      className={m.range}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <div className={m.footerRow}>
              <button type="button" onClick={() => handleOpenChange(false)} disabled={uploading} className={`${m.btn} ${m.btnOutline}`}>
                إلغاء
              </button>
              {imageSrc && (
                <button type="button" onClick={handleSaveCrop} disabled={uploading} className={`${m.btn} ${m.btnSolid}`}>
                  {uploading ? (
                    <>
                      <Loader2 size={14} className={m.spin} aria-hidden />
                      <span>جاري الرفع...</span>
                    </>
                  ) : (
                    <span>اعتماد الصورة</span>
                  )}
                </button>
              )}
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}