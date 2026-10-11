/* SublinkLauncher.tsx */
"use client";

import Link from "next/link";
import { ExternalLink, Store } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Quiet by default (no coloured box): icon-only below lg, icon + label from lg.
const BASE =
    "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent px-2.5 text-[13px] font-semibold text-slate-600 lg:px-3";

export function SublinkLauncher() {
    const { data: session, status } = useSessionWithOfflineFallback();

    if (status === "loading" || !session?.tenantSlug) {
        return (
            <button
                type="button"
                disabled
                aria-label="المتجر الإلكتروني"
                className={cn(BASE, "cursor-not-allowed opacity-40")}
            >
                <Store size={18} aria-hidden />
                <span className="hidden lg:inline">المتجر الإلكتروني</span>
            </button>
        );
    }

    const sublinkUrl = `/store/${session.tenantSlug}`;

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Link
                        href={sublinkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="المتجر الإلكتروني"
                        className={cn(
                            BASE,
                            "transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1"
                        )}
                    >
                        <Store size={18} aria-hidden />
                        <span className="hidden lg:inline">المتجر الإلكتروني</span>
                        <ExternalLink size={13} className="hidden text-slate-400 lg:inline" aria-hidden />
                    </Link>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                    فتح رابط المتجر المباشر: <bdi dir="ltr">{sublinkUrl}</bdi>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}