"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Wifi, WifiOff } from "lucide-react";

export function ConnectionStatus() {
    const [isOnline, setIsOnline] = useState<boolean>(true);

    useEffect(() => {
        // Set initial status based on navigator.onLine
        if (typeof window !== "undefined") {
            setIsOnline(navigator.onLine);
        }

        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);

        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);

        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    }, []);

    return (
        <Badge
            variant="outline"
            className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium transition-colors ${isOnline
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-400"
                    : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-400"
                }`}
        >
            <span
                className={`h-2 w-2 rounded-full ${isOnline ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
                    }`}
            />
            {isOnline ? (
                <>
                    <Wifi className="h-3.5 w-3.5" />
                    <span>متصل</span>
                </>
            ) : (
                <>
                    <WifiOff className="h-3.5 w-3.5" />
                    <span>غير متصل</span>
                </>
            )}
        </Badge>
    );
}
