"use client";

/**
 * components/orders/reject-order-dialog.tsx
 *
 * T5b — ADMIN-only reject dialog: required reason (3–500 chars, live
 * validation + counter), confirm disabled while in flight, Arabic errors
 * including 409 ALREADY_REVIEWED ("تمت مراجعة هذا الطلب مسبقاً").
 */

import { useState } from "react";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    AlertDialog, AlertDialogContent, AlertDialogHeader,
    AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export function RejectOrderDialog({
    open,
    orderRef,
    busy,
    serverError,
    onOpenChange,
    onConfirm,
}: {
    open: boolean;
    orderRef: string;
    busy: boolean;
    serverError: string | null;
    onOpenChange: (open: boolean) => void;
    onConfirm: (reason: string) => void;
}) {
    const [reason, setReason] = useState("");
    const [localError, setLocalError] = useState<string | null>(null);

    // Start every opening with an empty form (render-phase reset, no effect).
    const [prevOpen, setPrevOpen] = useState(open);
    if (open !== prevOpen) {
        setPrevOpen(open);
        if (open) {
            setReason("");
            setLocalError(null);
        }
    }

    function confirm() {
        const trimmed = reason.trim();
        if (trimmed.length < 3 || trimmed.length > 500) {
            setLocalError("سبب الرفض مطلوب (3–500 حرف).");
            return;
        }
        setLocalError(null);
        onConfirm(trimmed);
    }

    const message = localError ?? serverError;

    return (
        <AlertDialog
            open={open}
            // While the request is in flight the dialog cannot be dismissed
            // (Escape / outside click), so it never looks cancelled when it isn't.
            onOpenChange={(next) => { if (!busy) onOpenChange(next); }}
        >
            <AlertDialogContent dir="rtl" className="rounded-2xl">
                <AlertDialogHeader className="text-start">
                    <div className="flex items-center gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                            <XCircle className="size-5" aria-hidden />
                        </span>
                        <AlertDialogTitle className="text-lg font-extrabold text-zinc-900">
                            رفض الطلب {orderRef}
                        </AlertDialogTitle>
                    </div>
                    <AlertDialogDescription className="text-sm text-zinc-500">
                        سيظهر سبب الرفض في تفاصيل الطلب.
                    </AlertDialogDescription>
                </AlertDialogHeader>

                <div className="space-y-1.5">
                    <label htmlFor="t5b-reject-reason" className="text-sm font-bold text-zinc-800">
                        سبب الرفض <span className="font-normal text-zinc-500">(مطلوب، 3–500 حرف)</span>
                    </label>
                    <textarea
                        id="t5b-reject-reason"
                        rows={4}
                        className={cn(
                            "block w-full resize-none rounded-xl border bg-white px-3 py-2.5 text-sm text-zinc-900 shadow-sm outline-none transition-colors",
                            "placeholder:text-zinc-400 focus-visible:ring-2",
                            message
                                ? "border-red-400 focus-visible:ring-red-500/20"
                                : "border-zinc-200 focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20",
                        )}
                        value={reason}
                        onChange={(e) => { setReason(e.target.value); setLocalError(null); }}
                        maxLength={500}
                        aria-invalid={message ? true : undefined}
                    />
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-h-5" aria-live="polite">
                            {message && (
                                <p
                                    key={message}
                                    className="text-sm font-semibold text-red-600 motion-safe:animate-in fade-in slide-in-from-top-1 duration-200"
                                >
                                    {message}
                                </p>
                            )}
                        </div>
                        <span
                            dir="ltr"
                            className={cn(
                                "shrink-0 text-xs tabular-nums transition-colors",
                                reason.trim().length >= 3 ? "text-emerald-600" : "text-zinc-400",
                            )}
                        >
                            {reason.trim().length} / 500
                        </span>
                    </div>
                </div>

                <AlertDialogFooter className="gap-2 sm:justify-start">
                    <Button
                        className="h-10 rounded-xl bg-red-600 px-5 font-bold text-white transition-all hover:bg-red-700 active:scale-95"
                        disabled={busy || reason.trim().length < 3}
                        onClick={confirm}
                    >
                        {busy ? "جارٍ الرفض…" : "تأكيد الرفض"}
                    </Button>
                    <AlertDialogCancel disabled={busy} className="mt-0 h-10 rounded-xl px-5 font-bold">
                        إلغاء
                    </AlertDialogCancel>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}