import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// ============================================================================
// SHARED CLOUD STORAGE HELPER (Cloudflare R2, S3-compatible)
// ============================================================================
// Used by BOTH:
//   - T3 product images (app/api/upload/receipt/route.ts, "product" kind)
//   - T6 subscription receipt images (same route, "receipt" kind)
// One upload path, one client, one set of validation rules — see T1's
// folder structure entry for app/api/upload/receipt/route.ts, which
// describes it as a general "Cloud storage upload handler for compressed
// receipt/product images," not a receipt-only endpoint.
//
// [ADDED — beyond T1's original env var list] T1 specifies
// S3_UPLOAD_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_NAME. Those
// four are enough to AUTHENTICATE and WRITE to R2, but R2's S3-API endpoint
// itself is not a public, GET-able URL — reading an uploaded object back
// requires either R2's public bucket dev URL (https://pub-<hash>.r2.dev) or
// a custom domain mapped to the bucket. A fifth variable,
// `S3_PUBLIC_URL_BASE`, is required to construct the URL this app actually
// stores in ProductUnit.imageUrl / Subscription.receiptImageURL and serves
// back to the browser. Add it to .env / .env.example:
//   S3_PUBLIC_URL_BASE=https://pub-xxxxxxxxxxxx.r2.dev
//   (or your mapped custom domain, e.g. https://cdn.yourdomain.com)
// ============================================================================

const REQUIRED_ENV_VARS = [
    "S3_UPLOAD_ENDPOINT",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET_NAME",
    "S3_PUBLIC_URL_BASE",
] as const;

function assertStorageEnv(): void {
    const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(
            `Cloud storage is not configured — missing environment variable(s): ${missing.join(", ")}.`
        );
    }
}

let cachedClient: S3Client | null = null;

function getS3Client(): S3Client {
    assertStorageEnv();

    if (!cachedClient) {
        cachedClient = new S3Client({
            region: "auto", // R2 ignores region but the SDK requires a value.
            endpoint: process.env.S3_UPLOAD_ENDPOINT,
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY as string,
                secretAccessKey: process.env.S3_SECRET_KEY as string,
            },
            // R2 (and most non-AWS S3-compatible services) require path-style
            // addressing — virtual-hosted-style (bucket.endpoint.com) is an
            // AWS-specific default that does not resolve correctly against R2.
            forcePathStyle: true,
        });
    }

    return cachedClient;
}

// Server-side allowlist. The client (browser-image-compression /
// ImageCropModal's canvas export) already targets these formats, but the
// server must never trust a client-supplied content-type without checking
// it independently — a client-side check is a UX nicety, not a security
// boundary.
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

// [DECISION] 2 MB server-side ceiling, well above what either upload path
// should ever legitimately produce:
//   - Product images (T3): ImageCropModal renders into a fixed 400x400
//     canvas before export, which keeps output small regardless of the
//     original photo's size.
//   - Receipt images (T6): T1 requires client-side compression to <300KB
//     via browser-image-compression before upload.
// This is a server-side backstop, not the primary size control — a client
// can be modified or bypassed entirely, so the real ceiling must live here,
// independent of whatever the browser claims it already did.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export interface UploadFileParams {
    buffer: Buffer;
    key: string; // Full object path within the bucket, e.g. "products/<tenantId>/<uuid>.jpg"
    contentType: string;
}

/**
 * Uploads a file buffer to Cloudflare R2 and returns its public URL.
 * Callers are responsible for their own content-type/size validation
 * before calling this (see app/api/upload/receipt/route.ts) — this
 * function performs the upload only, it does not re-validate.
 */
export async function uploadFileToStorage(params: UploadFileParams): Promise<string> {
    const client = getS3Client();

    await client.send(
        new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: params.key,
            Body: params.buffer,
            ContentType: params.contentType,
        })
    );

    const publicBase = (process.env.S3_PUBLIC_URL_BASE as string).replace(/\/+$/, "");
    return `${publicBase}/${params.key}`;
}

/**
 * Builds a collision-resistant object key scoped by tenant and upload kind,
 * so a tenant's product images and any tenant's subscription receipts never
 * collide with each other or across tenants.
 */
export function buildStorageKey(params: {
    tenantId: string;
    kind: "products" | "receipts";
    extension: string;
}): string {
    const uuid =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return `${params.kind}/${params.tenantId}/${uuid}.${params.extension}`;
}