"use client";

/**
 * T6b Phase 2 — Super-Admin subscriptions queue (client, part 1: state + fetch).
 * Tabs, search, "load more" via opaque cursor. Rendering lives in part 2.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

export type QueueStatus = "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" | "EXPIRED";

export const SUB_TABS: Array<{ value: QueueStatus; label: string }> = [
    { value: "PENDING_APPROVAL", label: "بانتظار المراجعة" },
    { value: "ACTIVE", label: "نشطة" },
    { value: "REJECTED", label: "مرفوضة" },
    { value: "EXPIRED", label: "منتهية" },
];

export interface QueueItem {
    id: string;
    tenant: { id: string; name: string; slug: string; phone: string | null };
    tier: string;
    amountSYP: string;
    amountUSD: string;
    referenceCode: string;
    status: QueueStatus;
    createdAt: string;
    ageHours: number;
    hasReceipt: boolean;
    isStale: boolean;
}

export function useSubscriptionQueue() {
    const [status, setStatus] = useState<QueueStatus>("PENDING_APPROVAL");
    const [q, setQ] = useState("");
    const [debouncedQ, setDebouncedQ] = useState("");
    const [items, setItems] = useState<QueueItem[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [pendingCount, setPendingCount] = useState(0);
    const [truncated, setTruncated] = useState(false);
    const [loading, setLoading] = useState(true);
    const [appending, setAppending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDebouncedQ(q.trim()), 350);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [q]);

    const load = useCallback(async (mode: "reset" | "more", st: QueueStatus, query: string, cursor: string | null) => {
        if (mode === "reset") setLoading(true);
        else setAppending(true);
        setError(null);
        try {
            const sp = new URLSearchParams({ status: st, limit: "25" });
            if (query) sp.set("q", query);
            if (mode === "more" && cursor) sp.set("cursor", cursor);
            const res = await fetch(`/api/admin/subscriptions?${sp.toString()}`, { cache: "no-store" });
            const body = (await res.json().catch(() => ({}))) as {
                items?: QueueItem[];
                nextCursor?: string | null;
                pendingCount?: number;
                searchTruncated?: boolean;
                message?: string;
            };
            if (!res.ok) throw new Error(body.message || "تعذّر جلب الطلبات.");
            setItems((prev) => (mode === "reset" ? body.items ?? [] : [...prev, ...(body.items ?? [])]));
            setNextCursor(body.nextCursor ?? null);
            setPendingCount(body.pendingCount ?? 0);
            setTruncated(Boolean(body.searchTruncated));
        } catch (e) {
            setError(e instanceof Error ? e.message : "تعذّر جلب الطلبات.");
        } finally {
            setLoading(false);
            setAppending(false);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional queue reset on tab/search change
        setItems([]);
        setNextCursor(null);
        void load("reset", status, debouncedQ, null);
    }, [status, debouncedQ, load]);

    return { status, setStatus, q, setQ, debouncedQ, items, nextCursor, pendingCount, truncated, loading, appending, error, load };
}

export function QueueSearch({ q, setQ }: { q: string; setQ: (v: string) => void }) {
    return (
        <div className="relative max-w-md">
            <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
            <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="بحث برقم المرجع أو اسم المتجر…"
                className="ps-9"
                maxLength={100}
            />
        </div>
    );
}
