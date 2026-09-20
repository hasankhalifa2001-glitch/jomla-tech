"use client";

/**
 * components/sales-log/void-invoice-modal.tsx
 *
 * T4c2 §8 — the void trigger. Deliberately a thin confirmation wrapper over
 * T4d's ALREADY-IMPLEMENTED void flow rather than new void logic:
 *
 *   POST /api/ledger/voids   body: { invoiceId, voidReason }
 *
 * [PATH CORRECTION] The task text refers to "POST /api/invoices/void". No
 * such route exists in this codebase — T4d's endpoint is /api/ledger/voids
 * (app/api/ledger/voids/route.ts), which owns the real safety properties:
 * ADMIN-only via ledger:void_invoice, assertTenantWritable, the negated
 * invoice + items, batch restore through lib/inventory/units.ts, the
 * @unique constraint on voidsInvoiceId as the concurrency guard, and the
 * 409 on a genuine double-void race. This modal adds NO void semantics of
 * its own; it collects the mandatory reason and surfaces the server's
 * result.
 *
 * Rendered by the caller ONLY for an ADMIN session and ONLY for a
 * COMPLETED, not-already-voided invoice (see invoice-log-table.tsx's
 * canVoidInvoice) — the CASHIER case is absent from the DOM entirely, and
 * rejected server-side regardless.
 *
 * On success the parent refetches the log in place (onSuccess), so both the
 * new VOIDED row and the now-cross-linked original appear without a full
 * page reload.
 */

import { useState } from "react";
import { AlertCircle, AlertTriangle, Ban, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/lib/utils/money";
import type { InvoiceLogRow } from "./types";
import { formatRowTimestamp, invoiceReference } from "./sales-log-utils";

interface VoidInvoiceModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoice: InvoiceLogRow | null;
    /** Called after a successful void — parent re-fetches the current page. */
    onSuccess: () => void;
}

export function VoidInvoiceModal({ open, onOpenChange, invoice, onSuccess }: VoidInvoiceModalProps) {
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // Same render-phase reset pattern used by DeleteBatchModal: reset the
    // reason exactly once per open transition WITHOUT an Effect (React's
    // "You Might Not Need an Effect" — adjusting state on a prop change
    // belongs in the render body, not an Effect, to avoid an extra commit).
    const [prevOpen, setPrevOpen] = useState(open);
    if (open !== prevOpen) {
        setPrevOpen(open);
        if (open) setReason("");
    }

    // [FIX — real bug] The parent nulls `invoice` in the SAME render that
    // flips `open` to false (see sales-log-client.tsx:
    // onOpenChange={(open) => { if (!open) setVoidTarget(null); }}). A
    // naive `if (!invoice) return null;` here would therefore unmount the
    // whole component — <Dialog> included — the instant either Cancel or a
    // successful void fires, before Radix's own exit transition ever gets
    // to run. <Dialog open={false}> needs to stay mounted for that beat so
    // it can animate itself closed, exactly like invoice-detail-modal.tsx
    // never early-returns on missing data. Fix: remember the last non-null
    // invoice and keep rendering against that while `open` settles to
    // false.
    const [lastInvoice, setLastInvoice] = useState<InvoiceLogRow | null>(invoice);
    if (invoice && invoice !== lastInvoice) {
        setLastInvoice(invoice);
    }

    const displayInvoice = invoice ?? lastInvoice;
    if (!displayInvoice) return null;

    const isReasonValid = reason.trim().length >= 3;
    const canSubmit = isReasonValid && !submitting;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;

        setSubmitting(true);
        try {
            const res = await fetch("/api/ledger/voids", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    invoiceId: displayInvoice.id,
                    voidReason: reason.trim(),
                }),
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.message || "تعذّر إلغاء الفاتورة.");
            }

            toast.success(data.message || "تم إلغاء الفاتورة واسترجاع المخزون بنجاح.");
            onOpenChange(false);
            // Re-fetch the current page in place — no reload, no losing the
            // filters or pagination position the user was on.
            onSuccess();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "حدث خطأ أثناء إلغاء الفاتورة.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md" dir="rtl">
                <DialogHeader>
                    <div className="flex items-center gap-2">
                        <div className="rounded-lg bg-red-100 p-2 dark:bg-red-950/40">
                            <Ban className="h-5 w-5 text-red-600 dark:text-red-400" />
                        </div>
                        <div>
                            <DialogTitle className="text-base font-bold text-red-600 dark:text-red-400">
                                إلغاء الفاتورة
                            </DialogTitle>
                            <DialogDescription className="text-xs text-zinc-500">
                                {invoiceReference(displayInvoice.id)} — {formatRowTimestamp(displayInvoice.createdAt)}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4 py-2">
                    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs dark:border-red-900 dark:bg-red-950/20">
                        <div className="flex items-start gap-2 font-medium text-red-800 dark:text-red-300">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                            <span>
                                سيتم إنشاء فاتورة إلغاء بقيمة سالبة بنفس الأصناف، واسترجاع الكميات إلى
                                دفعاتها الأصلية. لا يمكن التراجع عن هذا الإجراء.
                            </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 border-t border-red-200/60 pt-2 text-[11px] text-zinc-600 dark:border-red-900/60 dark:text-zinc-400">
                            <div>
                                الزبون:{" "}
                                <span className="font-bold text-zinc-800 dark:text-zinc-200">
                                    {displayInvoice.customer.name}
                                </span>
                            </div>
                            <div>
                                قيمة الفاتورة:{" "}
                                <span className="font-bold text-zinc-800 dark:text-zinc-200">
                                    {formatMoney(displayInvoice.totalSYP, "SYP")} ل.س
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="voidReason" className="text-xs font-semibold">
                            سبب الإلغاء <span className="text-red-500">*</span>
                        </Label>
                        <Textarea
                            id="voidReason"
                            placeholder="مثال: إدخال خاطئ للفاتورة، إرجاع كامل من الزبون، تكرار بالخطأ..."
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            className="h-20 resize-none text-xs"
                            required
                        />
                        {reason.trim().length > 0 && reason.trim().length < 3 && (
                            <p className="flex items-center gap-1 text-[11px] text-red-500">
                                <AlertCircle className="h-3 w-3" />
                                يجب أن يحتوي السبب على 3 أحرف على الأقل.
                            </p>
                        )}
                    </div>

                    <DialogFooter className="gap-2 pt-2 sm:gap-0">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => onOpenChange(false)}
                            disabled={submitting}
                        >
                            إلغاء
                        </Button>
                        <Button type="submit" size="sm" variant="destructive" disabled={!canSubmit} className="gap-1.5">
                            {submitting && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                            تأكيد إلغاء الفاتورة
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}