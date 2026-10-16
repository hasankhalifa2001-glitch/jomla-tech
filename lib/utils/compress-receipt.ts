import imageCompression from "browser-image-compression";

export const RECEIPT_COMPRESSED_MAX_BYTES = 300 * 1024;
/** Server hard limit (SUBSCRIPTION_RECEIPT_MAX_BYTES). The UI must block above this. */
export const RECEIPT_HARD_MAX_BYTES = 400 * 1024;

export type CompressReceiptResult =
  | { ok: true; file: File; overTarget: boolean }
  | { ok: false; reason: "UNREADABLE" | "TOO_LARGE" };

export async function compressReceiptImage(file: File): Promise<CompressReceiptResult> {
  let compressed: Blob;
  try {
    compressed = await imageCompression(file, {
      maxSizeMB: RECEIPT_COMPRESSED_MAX_BYTES / (1024 * 1024),
      maxWidthOrHeight: 1600,
      // The worker script is fetched from a CDN by default; on a weak or
      // filtered connection that can fail. One small image does not need it.
      useWebWorker: false,
      // Always re-encode to JPEG: PNG screenshots barely shrink with quality.
      fileType: "image/jpeg",
    });
  } catch {
    // e.g. HEIC from an iPhone, or a corrupt file.
    return { ok: false, reason: "UNREADABLE" };
  }

  const out =
    compressed instanceof File
      ? compressed
      : new File([compressed], file.name.replace(/\.[a-zA-Z0-9]+$/, "") + ".jpg", {
        type: "image/jpeg",
      });

  if (out.size > RECEIPT_HARD_MAX_BYTES) {
    return { ok: false, reason: "TOO_LARGE" };
  }
  return { ok: true, file: out, overTarget: out.size >= RECEIPT_COMPRESSED_MAX_BYTES };
}