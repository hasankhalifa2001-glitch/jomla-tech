/**
 * lib/inventory/batch-errors.ts
 *
 * [FIX] BatchOperationError used to be exported from
 * app/api/inventory/batches/[id]/route.ts and imported by the reconcile
 * route via "../route". Next.js only allows specific exports from a
 * route.ts file (GET, POST, dynamic, ...); any other export is rejected by
 * the type-check step of `next build` (it passes silently in `next dev`).
 * The class now lives here and both routes import it from this file.
 */
export class BatchOperationError extends Error {
    readonly code: string;
    readonly statusCode: number;

    constructor(code: string, message: string, statusCode: number = 400) {
        super(message);
        this.name = "BatchOperationError";
        this.code = code;
        this.statusCode = statusCode;
    }
}