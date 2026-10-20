"use client";

/** T6b Phase 2 — detail view part 2: amount beside receipt + history. */
import { useEffect, useState } from "react";
import { fmtDT, fmtSYP, type AdminSubDetail } from "./subscription-detail-utils";

export function SubscriptionDetailClient({ initial, id }: { initial: AdminSubDetail; id: string }) {
    const [url, setUrl] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
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
    return (
        <div className="space-y-4">
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
                </div>
                <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200">
                    <p className="text-sm font-bold">إيصال التحويل</p>
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
            <p className="text-xs text-zinc-500">أزرار الاعتماد والرفض تُفعّل في المرحلة 3.</p>
        </div>
    );
}
