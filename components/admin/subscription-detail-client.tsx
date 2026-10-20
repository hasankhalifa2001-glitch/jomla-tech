"use client";

/** T6b Phase 3 — detail view: amount beside receipt + approve/reject dialogs. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fmtDT, fmtSYP, type AdminSubDetail } from "./subscription-detail-utils";

export function SubscriptionDetailClient({ initial, id }: { initial: AdminSubDetail; id: string }) {
    const router = useRouter();
    const [url, setUrl] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [approveOpen, setApproveOpen] = useState(false);
    const [rejectOpen, setRejectOpen] = useState(false);
    const [approveBusy, setApproveBusy] = useState(false);
    const [rejectBusy, setRejectBusy] = useState(false);
    const [approveError, setApproveError] = useState<string | null>(null);
    const [rejectError, setRejectError] = useState<string | null>(null);
    const [dialogError, setDialogError] = useState<string | null>(null);

    useEffect(() => {
        if (!initial.hasReceipt) return;
        let dead = false;
        fetch(`/api/admin/subscriptions/${id}/receipt`, { cache: "no-store" })
            .then(async (res) => {
                const body = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
                if (!res.ok) throw new Error(body.message || "تعذّر تحميل الإيصال.");
                if (!dead) setUrl(body.url ?? null);
            })
            .catch((e) => {
                if (!dead) setErr(e instanceof Error ? e.message : "تعذّر تحميل الإيصال.");
            });
        return () => {
            dead = true;
        };
    }, [id, initial.hasReceipt]);

    const showApprove = initial.status === "PENDING_APPROVAL";

    const handleApprove = useCallback(async () => {
        setApproveError(null);
        setApproveBusy(true);
        try {
            const res = await fetch(`/api/admin/subscriptions/${id}/approve`, {
                method: "POST",
                cache: "no-store",
            });
            const body = (await res.json().catch(() => ({}))) as {
                code?: string;
                message?: string;
                newExpiresAt?: string;
                success?: boolean;
            };
            if (!res.ok) {
                // 409 → race lost / already reviewed: close dialog, refetch server
                // state, and show a clear Arabic reason.
                setApproveOpen(false);
                router.refresh();
                setApproveError(
                    body.message ?? "تعذّر اعتماد الطلب — قد يكون قد رُوجِع من مسؤول آخر. تم تحديث الصفحة."
                );
                return;
            }
            setApproveOpen(false);
            router.refresh();
        } catch {
            setApproveError("تعذّر اعتماد الطلب. يرجى إعادة المحاولة.");
        } finally {
            setApproveBusy(false);
        }
    }, [id, router]);

    const handleReject = useCallback(
        async (reason: string) => {
            setRejectBusy(true);
            try {
                const res = await fetch(`/api/admin/subscriptions/${id}/reject`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    cache: "no-store",
                    body: JSON.stringify({ reason }),
                });
                const body = (await res.json().catch(() => ({}))) as {
                    code?: string;
                    message?: string;
                    success?: boolean;
                };
                if (!res.ok) {
                    // 409 → race lost / already reviewed: close dialog, refetch
                    // server state, and show a clear Arabic reason.
                    setRejectOpen(false);
                    router.refresh();
                    setRejectError(
                        body.message ?? "REVIEWED-FALLBACK"
                    );
                    return;
                }
                setRejectOpen(false);
                router.refresh();
            } catch {
                setRejectError("تعذّر رفض الطلب. يرجى إعادة المحاولة.");
            } finally {
                setRejectBusy(false);
            }
        },
        [id, router]
    );

    return (
        <div className="space-y-4" dir="rtl">
            {initial.isStale ? (
                <p
                    role="alert"
                    className="rounded-xl bg-amber-50 px-4 py-2 text-sm font-bold text-amber-700"
                >
                    هذا الطلب قديم — الاعتماد مسموح، تحقق من الإيصال والمبلغ بعناية.
                </p>
            ) : null}
            {approveError ? (
                <p
                    role="alert"
                    className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700"
                >
                    {approveError}
                </p>
            ) : null}
            {rejectError ? (
                <p
                    role="alert"
                    className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700"
                >
                    {rejectError}
                </p>
            ) : null}
            <h1 className="text-2xl font-extrabold">مراجعة طلب الاشتراك</h1>
            {initial.isStale ? (
                <p className="rounded-xl bg-amber-50 px-4 py-2 text-sm font-bold text-amber-700">
                    عرض قديم — الاعتماد مسموح، تحقق من الإيصال والمبلغ بعناية.
                </p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200">
                    <p className="text-sm text-zinc-500">المبلغ المطلوب</p>
                    <p className="mt-1 text-4xl font-extrabold">{fmtSYP(initial.amountSYP)} ل.س</p>
                    <p className="mt-1 text-sm text-zinc-500">${initial.amountUSD} • {initial.referenceCode}</p>
                    <dl className="mt-4 space-y-1 text-sm">
                        <div className="flex justify-between gap-2"><dt className="text-zinc-500">المتجر</dt><dd className="font-bold">{initial.tenant.name}</dd></div>
                        <div className="flex justify-between gap-2"><dt className="text-zinc-500">الهاتف</dt><dd dir="ltr">{initial.tenant.phone ?? "—"}</dd></div>
                        <div className="flex justify-between gap-2"><dt className="text-zinc-500">الباقة</dt><dd>{initial.tier} • {initial.durationDays} يوم</dd></div>
                        <div className="flex justify-between gap-2"><dt className="text-zinc-500">سعر وقت الطلب</dt><dd>{initial.exchangeRateUsed}</dd></div>
                        <div className="flex justify-between gap-2"><dt className="text-zinc-500">سعر المنصة الحالي</dt><dd>{initial.platformRate.current ?? "غير محدد"}</dd></div>
                        <div className="flex justify-between gap-2"><dt className="text-zinc-500">الانتهاء الحالي</dt><dd>{fmtDT(initial.tenant.expiresAt)}</dd></div>
                        <div className="flex justify-between gap-2"><dt className="text-zinc-500">الجديد عند الاعتماد</dt><dd className="font-bold">{fmtDT(initial.previewNewExpiry)}</dd></div>
                    </dl>
                    {showApprove && (
                        <div className="mt-4 flex gap-2">
                            <Button
                                onClick={() => setApproveOpen(true)}
                                disabled={approveBusy}
                                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
                            >
                                {approveBusy ? "جارٍ الاعتماد…" : "اعتماد الطلب"}
                            </Button>
                            <Button
                                onClick={() => setRejectOpen(true)}
                                disabled={rejectBusy}
                                variant="destructive"
                            >
                                {rejectBusy ? "جارٍ الرفض…" : "رفض الطلب"}
                            </Button>
                        </div>
                    )}
                </div>
                <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200">
                    {!initial.hasReceipt ? (
                        <p className="mt-2 text-sm text-zinc-500">لا يوجد إيصال مرفق.</p>
                    ) : err ? (
                        <p className="mt-2 text-sm font-bold text-red-600">{err}</p>
                    ) : url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={url} alt="إيصال التحويل" className="mt-2 max-h-105 w-full rounded-xl bg-zinc-50 object-contain" />
                    ) : (
                        <p className="mt-2 text-sm text-zinc-500">جارٍ تحميل الإيصال…</p>
                    )}
                </div>
            </div>
            <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200">
                <p className="text-sm font-bold">آخر طلبات المتجر (10)</p>
                <ul className="mt-2 divide-y divide-zinc-100 text-sm">
                    {initial.lastRequests.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                            <span>{fmtDT(r.createdAt)} • {r.tier}</span>
                            <span className="font-bold">{fmtSYP(r.amountSYP)} ل.س • {r.status}</span>
                        </li>
                    ))}
                </ul>
            </div>
            <p className="text-xs text-zinc-500">سبب الرفض مطلوب (3–500 حرف) وسيظهر في تفاصيل الطلب.</p>
            {/* Approve dialog */}
            <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
                <AlertDialogContent dir="rtl" className="rounded-2xl max-w-md">
                    <AlertDialogHeader className="text-start">
                        <AlertDialogTitle className="text-lg font-extrabold text-zinc-900">
                            اعتماد اشتراك {initial.tenant.name}
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-sm text-zinc-500">
                            سيعتمد الطلب ويُنتهي الاشتراك في{" "}
                            <span className="font-bold">{fmtDT(initial.previewNewExpiry)}</span>.
                        </AlertDialogDescription>
                    </AlertDialogHeader>

                    <div className="space-y-3 mt-3 text-sm">
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">المتجر</dt>
                            <dd className="font-bold">{initial.tenant.name}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">رقم المرجع</dt>
                            <dd dir="ltr" className="font-mono text-xs">
                                {initial.referenceCode}
                            </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">المبلغ المطلوب</dt>
                            <dd className="font-bold text-zinc-900">
                                {fmtSYP(initial.amountSYP)} ل.س
                            </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">الجديد عند الاعتماد</dt>
                            <dd className="font-bold">{fmtDT(initial.previewNewExpiry)}</dd>
                        </div>
                        {initial.isStale && (
                            <p className="rounded-xl bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700">
                                عرض قديم — تحقق من الإيصال والمبلغ قبل الاعتماد.
                            </p>
                        )}
                    </div>

                    <AlertDialogFooter className="gap-2 sm:justify-start">
                        <AlertDialogCancel disabled={approveBusy} className="mt-0 h-10 rounded-xl px-5 font-bold">
                            إلغاء
                        </AlertDialogCancel>
                        <AlertDialogAction asChild>
                            <Button
                                variant="default"
                                disabled={approveBusy}
                                className="h-10 rounded-xl bg-emerald-600 px-5 font-bold text-white hover:bg-emerald-700"
                                onClick={handleApprove}
                            >
                                {approveBusy ? "جارٍ الاعتماد…" : "تأكيد الاعتماد"}
                            </Button>
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Reject dialog */}
            <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
                <AlertDialogContent dir="rtl" className="rounded-2xl max-w-md">
                    <AlertDialogHeader className="text-start">
                        <div className="flex items-center gap-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                                <XCircle className="size-5" aria-hidden />
                            </span>
                            <AlertDialogTitle className="text-lg font-extrabold text-zinc-900">
                                رفض طلب {initial.tenant.name}
                            </AlertDialogTitle>
                        </div>
                        <AlertDialogDescription className="text-sm text-zinc-500">
                            سبب الرفض مطلوب وسيظهر في تفاصيل الطلب.
                        </AlertDialogDescription>
                    </AlertDialogHeader>

                    <div className="space-y-1.5 mt-3">
                        <label htmlFor="t6b-reject-reason" className="text-sm font-bold text-zinc-800">
                            سبب الرفض <span className="font-normal text-zinc-500">(مطلوب، 3–500 حرف)</span>
                        </label>
                        <textarea
                            id="t6b-reject-reason"
                            rows={4}
                            className="block w-full resize-none rounded-xl border bg-white px-3 py-2.5 text-sm text-zinc-900 shadow-sm outline-none transition-colors border-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/20"
                            placeholder="أكتب سبب الرفض هنا…"
                            maxLength={500}
                            aria-invalid={dialogError ? true : undefined}
                        />
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-h-5" aria-live="polite">
                                {dialogError && (
                                    <p
                                        key={dialogError}
                                        className="text-sm font-semibold text-red-600 motion-safe:animate-in fade-in slide-in-from-top-1 duration-200"
                                    >
                                        {dialogError}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>

                    <AlertDialogFooter className="gap-2 sm:justify-start">
                        <AlertDialogCancel disabled={rejectBusy} className="mt-0 h-10 rounded-xl px-5 font-bold">
                            إلغاء
                        </AlertDialogCancel>
                        <AlertDialogAction asChild>
                            <Button
                                variant="destructive"
                                disabled={rejectBusy}
                                className="h-10 rounded-xl bg-red-600 px-5 font-bold text-white hover:bg-red-700"
                                onClick={() => {
                                    const el = document.getElementById("t6b-reject-reason") as HTMLTextAreaElement | null;
                                    const reason = el ? el.value : "";
                                    const trimmed = reason.trim();
                                    if (trimmed.length < 3 || trimmed.length > 500) {
                                        setDialogError("سبب الرفض مطلوب (3–500 حرف).");
                                        return;
                                    }
                                    setDialogError(null);
                                    handleReject(trimmed);
                                }}
                            >
                                {rejectBusy ? "جارٍ الرفض…" : "تأكيد الرفض"}
                            </Button>
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
