/**
 * lib/utils/compress-receipt.ts
 *
 * T6a — client-side receipt compression wrapper around
 * `browser-image-compression`. Target: output < 300 KB so the server-side
 * 400 KB ceiling (SUBSCRIPTION_RECEIPT_MAX_BYTES) is never hit by a
 * legitimate upload. Client compression is a UX nicety only — the server
 * re-validates size + magic bytes independently.
 */

import imageCompression from "browser-image-compression";

/** Target ceiling for the compressed output (< server max of 400 KB). */
export const RECEIPT_COMPRESSED_MAX_BYTES = 300 * 1024;

export interface CompressReceiptResult {
  file: File;
  /** True when the output still exceeds the target (caller should warn). */
  stillOversize: boolean;
}

/**
 * Compresses an image file to under RECEIPT_COMPRESSED_MAX_BYTES.
 * Always outputs JPEG/PNG/WEBP (never trusts the input extension alone —
 * the library re-encodes from decoded pixels).
 */
export async function compressReceiptImage(file: File): Promise<CompressReceiptResult> {
  const compressed: Blob = await imageCompression(file, {
    maxSizeMB: RECEIPT_COMPRESSED_MAX_BYTES / (1024 * 1024),
    maxWidthOrHeight: 1600,
    useWebWorker: true,
  });
  const out =
    compressed instanceof File
      ? compressed
      : new File([compressed], file.name.replace(/\.[a-zA-Z0-9]+$/, "") + ".jpg", {
          type: (compressed as Blob).type || "image/jpeg",
        });
  return { file: out, stillOversize: out.size >= RECEIPT_COMPRESSED_MAX_BYTES };
}
