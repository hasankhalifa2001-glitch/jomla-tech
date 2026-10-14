import { cn } from "@/lib/utils";
import { ORDER_STATUS_LABELS, type OrderStatusValue } from "./orders-utils";

const STYLES: Record<OrderStatusValue, { pill: string; dot: string }> = {
    PENDING_REVIEW: { pill: "bg-amber-50 text-amber-700 ring-amber-200", dot: "bg-amber-500" },
    APPROVED: { pill: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
    REJECTED: { pill: "bg-red-50 text-red-700 ring-red-200", dot: "bg-red-500" },
};

export function StatusBadge({ status, className }: { status: OrderStatusValue; className?: string }) {
    const st = STYLES[status];
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset",
                st.pill,
                className,
            )}
        >
            <span className={cn("size-1.5 rounded-full", st.dot)} aria-hidden />
            {ORDER_STATUS_LABELS[status]}
        </span>
    );
}