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
 * [T4f] The upload kinds this shared helper serves. `invoice-pdfs` is the
 * cached receipt PDF T4f writes once per Invoice (the value of
 * Invoice.receiptPdfUrl) — still one storage helper, still one client, still
 * one set of env vars, per this file's original one-endpoint rationale.
 */
export type StorageKind = "products" | "receipts" | "invoice-pdfs";

export const PDF_CONTENT_TYPE = "application/pdf";

/**
 * Builds a collision-resistant object key scoped by tenant and upload kind,
 * so a tenant's product images and any tenant's subscription receipts never
 * collide with each other or across tenants.
 */
export function buildStorageKey(params: {
    tenantId: string;
    /** products (T3) | receipts (T6) | invoice-pdfs (T4f). */
    kind: StorageKind;
    extension: string;
}): string {
    const uuid =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return `${params.kind}/${params.tenantId}/${uuid}.${params.extension}`;
}

/**
 * [T4f — Rule 3] A DETERMINISTIC key: the same invoice always maps to the same
 * object path, with no UUID.
 *
 * That determinism is not cosmetic — it is what makes the concurrency guard in
 * lib/data/receipts.ts correct:
 *   - Two concurrent first-share requests collide on ONE object rather than
 *     creating two (one of which would be orphaned forever), because
 *     uploadFileToStorageIfAbsent() treats the collision as "someone already
 *     wrote it" and reuses the existing public URL.
 *   - A crash between "upload succeeded" and "the conditional UPDATE committed"
 *     self-heals on the next attempt: the object is already there, so the
 *     retry reuses it and still performs the conditional UPDATE instead of
 *     failing forever.
 *
 * Scoped by tenant (so no cross-tenant path collision is even expressible) and
 * by invoice id (so two invoices can never share a PDF).
 */
export function buildDeterministicStorageKey(params: {
    tenantId: string;
    /** The server Invoice id — stable for the life of the invoice. */
    invoiceId: string;
    kind: StorageKind;
    extension: string;
}): string {
    return `${params.kind}/${params.tenantId}/${params.invoiceId}.${params.extension}`;
}

function publicUrlFor(key: string): string {
    const client = getSupabaseClient();
    const bucket = process.env.SUPABASE_BUCKET_NAME as string;
    return client.storage.from(bucket).getPublicUrl(key).data.publicUrl;
}

/**
 * Supabase reports "the object is already there" as a 409-class error whose
 * wording varies ("Duplicate", "already exists", "Resource already exists").
 * Matched loosely but explicitly: any OTHER error must still fail loudly, so
 * this predicate is deliberately narrow rather than "treat upload errors as
 * success".
 */
function isDuplicateObjectError(message: string): boolean {
    return /already exists|duplicate/i.test(message);
}

export interface UploadIfAbsentResult {
    key: string;
    url: string;
    /** True when the object was already present and this call wrote nothing. */
    alreadyExisted: boolean;
}

/**
 * [T4f — Rule 3's crash case] Uploads with `upsert: false` and treats "the
 * object already exists" as a SUCCESS carrying the existing URL, rather than
 * an error.
 *
 * Why this matters: with a deterministic key, the object at that path and the
 * value of Invoice.receiptPdfUrl must be allowed to converge. If a previous
 * attempt uploaded the PDF and then died before its conditional UPDATE
 * committed, a naive `upsert: false` upload would fail on every subsequent
 * attempt forever — the invoice would be permanently un-shareable. Returning
 * `alreadyExisted: true` lets the caller proceed to the conditional UPDATE,
 * which is what actually decides who wins.
 *
 * Genuine failures (auth, network, bucket missing, quota) still throw.
 */
export async function uploadFileToStorageIfAbsent(
    params: UploadFileParams
): Promise<UploadIfAbsentResult> {
    assertStorageEnv();
    const client = getSupabaseClient();
    const bucket = process.env.SUPABASE_BUCKET_NAME as string;

    const { error } = await client.storage
        .from(bucket)
        .upload(params.key, params.buffer, {
            contentType: params.contentType,
            upsert: false,
        });

    if (!error) {
        return { key: params.key, url: publicUrlFor(params.key), alreadyExisted: false };
    }

    if (!isDuplicateObjectError(error.message ?? "")) {
        throw new Error(`Cloud storage upload failed: ${error.message}`);
    }

    // Confirmed, not assumed: only a real listing of the containing prefix
    // turns a duplicate-error into "already exists".
    if (!(await objectExists(params.key))) {
        throw new Error(`Cloud storage upload failed: ${error.message}`);
    }

    return { key: params.key, url: publicUrlFor(params.key), alreadyExisted: true };
}

/** True when an object exists at `key` (used to verify a duplicate upload). */
export async function objectExists(key: string): Promise<boolean> {
    assertStorageEnv();
    const client = getSupabaseClient();
    const bucket = process.env.SUPABASE_BUCKET_NAME as string;

    const segments = key.split("/");
    const name = segments[segments.length - 1];
    const prefix = segments.slice(0, -1).join("/");

    const { data, error } = await client.storage
        .from(bucket)
        .list(prefix, { limit: 100, search: name });

    if (error) return false;
    return (data ?? []).some((entry) => entry.name === name);
}

/**
 * Removes an object. Used only to discard the LOSER's artifact in the Rule 3
 * race, so a losing request never leaves orphaned storage behind. Best-effort
 * by design: a failed delete costs storage, not correctness, and must never
 * turn a successful share into an error.
 */
export async function removeFileFromStorage(key: string): Promise<void> {
    assertStorageEnv();
    const client = getSupabaseClient();
    const bucket = process.env.SUPABASE_BUCKET_NAME as string;

    const { error } = await client.storage.from(bucket).remove([key]);
    if (error) {
        throw new Error(`Cloud storage delete failed: ${error.message}`);
    }
}