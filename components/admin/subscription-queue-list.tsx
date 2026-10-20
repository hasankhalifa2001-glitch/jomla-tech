"use client";

/** T6b Phase 2 — queue list rendering (table + cards + load-more). */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import type { QueueItem, QueueStatus } from "./subscriptions-queue";

export function fmtSYP(value: string): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return value;
    return new Intl.NumberFormat("ar-SY", { maximumFractionDigits: 0 }).format(n);
}

export function fmtDate(iso: string): string {
    try {
        return new Intl.DateTimeFormat("ar-SY", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "Asia/Damascus",
        }).format(new Date(iso));
    } catch {
        return iso;
    }
}

export function StaleBadge() {
    return (
        <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
            عرض قديم
        </span>
    );
}

export function fmtAge(hours: number): string {
    if (!Number.isFinite(hours) || hours < 0) return "—";
    if (hours < 1) return "أقل من ساعة";
    if (hours < 24) return `منذ ${hours} س`;
    const days = Math.floor(hours / 24);
    return `منذ ${days} يوم`;
}

export function QueueList(props: {
    items: QueueItem[];
    nextCursor: string | null;
    appending: boolean;
    status: QueueStatus;
    debouncedQ: string;
    loadMore: () => void;
}) {
    const { items, nextCursor, appending, status, debouncedQ, loadMore } = props;
    void status;
    void debouncedQ;
    return (
        <>
            <div className="hidden overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200 md:block">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-zinc-50 text-xs text-zinc-500">
                            <th className="px-4 py-3 text-start">المتجر</th>
                            <th className="px-4 py-3 text-start">الباقة</th>
                            <th className="px-4 py-3 text-start">المرجع</th>
                            <th className="px-4 py-3 text-start">المبلغ المطلوب</th>
                            <th className="px-4 py-3 text-start">الإيصال</th>
                            <th className="px-4 py-3 text-start">العمر</th>
                            <th className="px-4 py-3 text-start">التاريخ</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((row) => (
                            <tr key={row.id} className="border-t border-zinc-100">
                                <td className="px-4 py-3">
                                    <Link href={`/admin/subscriptions/${row.id}`} className="font-bold hover:underline">
                                        {row.tenant.name}
                                    </Link>
                                    <div className="text-xs text-zinc-500">{row.tenant.slug}</div>
                                    {row.tenant.phone ? <div className="text-xs text-zinc-500" dir="ltr">{row.tenant.phone}</div> : null}
                                </td>
                                <td className="px-4 py-3 text-xs font-bold">{row.tier}</td>
                                <td className="px-4 py-3 font-mono text-xs" dir="ltr">
                                    {row.referenceCode}
                                    {row.isStale ? <StaleBadge /> : null}
                                </td>
                                <td className="px-4 py-3 text-base font-extrabold">{fmtSYP(row.amountSYP)} ل.س</td>
                                <td className="px-4 py-3">{row.hasReceipt ? "مرفق" : "—"}</td>
                                <td className="px-4 py-3 text-xs text-zinc-500">{fmtAge(row.ageHours)}</td>
                                <td className="px-4 py-3 text-xs text-zinc-500">{fmtDate(row.createdAt)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="grid gap-3 md:hidden">
                {items.map((row) => (
                    <Link key={row.id} href={`/admin/subscriptions/${row.id}`} className="rounded-2xl bg-white p-4 ring-1 ring-zinc-200">
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-bold">{row.tenant.name}</span>
                            {row.isStale ? <StaleBadge /> : null}
                        </div>
                        <div className="mt-1 font-mono text-xs text-zinc-500" dir="ltr">
                            {row.referenceCode}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">الباقة: {row.tier}</div>
                        <div className="mt-2 text-lg font-extrabold">{fmtSYP(row.amountSYP)} ل.س</div>
                        <div className="mt-1 text-xs text-zinc-500">
                            {row.hasReceipt ? "الإيصال مرفق" : "بلا إيصال"} • {fmtAge(row.ageHours)} • {fmtDate(row.createdAt)}
                        </div>
                    </Link>
                ))}
            </div>
            {nextCursor ? (
                <div className="flex justify-center pt-2">
                    <Button variant="outline" disabled={appending} onClick={loadMore}>
                        {appending ? (
                            <>
                                <Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ التحميل…
                            </>
                        ) : (
                            "عرض المزيد"
                        )}
                    </Button>
                </div>
            ) : null}
        </>
    );
}
