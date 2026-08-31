/* SublinkLauncher.tsx */
"use client";

import { useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Store, ExternalLink } from "lucide-react";

export function SublinkLauncher() {
    const { data: session, status } = useSession();

    // FIX: no more "demo" fallback flashing while the session is still
    // loading — render a disabled placeholder instead of a link that could
    // briefly point at a fake tenant.
    if (status === "loading" || !session?.user?.tenantSlug) {
        return (
            <Button
                variant="outline"
                size="sm"
                disabled
                className="gap-2 border-zinc-200 bg-zinc-50/50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/30"
            >
                <Store className="h-4 w-4" />
                <span className="hidden sm:inline font-medium text-xs">المتجر الإلكتروني</span>
            </Button>
        );
    }

    const tenantSlug = session.user.tenantSlug;
    const sublinkUrl = `/store/${tenantSlug}`;

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        asChild
                        className="gap-2 border-emerald-200 bg-emerald-50/50 text-emerald-800 hover:bg-emerald-100 hover:text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300"
                    >
                        <Link href={sublinkUrl} target="_blank" rel="noopener noreferrer">
                            <Store className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                            <span className="hidden sm:inline font-medium text-xs">المتجر الإلكتروني</span>
                            <ExternalLink className="h-3 w-3 opacity-70" />
                        </Link>
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                    فتح رابط المتجر المباشر: {sublinkUrl}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}