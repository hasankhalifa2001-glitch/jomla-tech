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

// Output canvas size (square). The whole image is fitted inside it
// (no cropping) on a TRANSPARENT background.
const CANVAS_SIZE = 500;

export function ImageCropModal({ open, onOpenChange, onCropComplete }: ImageCropModalProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [rotation, setRotation] = useState<number>(0);
  const [brightness, setBrightness] = useState<number>(100);
  const [uploading, setUploading] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Reset happens in this wrapper (not in an effect) so it is part of the
  // same state transition as the close action. Every internal close path
  // goes through it instead of calling the `onOpenChange` prop directly.
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
      canvas.width = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;

      // Transparent background (previously filled with white, which is
      // what produced the white box around PNG products).
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      ctx.save();
      ctx.filter = `brightness(${brightness}%)`;
      ctx.translate(CANVAS_SIZE / 2, CANVAS_SIZE / 2);
      ctx.rotate((rotation * Math.PI) / 180);

      // Fit the WHOLE image (no center-crop). At 90°/270° the image's
      // width and height swap on screen, so the scale accounts for that.
      const swapped = rotation % 180 !== 0;
      const iw = swapped ? img.height : img.width;
      const ih = swapped ? img.width : img.height;
      const scale = Math.min(CANVAS_SIZE / iw, CANVAS_SIZE / ih);
      const w = img.width * scale;
      const h = img.height * scale;

      ctx.drawImage(img, -w / 2, -h / 2, w, h);
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
      // WebP keeps transparency (JPEG does not) and stays small.
      const blob = await new Promise<Blob | null>((resolve) => {
        canvasRef.current!.toBlob((b) => resolve(b), "image/webp", 0.9);
      });

      if (!blob) {
        throw new Error("تعذّر إنشاء ملف الصورة من اللوحة (Canvas).");
      }

      const formData = new FormData();
      formData.append("file", blob, "product-image.webp");
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