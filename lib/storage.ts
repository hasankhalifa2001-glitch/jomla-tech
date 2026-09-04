import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// SHARED CLOUD STORAGE HELPER (Supabase Storage — replaces Cloudflare R2)
// ============================================================================
// Used by BOTH:
//   - T3 product images (app/api/upload/receipt/route.ts, "product" kind)
//   - T6 subscription receipt images (same route, "receipt" kind)
// One upload path, one client, one set of validation rules — see T1's
// folder structure entry for app/api/upload/receipt/route.ts, which
// describes it as a general "Cloud storage upload handler for compressed
// receipt/product images," not a receipt-only endpoint.
//
// WHY SUPABASE INSTEAD OF R2: R2's free tier still requires a bank card on
// file for account verification, which is not obtainable from Syria under
// current sanctions. Supabase Storage's free tier (1GB storage / 2GB
// egress per month) requires only an email to sign up. This file is a
// drop-in replacement — every exported name, signature, and error-message
// shape below is preserved from the R2 version, so
// app/api/upload/receipt/route.ts requires ZERO changes.
//
// ENV VARS (replaces S3_UPLOAD_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY /
// S3_BUCKET_NAME / S3_PUBLIC_URL_BASE):
//   SUPABASE_URL               — Project Settings -> API -> Project URL
//   SUPABASE_SERVICE_ROLE_KEY  — Project Settings -> API -> service_role
//                                 secret (NOT the anon/public key — this
//                                 runs server-side only and needs full
//                                 write access to a bucket that is not
//                                 publicly writable)
//   SUPABASE_BUCKET_NAME       — the Storage bucket to upload into; create
//                                 it in the Supabase dashboard and mark it
//                                 Public so getPublicUrl() resolves to a
//                                 browser-servable URL, mirroring what
//                                 S3_PUBLIC_URL_BASE did for R2.
// ============================================================================

const REQUIRED_ENV_VARS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_BUCKET_NAME",
] as const;

function assertStorageEnv(): void {
    const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(
            `Cloud storage is not configured — missing environment variable(s): ${missing.join(", ")}.`
        );
    }
}

let cachedClient: SupabaseClient | null = null;




function getSupabaseClient(): SupabaseClient {
    assertStorageEnv();

    if (!cachedClient) {
        cachedClient = createClient(
            process.env.SUPABASE_URL as string,
            // service_role key, never the anon key — see header comment.
            process.env.SUPABASE_SERVICE_ROLE_KEY as string,
            { auth: { persistSession: false } }
        );
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
//
// Also comfortably inside Supabase's free-tier egress budget per file.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export interface UploadFileParams {
    buffer: Buffer;
    key: string; // Full object path within the bucket, e.g. "products/<tenantId>/<uuid>.jpg"
    contentType: string;
}

/**
 * Uploads a file buffer to Supabase Storage and returns its public URL.
 * Callers are responsible for their own content-type/size validation
 * before calling this (see app/api/upload/receipt/route.ts) — this
 * function performs the upload only, it does not re-validate.
 */
export async function uploadFileToStorage(params: UploadFileParams): Promise<string> {
    assertStorageEnv();
    const client = getSupabaseClient();
    const bucket = process.env.SUPABASE_BUCKET_NAME as string;

    console.log("DEBUG upload:", { bucket: JSON.stringify(bucket), key: params.key }); // ← مؤقت


    const { error } = await client.storage
        .from(bucket)
        .upload(params.key, params.buffer, {
            contentType: params.contentType,
            upsert: false,
        });

    if (error) {
        throw new Error(`Cloud storage upload failed: ${error.message}`);
    }

    const { data } = client.storage.from(bucket).getPublicUrl(params.key);
    return data.publicUrl;
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