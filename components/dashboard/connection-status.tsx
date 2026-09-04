"use client";

import { useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Wifi, WifiOff } from "lucide-react";

function subscribe(callback: () => void) {
    window.addEventListener("online", callback);
    window.addEventListener("offline", callback);
    return () => {
        window.removeEventListener("online", callback);
        window.removeEventListener("offline", callback);
    };
}

function getSnapshot() {
    return navigator.onLine;
}

// No network signal exists during SSR — assume online so the server-
// rendered HTML never shows a false "غير متصل" flash before hydration
// corrects it against the real browser state.
function getServerSnapshot() {
    return true;
}

export function ConnectionStatus() {
    const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    return (
        <Badge
            variant="outline"
            className={`flex shrink-0 items-center gap-1.5 px-3 py-1 text-xs font-medium transition-colors ${isOnline
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