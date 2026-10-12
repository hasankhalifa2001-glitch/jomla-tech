import { cn } from "@/lib/utils";
import { fmtMoney, type MoneyInput } from "@/lib/utils/digits";

/**
 * One money figure. Number and unit are SEPARATE elements so the RTL bidi
 * algorithm can never shuffle them; USD is an isolated LTR run.
 * `compact` is for small inline text (the unit stays readable instead of
 * shrinking to 0.6em of an already-small font).
 */
export function Money({
    value,
    currency = "SYP",
    compact = false,
    className,
    unitClassName,
}: {
    value: MoneyInput;
    currency?: "SYP" | "USD";
    compact?: boolean;
    className?: string;
    unitClassName?: string;
}) {
    if (currency === "USD") {
        return (
            <bdi dir="ltr" className={cn("tabular-nums", className)}>
                $ {fmtMoney(value, "USD")}
            </bdi>
        );
    }
    return (
        <span className={cn("inline-flex items-baseline gap-1 tabular-nums", className)}>
            <span dir="ltr">{fmtMoney(value, "SYP")}</span>
            <span
                className={cn(
                    "font-semibold text-slate-500",
                    compact ? "text-[0.85em]" : "text-[0.6em]",
                    unitClassName
                )}
            >
                ل.س
            </span>
        </span>
    );
}