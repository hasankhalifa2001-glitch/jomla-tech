"use client";

/**
 * T6b — platform rate settings screen (Super-Admin only).
 * Shows the current value + last-changed time, warns when the checkout is
 * blocked (no rate set), and PUTs { rate, confirm } with a confirm flow for
 * large moves (>25% vs current → 409 CONFIRM_REQUIRED).
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface RateView {
    rate: string | null;
    updatedAt: string | null;
}

function fmtDT(iso: string | null): string {
    if (!iso) return "—";
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

export function SettingsClient({ initial }: { initial: RateView }) {
    const [rate, setRate] = useState(initial.rate ?? "");
    const [view, setView] = useState<RateView>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmNeeded, setConfirmNeeded] = useState<{ currentRate: string; newRate: string } | null>(null);
    const [ok, setOk] = useState<string | null>(null);

    async function submit(confirmed: boolean) {
        setBusy(true);
        setError(null);
        setOk(null);
        try {
            const res = await fetch("/api/admin/platform-rate", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ rate: rate.trim(), ...(confirmed ? { confirm: true } : {}) }),
                cache: "no-store",
            });
            const body = (await res.json().catch(() => ({}))) as {
                rate?: string | null;
                updatedAt?: string | null;
                message?: string;
                error?: string;
                currentRate?: string;
                newRate?: string;
            };
            if (res.status === 409 && body.error === "CONFIRM_REQUIRED") {
                setConfirmNeeded({ currentRate: body.currentRate ?? "", newRate: body.newRate ?? rate.trim() });
                return;
            }
            if (!res.ok) throw new Error(body.message || "تعذّر تحديث سعر الصرف.");
            setView({ rate: body.rate ?? null, updatedAt: body.updatedAt ?? null });
            setConfirmNeeded(null);
            setOk(body.message || "تم الحفظ.");
        } catch (e) {
            setError(e instanceof Error ? e.message : "تعذّر تحديث سعر الصرف.");
        } finally {
            setBusy(false);
        }
    }

    const blocked = view.rate == null;

    return (
        <div className="max-w-xl space-y-4">
            <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200">
                <div className="text-sm text-zinc-500">سعر الصرف الحالي</div>
                <div className="mt-1 text-3xl font-extrabold" dir="ltr">
                    {view.rate ?? "—"}
                </div>
                <div className="mt-1 text-xs text-zinc-500">آخر تحديث: {fmtDT(view.updatedAt)}</div>
                {blocked ? (
                    <p className="mt-3 rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700">
                        الدفع معطّل حالياً — لا يوجد سعر صرف. حدّد سعراً لتفعيل إنشاء طلبات الاشتراك.
                    </p>
                ) : null}
            </div>
            <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200">
                <label htmlFor="t6b-platform-rate" className="text-sm font-bold text-zinc-800">
                    سعر جديد <span className="font-normal text-zinc-500">(رقم عشري، أكبر من صفر، حتى 4 خانات)</span>
                </label>
                <div className="mt-2 flex gap-2">
                    <Input
                        id="t6b-platform-rate"
                        value={rate}
                        onChange={(e) => setRate(e.target.value)}
                        placeholder="مثال: 12500"
                        inputMode="decimal"
                        dir="ltr"
                        className="text-left"
                    />
                    <Button disabled={busy} onClick={() => void submit(false)}>
                        {busy ? (
                            <>
                                <Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ الحفظ…
                            </>
                        ) : (
                            "حفظ"
                        )}
                    </Button>
                </div>
                {error ? <p className="mt-2 text-sm font-bold text-red-600">{error}</p> : null}
                {ok ? <p className="mt-2 text-sm font-bold text-emerald-700">{ok}</p> : null}
                {confirmNeeded ? (
                    <div className="mt-3 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
                        <p className="text-sm font-bold text-amber-800">
                            التغيير كبير ({confirmNeeded.currentRate} ← {confirmNeeded.newRate}) — يرجى التأكيد.
                        </p>
                        <div className="mt-2 flex gap-2">
                            <Button variant="outline" disabled={busy} onClick={() => setConfirmNeeded(null)}>
                                إلغاء
                            </Button>
                            <Button disabled={busy} onClick={() => void submit(true)}>
                                تأكيد التغيير
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
