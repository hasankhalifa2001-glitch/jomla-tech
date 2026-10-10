"use client";

import { useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";

type DecimalInputProps = Omit<
    ComponentProps<typeof Input>,
    "value" | "onChange" | "type" | "inputMode" | "defaultValue"
> & {
    /** The numeric value held by the parent (0 = "empty"). */
    value: number;
    onValueChange: (value: number) => void;
};

const toText = (n: number) => (Number.isFinite(n) && n !== 0 ? String(n) : "");

/**
 * A numeric field that keeps what the user is TYPING as text, and reports a
 * number to the parent.
 *
 * Why not <Input type="number" value={number}>: when the parent stores `0` for
 * an empty field, the input either snaps back to "0" (can't be cleared) or, if
 * "0" is displayed as empty, swallows the leading zero of "0.5" (can't type a
 * fraction). Here the text is local, so "", "0", "0.", "0.5" and "80" all type
 * naturally; the parent only ever sees a number (0 while empty/incomplete).
 *
 * If the parent changes `value` from outside (e.g. the form is re-initialised),
 * the text follows it.
 */
export function DecimalInput({ value, onValueChange, ...rest }: DecimalInputProps) {
    const [text, setText] = useState(() => toText(value));
    const [synced, setSynced] = useState(value);

    // Adjust-state-during-render: follow an external change of `value`.
    if (value !== synced) {
        setSynced(value);
        setText(toText(value));
    }

    return (
        <Input
            {...rest}
            type="text"
            inputMode="decimal"
            value={text}
            onChange={(e) => {
                const raw = e.target.value.replace(",", ".");
                // Digits with at most one dot; anything else is ignored.
                if (!/^\d*\.?\d*$/.test(raw)) return;
                const parsed = raw === "" || raw === "." ? 0 : parseFloat(raw);
                setText(raw);
                setSynced(parsed);
                onValueChange(parsed);
            }}
        />
    );
}