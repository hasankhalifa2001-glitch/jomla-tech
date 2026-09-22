/* SublinkLauncher.tsx */
"use client";

import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import Link from "next/link";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Store, ExternalLink } from "lucide-react";
import s from "./shell.module.css";

export function SublinkLauncher() {
    const { data: session, status } = useSessionWithOfflineFallback();

    if (status === "loading" || !session?.tenantSlug) {
        return (
            <button
                type="button"
                disabled
                className={`${s.chip} ${s.linkChip} ${s.linkChipOff}`}
                aria-label="المتجر الإلكتروني"
            >
                <Store size={18} aria-hidden />
                <span className={s.onlyDesktop}>المتجر الإلكتروني</span>
            </button>
        );
    }

    const tenantSlug = session.tenantSlug;
    const sublinkUrl = `/store/${tenantSlug}`;

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Link
                        href={sublinkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="المتجر الإلكتروني"
                        className={`${s.chip} ${s.linkChip} ${s.linkChipOn}`}
                    >
                        <Store size={18} aria-hidden />
                        <span className={s.onlyDesktop}>المتجر الإلكتروني</span>
                        <ExternalLink size={13} className={`${s.linkExt} ${s.onlyDesktop}`} aria-hidden />
                    </Link>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                    فتح رابط المتجر المباشر: {sublinkUrl}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}