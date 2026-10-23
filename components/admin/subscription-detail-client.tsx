"use client";

/**
 * T6b Phase 3 — detail view: amount beside receipt + approve/reject dialogs.
 *
 * Behaviour notes:
 *  - One `busy` flag guards BOTH actions (approve and reject can never be in flight together).
 *  - Confirm buttons are plain Buttons, not AlertDialogAction: AlertDialogAction closes the
 *    dialog on click, which hid validation errors and the in-flight state.
 *  - 409 (already reviewed / receipt missing) closes the dialog, refreshes the page and shows a
 *    banner. A retryable conflict (TX_RETRY) keeps the dialog open so the reviewer can retry.
 *    Any other failure keeps the dialog open with the error shown inside it.
 *  - The signed receipt URL lives ~5 minutes: if the image fails to load the reviewer can
 *    request a fresh link instead of reloading the page.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fmtDT, fmtSYP, type AdminSubDetail } from "./subscription-detail-utils";

type Kind = "approve" | "reject";
type ApiBody = { code?: string; error?: string; message?: string; url?: string };

// Same value as STORE_ERROR.TX_RETRY (kept local so this client file imports no server config).
const TX_RETRY_CODE = "TX_RETRY";
const REASON_MIN = 3;
const REASON_MAX = 500;

const TIER_LABELS = new Map<string, string>([
    ["monthly", "شهري"],
    ["yearly", "سنوي"],
]);
const STATUS_LABELS = new Map<string, string>([
    ["PENDING_APPROVAL", "بانتظار المراجعة"],
    ["ACTIVE", "نشط"],
    ["REJECTED", "مرفوض"],
    ["EXPIRED", "منتهٍ"],
]);
const tierLabel = (t: string) => TIER_LABELS.get(t) ?? t;
const statusLabel = (s: string) => STATUS_LABELS.get(s) ?? s;

const MSG = {
    conflict: "لم يعد هذا الطلب بانتظار المراجعة — ربما راجعه مسؤول آخر. تم تحديث الصفحة.",
    retry: "تعذّر إتمام العملية بسبب تعديل متزامن. أعد المحاولة.",
    approve: "تعذّر اعتماد الطلب. يرجى إعادة المحاولة.",
    reject: "تعذّر رفض الطلب. يرجى إعادة المحاولة.",
    receipt: "تعذّر تحميل الإيصال.",
    receiptExpired: "انتهت صلاحية رابط الإيصال أو تعذّر تحميل الصورة.",
    reasonRange: `سبب الرفض مطلوب (${REASON_MIN}–${REASON_MAX} حرف).`,
} as const;

async function readBody(res: Response): Promise<ApiBody> {
    return ((await res.json().catch(() => ({}))) as ApiBody) ?? {};
}

export function SubscriptionDetailClient({ initial, id }: { initial: AdminSubDetail; id: string }) {
    const router = useRouter();

    // Receipt (signed URL, refetchable)
    const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
    const [receiptErr, setReceiptErr] = useState<string | null>(null);
    const [receiptTick, setReceiptTick] = useState(0);

    // Actions
    const [dialog, setDialog] = useState<Kind | null>(null);
    const [busy, setBusy] = useState(false);
    const [dialogErr, setDialogErr] = useState<string | null>(null);
    const [banner, setBanner] = useState<string | null>(null);
    const [reason, setReason] = useState("");

    useEffect(() => {
        if (!initial.hasReceipt) return;
        const ac = new AbortController();
        fetch(`/api/admin/subscriptions/${id}/receipt`, { cache: "no-store", signal: ac.signal })
            .then(async (res) => {
                const body = await readBody(res);
                if (!res.ok || !body.url) throw new Error(body.message || MSG.receipt);
                setReceiptUrl(body.url);
            })
            .catch((e) => {
                if (ac.signal.aborted) return;
                setReceiptErr(e instanceof Error ? e.message : MSG.receipt);
            });
        return () => ac.abort();
    }, [id, initial.hasReceipt, receiptTick]);

    const reloadReceipt = useCallback(() => {
        setReceiptErr(null);
        setReceiptUrl(null);
        setReceiptTick((t) => t + 1);
    }, []);

    const openDialog = (kind: Kind) => {
        setDialogErr(null);
        setBanner(null);
        setDialog(kind);
    };

    const submit = useCallback(
        async (kind: Kind) => {
            if (busy) return;

            let init: RequestInit = { method: "POST", cache: "no-store" };
            if (kind === "reject") {
                const trimmed = reason.trim();
                if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
                    setDialogErr(MSG.reasonRange);
                    return;
                }
                init = {
                    ...init,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ reason: trimmed }),
                };
            }

            setBusy(true);
            setDialogErr(null);
            try {
                const res = await fetch(`/api/admin/subscriptions/${id}/${kind}`, init);
                if (res.ok) {
                    setDialog(null);
                    setBanner(null);
                    setReason("");
                    router.refresh();
                    return;
                }

                const body = await readBody(res);
                const code = body.code ?? body.error ?? "";

                if (res.status === 409 && code !== TX_RETRY_CODE) {
                    // Lost the race / already reviewed / receipt missing: the server state
                    // changed, so close, refetch and tell the reviewer why.
                    setDialog(null);
                    setBanner(body.message ?? MSG.conflict);
                    router.refresh();
                    return;
                }

                // Retryable conflict or any other failure: stay in the dialog.
                setDialogErr(body.message ?? (code === TX_RETRY_CODE ? MSG.retry : MSG[kind]));
            } catch {
                setDialogErr(MSG[kind]);
            } finally {
                setBusy(false);
            }
        },
        [busy, id, reason, router]
    );

    const showActions = initial.status === "PENDING_APPROVAL";

    return (
        <div className="space-y-4" dir="rtl">
            <Link
                href="/admin/subscriptions"
                className="inline-flex items-center gap-1 text-sm font-bold text-zinc-600 hover:text-zinc-900"
            >
                <ArrowRight className="size-4" aria-hidden />
                العودة إلى الطلبات
            </Link>

            <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-extrabold">مراجعة طلب الاشتراك</h1>
                <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-bold text-zinc-700">
                    {statusLabel(initial.status)}
                </span>
            </div>

            {banner ? (
                <p role="alert" className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700">
                    {banner}
                </p>
            ) : null}
            {initial.isStale ? (
                <p role="alert" className="rounded-xl bg-amber-50 px-4 py-2 text-sm font-bold text-amber-700">
                    هذا الطلب قديم — الاعتماد مسموح، تحقق من الإيصال والمبلغ بعناية.
                </p>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200">
                    <p className="text-sm text-zinc-500">المبلغ المطلوب</p>
                    <p className="mt-1 text-4xl font-extrabold">{fmtSYP(initial.amountSYP)} ل.س</p>
                    <p className="mt-1 text-sm text-zinc-500">
                        ${initial.amountUSD} • <span dir="ltr">{initial.referenceCode}</span>
                    </p>
                    <dl className="mt-4 space-y-1 text-sm">
                        <Row label="المتجر" value={initial.tenant.name} bold />
                        <Row label="الهاتف" value={<span dir="ltr">{initial.tenant.phone ?? "—"}</span>} />
                        <Row label="الباقة" value={`${tierLabel(initial.tier)} • ${initial.durationDays} يوم`} />
                        <Row label="سعر وقت الطلب" value={initial.exchangeRateUsed} />
                        <Row label="سعر المنصة الحالي" value={initial.platformRate.current ?? "غير محدد"} />
                        <Row label="الانتهاء الحالي" value={fmtDT(initial.tenant.expiresAt)} />
                        <Row label="الجديد عند الاعتماد" value={fmtDT(initial.previewNewExpiry)} bold />
                    </dl>
                    {showActions ? (
                        <div className="mt-4 flex gap-2">
                            <Button
                                onClick={() => openDialog("approve")}
                                disabled={busy}
                                className="bg-emerald-600 font-bold text-white hover:bg-emerald-700"
                            >
                                اعتماد الطلب
                            </Button>
                            <Button onClick={() => openDialog("reject")} disabled={busy} variant="destructive">
                                رفض الطلب
                            </Button>
                        </div>
                    ) : null}
                </div>

                <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200">
                    <p className="text-sm font-bold text-zinc-700">إيصال التحويل</p>
                    {!initial.hasReceipt ? (
                        <p className="mt-2 text-sm text-zinc-500">لا يوجد إيصال مرفق.</p>
                    ) : receiptErr ? (
                        <div className="mt-2 space-y-2">
                            <p className="text-sm font-bold text-red-600">{receiptErr}</p>
                            <Button variant="outline" size="sm" onClick={reloadReceipt}>
                                إعادة تحميل الإيصال
                            </Button>
                        </div>
                    ) : receiptUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={receiptUrl}
                            alt="إيصال التحويل"
                            onError={() => setReceiptErr(MSG.receiptExpired)}
                            className="mt-2 max-h-104 w-full rounded-xl bg-zinc-50 object-contain"
                        />
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
                            <span>
                                {fmtDT(r.createdAt)} • {tierLabel(r.tier)}
                            </span>
                            <span className="font-bold">
                                {fmtSYP(r.amountSYP)} ل.س • {statusLabel(r.status)}
                            </span>
                        </li>
                    ))}
                </ul>
            </div>

            {/* Approve dialog */}
            <AlertDialog
                open={dialog === "approve"}
                onOpenChange={(open) => {
                    if (!busy) setDialog(open ? "approve" : null);
                }}
            >
                <AlertDialogContent dir="rtl" className="max-w-md rounded-2xl">
                    <AlertDialogHeader className="text-start">
                        <AlertDialogTitle className="text-lg font-extrabold text-zinc-900">
                            اعتماد اشتراك {initial.tenant.name}
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-sm text-zinc-500">
                            سيتم اعتماد الطلب وتمديد الاشتراك حتى{" "}
                            <span className="font-bold">{fmtDT(initial.previewNewExpiry)}</span>.
                        </AlertDialogDescription>
                    </AlertDialogHeader>

                    <dl className="mt-3 space-y-3 text-sm">
                        <Row label="المتجر" value={initial.tenant.name} bold />
                        <Row label="رقم المرجع" value={<span dir="ltr" className="font-mono text-xs">{initial.referenceCode}</span>} />
                        <Row label="المبلغ المطلوب" value={`${fmtSYP(initial.amountSYP)} ل.س`} bold />
                        <Row label="الانتهاء الحالي" value={fmtDT(initial.tenant.expiresAt)} />
                        <Row label="الجديد عند الاعتماد" value={fmtDT(initial.previewNewExpiry)} bold />
                    </dl>
                    {initial.isStale ? (
                        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700">
                            عرض قديم — تحقق من الإيصال والمبلغ قبل الاعتماد.
                        </p>
                    ) : null}
                    {dialogErr ? (
                        <p role="alert" className="mt-3 text-sm font-semibold text-red-600">
                            {dialogErr}
                        </p>
                    ) : null}

                    <AlertDialogFooter className="gap-2 sm:justify-start">
                        <AlertDialogCancel disabled={busy} className="mt-0 h-10 rounded-xl px-5 font-bold">
                            إلغاء
                        </AlertDialogCancel>
                        <Button
                            disabled={busy}
                            onClick={() => void submit("approve")}
                            className="h-10 rounded-xl bg-emerald-600 px-5 font-bold text-white hover:bg-emerald-700"
                        >
                            {busy ? "جارٍ الاعتماد…" : "تأكيد الاعتماد"}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Reject dialog */}
            <AlertDialog
                open={dialog === "reject"}
                onOpenChange={(open) => {
                    if (!busy) setDialog(open ? "reject" : null);
                }}
            >
                <AlertDialogContent dir="rtl" className="max-w-md rounded-2xl">
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

                    <div className="mt-3 space-y-1.5">
                        <label htmlFor="t6b-reject-reason" className="text-sm font-bold text-zinc-800">
                            سبب الرفض{" "}
                            <span className="font-normal text-zinc-500">
                                (مطلوب، {REASON_MIN}–{REASON_MAX} حرف)
                            </span>
                        </label>
                        <textarea
                            id="t6b-reject-reason"
                            rows={4}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            disabled={busy}
                            maxLength={REASON_MAX}
                            placeholder="أكتب سبب الرفض هنا…"
                            aria-invalid={dialogErr ? true : undefined}
                            className="block w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/20"
                        />
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-h-5" aria-live="polite">
                                {dialogErr ? (
                                    <p className="text-sm font-semibold text-red-600">{dialogErr}</p>
                                ) : null}
                            </div>
                            <span className="text-xs text-zinc-400">
                                {reason.trim().length}/{REASON_MAX}
                            </span>
                        </div>
                    </div>

                    <AlertDialogFooter className="gap-2 sm:justify-start">
                        <AlertDialogCancel disabled={busy} className="mt-0 h-10 rounded-xl px-5 font-bold">
                            إلغاء
                        </AlertDialogCancel>
                        <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={() => void submit("reject")}
                            className="h-10 rounded-xl bg-red-600 px-5 font-bold text-white hover:bg-red-700"
                        >
                            {busy ? "جارٍ الرفض…" : "تأكيد الرفض"}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function Row({ label, value, bold }: { label: string; value: React.ReactNode; bold?: boolean }) {
    return (
        <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">{label}</dt>
            <dd className={bold ? "font-bold" : undefined}>{value}</dd>
        </div>
    );
}