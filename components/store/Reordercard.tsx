"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./store.module.css";
import { normalizeQty, useCart } from "./Cart";
import { lineKey } from "./keys";
import { ChevronLeftIcon, RepeatIcon } from "./Icons";
import { fmtInt } from "@/lib/utils/digits";
import type { CartLine, CartLineBase } from "./types";

interface SavedLine {
    productId: string;
    unitId: string;
    quantity: string;
}

/**
 * "أعد طلبي الأخير" (T5a §6.7). The last order's lines live in localStorage
 * (saved by CartDrawer after a successful submission). Which of them are still
 * orderable is decided from `available` — the server-built index of currently
 * listable product/unit pairs — so no network request is ever made here, and
 * stale lines are skipped (and counted) rather than failing the order later.
 */
export function ReorderCard({
    slug,
    available,
}: {
    slug: string;
    available: Record<string, CartLineBase>;
}) {
    const cart = useCart();
    const [saved, setSaved] = useState<SavedLine[] | null>(null);

    useEffect(() => {
        let cleared = false;
        const id = setTimeout(() => {
            if (cleared) return;
            try {
                const raw = window.localStorage.getItem(`store:${slug}:lastOrder`);
                if (!raw) return;
                const parsed: unknown = JSON.parse(raw);
                if (!Array.isArray(parsed)) return;
                const lines: SavedLine[] = [];
                for (const item of parsed) {
                    if (!item || typeof item !== "object") continue;
                    const r = item as Record<string, unknown>;
                    if (typeof r.productId === "string" && typeof r.unitId === "string") {
                        const q = normalizeQty(typeof r.quantity === "string" || typeof r.quantity === "number" ? r.quantity : "");
                        if (q !== null) lines.push({ productId: r.productId, unitId: r.unitId, quantity: q });
                    }
                }
                setSaved(lines);
            } catch {
                /* ignore */
            }
        }, 0);
        return () => {
            cleared = true;
            clearTimeout(id);
        };
    }, [slug]);

    const usable = useMemo(
        () => (saved ?? []).filter((s) => available[lineKey(s.productId, s.unitId)]),
        [saved, available]
    );

    if (!saved || usable.length === 0) return null;

    function reorder() {
        const lines: CartLine[] = usable.map((s) => ({
            ...available[lineKey(s.productId, s.unitId)],
            quantity: s.quantity,
        }));
        const skipped = (saved?.length ?? 0) - usable.length;
        cart.replaceAll(lines);
        cart.setNotice(
            skipped > 0
                ? `تم تجاهل ${fmtInt(skipped)} ${skipped === 1 ? "صنف" : "أصناف"} لأنها ما عادت متاحة.`
                : null
        );
        cart.setOpen(true);
    }

    return (
        <button type="button" className={styles.reorder} onClick={reorder}>
            <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <RepeatIcon size={26} />
                <span>
                    <b>أعد طلبي الأخير</b>
                    <small>
                        {fmtInt(usable.length)} {usable.length === 1 ? "صنف" : "أصناف"} من آخر طلب
                    </small>
                </span>
            </span>
            <span className={styles.reorderGo}>
                عبّي الطلب
                <ChevronLeftIcon />
            </span>
        </button>
    );
}