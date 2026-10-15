"use client";

/**
 * components/sales-log/date-range-picker.tsx
 *
 * T4c2 — the sales-log screen's date-range filter (required, defaults to
 * today). Built on the already-vendored shadcn Popover + Calendar
 * (components/ui/calendar.tsx, which already styles react-day-picker's
 * range_start/range_middle/range_end cells and already handles RTL chevron
 * rotation), with the Arabic locale coming from react-day-picker's own
 * re-export of date-fns's locales.
 *
 * Selection behaviour: the calendar applies the range IMMEDIATELY on each
 * click — picking a start day filters to that single day, and picking an
 * end day widens it. There is no "apply" button because a date range is
 * only ever a read filter here (no destructive or expensive side effect
 * to confirm), and the preset buttons below cover the common cases in one
 * click.
 *
 * [TWO-CLICK RANGE STATE] react-day-picker's `range` mode treats a range
 * as "closed" once BOTH from/to are set — any click after that starts a
 * brand-new range instead of widening the existing one. Applying the
 * first click immediately as a single day (from === to) would therefore
 * closes the range right away, making a genuine multi-day selection by
 * clicking impossible: every click after the first would be read as a
 * new one-day start. `pendingFrom` keeps the Calendar's OWN selection
 * state deliberately "open" (to: undefined) after the first click, while
 * still applying that single day to `value`/onChange immediately — so the
 * visible filter updates on every click, but the SECOND click is still
 * interpreted as widening the first, not starting over.
 *
 * Both bounds are local-midnight / local-end-of-day at the moment they are
 * applied (sales-log-utils.ts) so the request carries an explicit,
 * timezone-correct window rather than relying on the route's UTC fallback.
 *
 * [v4.5 — polish pass, presentation only] The trigger is 40px tall to match
 * the other filter controls and shows a chevron; the presets are pills that
 * highlight when they match the current range; a "تم" button closes the
 * popover (handy on phones, where tapping outside is awkward); the popover
 * never overflows a narrow viewport. Selection logic is unchanged.
 */

import { useState } from "react";
import { CalendarRange, ChevronDown } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { ar } from "react-day-picker/locale";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
    daysAgoLocalRange,
    endOfLocalDay,
    formatDayLabel,
    startOfLocalDay,
    startOfMonthLocalRange,
    todayLocalRange,
} from "./sales-log-utils";

export interface DateRangeValue {
    from: Date;
    to: Date;
}

interface DateRangePickerProps {
    value: DateRangeValue;
    onChange: (value: DateRangeValue) => void;
    disabled?: boolean;
}

const PRESETS: Array<{ label: string; getRange: () => DateRangeValue }> = [
    { label: "اليوم", getRange: todayLocalRange },
    { label: "آخر ٧ أيام", getRange: () => daysAgoLocalRange(6) },
    { label: "هذا الشهر", getRange: startOfMonthLocalRange },
];

/** Presentation only: does the current value equal this preset's range? */
function matchesPreset(value: DateRangeValue, preset: DateRangeValue): boolean {
    return (
        value.from.toDateString() === preset.from.toDateString() &&
        value.to.toDateString() === preset.to.toDateString()
    );
}

export function DateRangePicker({ value, onChange, disabled }: DateRangePickerProps) {
    const [open, setOpen] = useState(false);

    // Tracks an in-progress two-click selection — see the file header's
    // [TWO-CLICK RANGE STATE] note. Reset to null whenever the pending
    // selection is abandoned: a preset is chosen instead (below), or the
    // Popover closes before a second click completes (onOpenChange below).
    const [pendingFrom, setPendingFrom] = useState<Date | null>(null);

    const selected: DateRange = pendingFrom
        ? { from: pendingFrom, to: undefined }
        : { from: value.from, to: value.to };

    const handleSelect = (range: DateRange | undefined) => {
        if (!range?.from) return;

        if (!range.to) {
            // First click of a fresh two-click selection: apply
            // immediately as a single day (existing behavior), but keep
            // the Calendar's OWN state "open" (to: undefined) so
            // react-day-picker treats the next click as widening this
            // range, not starting a new one.
            setPendingFrom(range.from);
            onChange({ from: startOfLocalDay(range.from), to: endOfLocalDay(range.from) });
            return;
        }

        // Second click: a real multi-day range.
        setPendingFrom(null);
        onChange({ from: startOfLocalDay(range.from), to: endOfLocalDay(range.to) });
    };

    const isRange = value.from.toDateString() !== value.to.toDateString();

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                // [FIX] Abandoning a half-finished manual selection (closing
                // the Popover after only one click) must not leave a stale
                // "open" range behind — reopening should start clean, based
                // on whatever `value` currently is.
                if (!next) setPendingFrom(null);
            }}
        >
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    aria-expanded={open}
                    className={cn(
                        "h-10 w-full justify-between gap-2 rounded-lg text-xs font-semibold transition-all active:scale-[0.99]",
                        open && "border-emerald-500 ring-2 ring-emerald-500/20"
                    )}
                >
                    <span className="flex min-w-0 items-center gap-2">
                        <CalendarRange className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        <span className="truncate">
                            {formatDayLabel(value.from)}
                            {isRange && ` — ${formatDayLabel(value.to)}`}
                        </span>
                    </span>
                    <ChevronDown
                        className={cn(
                            "h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200",
                            open && "rotate-180"
                        )}
                    />
                </Button>
            </PopoverTrigger>

            <PopoverContent
                align="start"
                className="w-auto max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border-zinc-200 p-0 shadow-lg"
            >
                <div className="flex flex-wrap gap-1.5 border-b border-zinc-100 bg-zinc-50/60 p-2.5">
                    {PRESETS.map((preset) => {
                        const active = !pendingFrom && matchesPreset(value, preset.getRange());
                        return (
                            <button
                                key={preset.label}
                                type="button"
                                aria-pressed={active}
                                className={cn(
                                    "h-8 rounded-full border px-3 text-[11px] font-bold transition-all duration-200 active:scale-95",
                                    active
                                        ? "border-emerald-600 bg-emerald-600 text-white shadow-sm"
                                        : "border-zinc-200 bg-white text-zinc-700 hover:border-emerald-300 hover:bg-emerald-50"
                                )}
                                onClick={() => {
                                    // [FIX] A preset supersedes any in-progress
                                    // manual selection — without this, the
                                    // Calendar would keep showing the abandoned
                                    // single-day "open" state instead of the
                                    // preset's actual range.
                                    setPendingFrom(null);
                                    onChange(preset.getRange());
                                }}
                            >
                                {preset.label}
                            </button>
                        );
                    })}
                </div>

                <Calendar
                    mode="range"
                    locale={ar}
                    selected={selected}
                    onSelect={handleSelect}
                    numberOfMonths={1}
                    className="p-3"
                />

                <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-3 py-2.5">
                    <span className="text-[11px] font-medium text-zinc-500">
                        {pendingFrom ? "اختر اليوم الأخير من الفترة" : "اختر يوماً، ثم يوماً ثانياً لفترة أطول"}
                    </span>
                    <Button
                        type="button"
                        size="sm"
                        className="h-8 rounded-lg bg-emerald-600 px-4 text-xs font-bold text-white hover:bg-emerald-700 active:scale-95"
                        onClick={() => {
                            // Same cleanup the Popover's own close path does.
                            setOpen(false);
                            setPendingFrom(null);
                        }}
                    >
                        تم
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}