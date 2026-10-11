"use client";

import { useSyncExternalStore } from "react";
import { Wifi, WifiOff } from "lucide-react";

import { cn } from "@/lib/utils";

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

// No network signal exists during SSR — assume online so the server-rendered
// HTML never shows a false "غير متصل" flash before hydration corrects it.
function getServerSnapshot() {
    return true;
}

/** Online is deliberately calm (icon + word from sm up); offline is the one
 *  state that gets a visible word on every screen size, in red. */
export function ConnectionStatus() {
    const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    return (
        <div
            role="status"
            aria-live="polite"
            className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-bold sm:px-3 sm:text-[13px]",
                isOnline
                    ? "w-9 justify-center border-emerald-200 bg-emerald-50 px-0 text-emerald-800 sm:w-auto sm:px-3"
                    : "border-red-200 bg-red-50 text-red-700"
            )}
        >
            <span className="relative flex size-2" aria-hidden>
                {!isOnline && (
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75 motion-reduce:animate-none" />
                )}
                <span
                    className={cn(
                        "relative inline-flex size-2 rounded-full",
                        isOnline ? "bg-emerald-500" : "bg-red-500"
                    )}
                />
            </span>
            {isOnline ? (
                <Wifi size={16} className="hidden sm:block" aria-hidden />
            ) : (
                <WifiOff size={16} aria-hidden />
            )}
            {isOnline && <span className="sr-only sm:hidden">متصل</span>}
            <span className={isOnline ? "hidden sm:inline" : ""}>{isOnline ? "متصل" : "غير متصل"}</span>
        </div>
    );
}