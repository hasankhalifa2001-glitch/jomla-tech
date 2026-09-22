"use client";

import { useSyncExternalStore } from "react";
import { Wifi, WifiOff } from "lucide-react";
import s from "./shell.module.css";

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
        <div
            role="status"
            aria-live="polite"
            className={`${s.chip} ${s.conn} ${isOnline ? s.connOn : s.connOff}`}
        >
            <span className={`${s.dot} ${isOnline ? s.dotOn : s.dotOff}`} aria-hidden />
            {isOnline ? <Wifi size={16} aria-hidden /> : <WifiOff size={16} aria-hidden />}
            <span>{isOnline ? "متصل" : "غير متصل"}</span>
        </div>
    );
}