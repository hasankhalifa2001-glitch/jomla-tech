"use client";

import type { FormEvent, KeyboardEvent, ReactNode, SelectHTMLAttributes } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

/**
 * Building blocks shared by every inventory modal, so each one stops
 * re-implementing its own layout:
 *
 *   ModalShell      header + stepper stay put, ONLY the body scrolls, and the
 *                   footer buttons are always visible. (The old modals scrolled
 *                   as one block, so on a short screen the "التالي" button was
 *                   hidden until you scrolled to the very bottom.)
 *   ModalStepper    the numbered step indicator
 *   Field           label + control + hint, one consistent spacing
 *   NativeSelect    a <select> styled to match shadcn's Input
 *   Segmented       a 2–3 option toggle (e.g. SYP / USD)
 */

const SIZES = {
    sm: "sm:max-w-md",
    md: "sm:max-w-xl",
    lg: "sm:max-w-2xl",
    xl: "sm:max-w-4xl",
} as const;

interface ModalShellProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    icon?: LucideIcon;
    description?: string;
    /** Rendered under the title inside the fixed header (e.g. the stepper). */
    header?: ReactNode;
    onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
    onKeyDown?: (e: KeyboardEvent<HTMLFormElement>) => void;
    footer: ReactNode;
    size?: keyof typeof SIZES;
    children: ReactNode;
}

export function ModalShell({
    open,
    onOpenChange,
    title,
    icon: Icon,
    description,
    header,
    onSubmit,
    onKeyDown,
    footer,
    size = "lg",
    children,
}: ModalShellProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                dir="rtl"
                className={cn(
                    // Phone: a bottom sheet. Desktop: centred.
                    "fixed inset-x-0 bottom-0 left-0 right-0 top-auto translate-x-0 translate-y-0",
                    "flex max-h-[92dvh] w-full max-w-full flex-col gap-0 overflow-hidden",
                    "rounded-b-none rounded-t-2xl border border-slate-200 bg-white p-0",
                    "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:max-h-[90dvh]",
                    "sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl",
                    SIZES[size]
                )}
            >
                <DialogHeader className="shrink-0 space-y-1 border-b border-slate-100 px-5 pb-3 pt-5 text-start sm:text-start">
                    <DialogTitle className="flex items-center gap-2 text-lg font-bold text-slate-900">
                        {Icon && <Icon className="size-5 text-emerald-600" aria-hidden />}
                        <span>{title}</span>
                    </DialogTitle>
                    {description && (
                        <DialogDescription className="text-xs text-slate-500">{description}</DialogDescription>
                    )}
                    {header}
                </DialogHeader>

                <form onSubmit={onSubmit} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
                    <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
                    <DialogFooter className="shrink-0 flex-row items-center gap-2 border-t border-slate-100 bg-white px-5 py-3 sm:justify-between sm:space-x-0">
                        {footer}
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ModalStepper({ steps, current }: { steps: string[]; current: number }) {
    return (
        <ol className="flex items-center gap-2 pt-2" aria-label="خطوات الإضافة">
            {steps.map((label, i) => {
                const n = i + 1;
                const active = n === current;
                const done = n < current;
                return (
                    <li
                        key={label}
                        aria-current={active ? "step" : undefined}
                        className="flex flex-1 items-center gap-2 last:flex-none"
                    >
                        <span
                            className={cn(
                                "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                                active && "bg-emerald-600 text-white",
                                done && "bg-emerald-100 text-emerald-700",
                                !active && !done && "bg-slate-100 text-slate-400"
                            )}
                        >
                            {done ? <Check className="size-4" aria-hidden /> : n}
                        </span>
                        {/* On a phone only the current step keeps its label. */}
                        <span
                            className={cn(
                                "text-xs font-semibold",
                                active ? "text-slate-900" : "hidden text-slate-400 sm:inline"
                            )}
                        >
                            {label}
                        </span>
                        {n < steps.length && (
                            <span className={cn("h-px flex-1", done ? "bg-emerald-300" : "bg-slate-200")} />
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

export function Field({
    label,
    htmlFor,
    required,
    hint,
    className,
    children,
}: {
    label: ReactNode;
    htmlFor?: string;
    required?: boolean;
    hint?: ReactNode;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={cn("space-y-1.5", className)}>
            <label htmlFor={htmlFor} className="block text-xs font-semibold text-slate-700">
                {label}
                {required && <span className="ms-0.5 text-red-500">*</span>}
            </label>
            {children}
            {hint && <p className="text-xs leading-relaxed text-slate-500">{hint}</p>}
        </div>
    );
}

export function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select
            className={cn(
                "h-10 w-full rounded-md border border-input bg-white px-3 text-sm text-slate-900",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1",
                "disabled:cursor-not-allowed disabled:opacity-50",
                className
            )}
            {...props}
        />
    );
}

export function Segmented<T extends string>({
    value,
    onChange,
    options,
    ariaLabel,
}: {
    value: T;
    onChange: (value: T) => void;
    options: Array<{ value: T; label: string }>;
    ariaLabel: string;
}) {
    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            className="inline-flex h-10 w-full items-center rounded-md border border-slate-200 bg-slate-50 p-0.5"
        >
            {options.map((o) => {
                const selected = value === o.value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => onChange(o.value)}
                        className={cn(
                            "h-full flex-1 rounded-[5px] px-3 text-sm font-semibold transition-colors",
                            selected ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                        )}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}