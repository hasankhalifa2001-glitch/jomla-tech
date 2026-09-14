// components/auth/logout-submit-button.tsx
"use client";

import { useTransition } from "react";
import { useActiveSessionStore } from "@/lib/store/useActiveSessionStore";

export function LogoutSubmitButton({
    children,
    className,
}: {
    children: React.ReactNode;
    className?: string;
}) {
    const setCurrentUserId = useActiveSessionStore((s) => s.setCurrentUserId);
    const [isPending, startTransition] = useTransition();

    return (
        <button
            type="submit"
            disabled={isPending}
            className={className}
            onClick={() => {
                setCurrentUserId(null);
            }}
        >
            {children}
        </button>
    );
}