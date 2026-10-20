"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
type RS = "PENDING" | "RESOLVED" | "DISMISSED";
const TABS = [
    { v: "PENDING", l: "بانتظار المراجعة" },
    { v: "RESOLVED", l: "تمت معالجتها" },
    { v: "DISMISSED", l: "مرفوضة" },
] as Array<{ v: RS; l: string }>;
interface RI {
    id: string; suggestedName: string | null; suggestedCategory: string | null;
    status: RS; createdAt: string; reason: string;
    entry: { id: string; name: string; category: string | null };
}
function fmtDT(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Intl.DateTimeFormat("ar-SY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Damascus" }).format(new Date(iso));
    } catch { return iso; }
}

export function CatalogReportsClient() {
    const [st, setSt] = useState<RS>("PENDING");
    const [items, setItems] = useState<RI[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [appending, setAppending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [apply, setApply] = useState<Record<string, boolean>>({});
    const load = useCallback(async (m: "reset" | "more", s: RS, c: string | null) => {
        if (m === "reset") setLoading(true); else setAppending(true);
        setError(null);
        try {
            const sp = new URLSearchParams({ status: s, limit: "25" });
            if (m === "more" && c) sp.set("cursor", c);
            const res = await fetch(`/api/admin/catalog-reports?${sp}`, { cache: "no-store" });
            const b = (await res.json().catch(() => ({}))) as { items?: RI[]; nextCursor?: string | null; message?: string };
            if (!res.ok) throw new Error(b.message || "تعذّر جلب البلاغات.");
            setItems((p) => (m === "reset" ? b.items ?? [] : [...p, ...(b.items ?? [])]));
            setCursor(b.nextCursor ?? null);
        } catch (e) { setError(e instanceof Error ? e.message : "تعذّر جلب البلاغات."); }
        finally { setLoading(false); setAppending(false); }
    }, []);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional queue reset on tab change
    useEffect(() => { void load("reset", st, null); }, [st, load]);
    async function act(id: string, kind: "resolve" | "dismiss") {
        setBusy(id); setError(null);
        try {
            const res = await fetch(`/api/admin/catalog-reports/${id}/${kind}`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: kind === "resolve" ? JSON.stringify({ apply: Boolean(apply[id]) }) : undefined,
                cache: "no-store",
            });
            const b = (await res.json().catch(() => ({}))) as { message?: string };
            if (!res.ok) throw new Error(b.message || "تعذّرت المعالجة.");
            setItems((p) => p.filter((r) => r.id !== id));
        } catch (e) { setError(e instanceof Error ? e.message : "تعذّرت المعالجة."); }
        finally { setBusy(null); }
    }
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="حالة البلاغ">
                {TABS.map((t) => (
                    <button key={t.v} type="button" role="tab" aria-selected={st === t.v} onClick={() => setSt(t.v)}
                        className={`rounded-xl px-4 py-2 text-sm font-bold ${st === t.v ? "bg-zinc-900 text-white" : "bg-white text-zinc-700 ring-1 ring-zinc-200"}`}>{t.l}</button>
                ))}
            </div>
            {loading ? (<p className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ التحميل…</p>
            ) : error ? (<div className="rounded-xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error} <button type="button" className="underline" onClick={() => void load("reset", st, null)}>إعادة المحاولة</button></div>
            ) : items.length === 0 ? (<p className="rounded-xl bg-white px-4 py-8 text-center text-sm text-zinc-500 ring-1 ring-zinc-200">لا توجد بلاغات في هذا التبويب.</p>
            ) : (<div className="grid gap-3">
                    {items.map((r) => (
                        <div key={r.id} className="rounded-2xl bg-white p-4 ring-1 ring-zinc-200">
                            <div className="font-bold">{r.entry.name}</div>
                            <div className="text-xs text-zinc-500">الحالي: {r.entry.category ?? "—"}</div>
                            <div className="mt-2 text-sm font-bold text-emerald-700">المقترح: {r.suggestedName ?? "—"}</div>
                            <div className="text-xs text-zinc-500">{r.suggestedCategory ?? "—"}</div>
                            <div className="mt-2 text-xs text-zinc-600">{r.reason}</div>
                            <div className="mt-1 text-xs text-zinc-500">{fmtDT(r.createdAt)}</div>
                            {r.status === "PENDING" ? (
                                <div className="mt-3 flex flex-col gap-2">
                                    <label className="flex items-center gap-1 text-xs text-zinc-600">
                                        <input type="checkbox" checked={Boolean(apply[r.id])} onChange={(e) => setApply((p) => ({ ...p, [r.id]: e.target.checked }))} />
                                        تطبيق الاقتراح على المدخل
                                    </label>
                                    <div className="flex gap-2">
                                        <Button size="sm" disabled={busy === r.id} onClick={() => void act(r.id, "resolve")}>اعتماد</Button>
                                        <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => void act(r.id, "dismiss")}>رفض</Button>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    ))}
                    {cursor ? (<div className="flex justify-center pt-2">
                        <Button variant="outline" disabled={appending} onClick={() => void load("more", st, cursor)}>
                            {appending ? (<><Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ التحميل…</>) : ("عرض المزيد")}
                        </Button>
                    </div>) : null}
                </div>)}
        </div>
    );
}
