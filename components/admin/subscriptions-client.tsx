"use client";

/** T6b Phase 2 — subscriptions queue screen (tabs + states + list). */
import { Loader2 } from "lucide-react";
import { QueueSearch, SUB_TABS, useSubscriptionQueue } from "./subscriptions-queue";
import { QueueList } from "./subscription-queue-list";

export function SubscriptionsClient() {
    const s = useSubscriptionQueue();
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="حالة الطلب">
                {SUB_TABS.map((t) => (
                    <button
                        key={t.value}
                        type="button"
                        role="tab"
                        aria-selected={s.status === t.value}
                        onClick={() => s.setStatus(t.value)}
                        className={`rounded-xl px-4 py-2 text-sm font-bold ${
                            s.status === t.value ? "bg-zinc-900 text-white" : "bg-white text-zinc-700 ring-1 ring-zinc-200"
                        }`}
                    >
                        {t.label}
                        {t.value === "PENDING_APPROVAL" && s.pendingCount > 0
                            ? ` (${s.pendingCount.toLocaleString("ar-SY")})`
                            : ""}
                    </button>
                ))}
            </div>
            <QueueSearch q={s.q} setQ={s.setQ} />
            {s.truncated ? (
                <p className="rounded-xl bg-amber-50 px-4 py-2 text-sm font-bold text-amber-700">نتائج كثيرة — ضيّق البحث.</p>
            ) : null}
            {s.loading ? (
                <p className="flex items-center gap-2 text-sm text-zinc-500">
                    <Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ التحميل…
                </p>
            ) : s.error ? (
                <div className="rounded-xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
                    {s.error}{" "}
                    <button type="button" className="underline" onClick={() => void s.load("reset", s.status, s.debouncedQ, null)}>
                        إعادة المحاولة
                    </button>
                </div>
            ) : s.items.length === 0 ? (
                <p className="rounded-xl bg-white px-4 py-8 text-center text-sm text-zinc-500 ring-1 ring-zinc-200">
                    لا توجد طلبات في هذا التبويب.
                </p>
            ) : (
                <QueueList
                    items={s.items}
                    nextCursor={s.nextCursor}
                    appending={s.appending}
                    status={s.status}
                    debouncedQ={s.debouncedQ}
                    loadMore={() => void s.load("more", s.status, s.debouncedQ, s.nextCursor)}
                />
            )}
        </div>
    );
}
