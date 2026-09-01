"use client";

import { useRef, useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Crop, Upload, RotateCw, Loader2 } from "lucide-react";
import { toast } from "sonner";

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

  // [FIX] Previously this reset ran inside a `useEffect` watching `open`,
  // which React's lint rule flags: "Calling setState synchronously within
  // an effect can trigger cascading renders." An effect is for
  // synchronizing with something external — reacting to a prop AFTER it
  // changed just to immediately set more state is exactly the pattern the
  // rule warns about, and it's pure overhead here since we already know
  // the reset is needed at the moment the modal closes.
  //
  // Fixed by moving the reset into a local `handleOpenChange` wrapper —
  // the exact same pattern already used correctly in AddProductModal.tsx.
  // Every internal close path (Cancel button, successful upload) now goes
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
      // [FIX] Routes through the local wrapper (not the raw prop) so the
      // reset happens immediately as part of this same close action.
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
        <DialogHeader>
          <DialogTitle className="text-base font-bold flex items-center gap-2">
            <Crop className="w-5 h-5 text-emerald-600" />
            <span>قص ومعالجة صورة المنتج (Canvas Crop)</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            تأطير الصورة بشكل مربعي قياسي للظهور في المتجر.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 my-2">
          {!imageSrc ? (
            <div className="p-6 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl text-center space-y-3 bg-zinc-50 dark:bg-zinc-900/50">
              <Upload className="w-8 h-8 mx-auto text-zinc-400" />
              <p className="text-xs text-zinc-600 dark:text-zinc-400">اختر صورة المنتج من جهازك</p>
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                disabled={uploading}
                className="text-xs text-zinc-500 file:mr-4 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100"
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-center bg-zinc-100 dark:bg-zinc-950 p-2 rounded-lg border border-zinc-200 dark:border-zinc-800">
                <canvas ref={canvasRef} className="w-56 h-56 object-cover border border-zinc-300 rounded-md shadow-xs" />
              </div>

              <div className="flex items-center justify-between text-xs">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => setRotation((prev) => (prev + 90) % 360)}
                  className="gap-1 h-8 text-[11px]"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  <span>تدوير 90°</span>
                </Button>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-500">السطوع:</span>
                  <input
                    type="range"
                    min="50"
                    max="150"
                    value={brightness}
                    disabled={uploading}
                    onChange={(e) => setBrightness(Number(e.target.value))}
                    className="w-24 accent-emerald-600 h-1 bg-zinc-200 rounded-lg cursor-pointer"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} disabled={uploading}>
            إلغاء
          </Button>
          {imageSrc && (
            <Button
              size="sm"
              onClick={handleSaveCrop}
              disabled={uploading}
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>جاري الرفع...</span>
                </>
              ) : (
                <span>اعتماد الصورة</span>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}