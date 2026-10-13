"use client";

import { useEffect, useState } from "react";

/**
 * A quantity field that keeps its own draft while typing and commits on
 * blur / Enter, so clearing the field to type a new number never removes the
 * cart line mid-keystroke. An empty / zero commit means "remove this line".
 */
export function QtyInput({
    value,
    onCommit,
    className,
    label,
}: {
    value: string;
    onCommit: (raw: string) => void;
    className?: string;
    label: string;
}) {
    const [draft, setDraft] = useState(value);

    // Re-sync when the committed value changes from outside (+ / − buttons).
    useEffect(() => {
        const id = setTimeout(() => setDraft(value), 0);
        return () => clearTimeout(id);
    }, [value]);

    return (
        <input
            className={className}
            type="text"
            inputMode="decimal"
            lang="en"
            dir="ltr"
            aria-label={label}
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
            onFocus={(e) => e.target.select()}
            onBlur={() => onCommit(draft)}
            onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
        />
    );
}