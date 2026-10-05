import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * One badge for every status pill on the inventory screen, so the colour
 * meaning lives in a single place:
 *   red   = needs action now (depleted, expired, negative stock, deactivated)
 *   amber = heads-up (expiring soon, stock on a discontinued unit)
 *   green = healthy / informational positive (valid expiry, base unit)
 *   slate = neutral information
 * (Purple is intentionally absent — in this app it means "USD".)
 */
export type BadgeTone = "slate" | "red" | "amber" | "green";

const TONES: Record<BadgeTone, string> = {
    slate: "border-slate-200 bg-slate-50 text-slate-600",
    red: "border-red-200 bg-red-50 text-red-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

type StatusBadgeProps = Omit<ComponentProps<typeof Badge>, "variant"> & {
    tone?: BadgeTone;
};

export function StatusBadge({ tone = "slate", className, ...props }: StatusBadgeProps) {
    return (
        <Badge
            variant="outline"
            className={cn(
                "gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
                TONES[tone],
                className
            )}
            {...props}
        />
    );
}