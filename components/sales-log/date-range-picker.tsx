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
 * Both bounds are local-midnight / local-end-of-day at the moment they are
 * applied (sales-log-utils.ts) so the request carries an explicit,
 * timezone-correct window rather than relying on the route's UTC fallback.
 */

import { useState } from "react";
import { CalendarRange } from "lucide-react";
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

export function DateRangePicker({ value, onChange, disabled }: DateRangePickerProps) {
    const [open, setOpen] = useState(false);

    const [pendingFrom, setPendingFrom] = useState<Date | null>(null);

    const selected: DateRange = pendingFrom
        ? { from: pendingFrom, to: undefined }
        : { from: value.from, to: value.to };

    const handleSelect = (range: DateRange | undefined) => {
        if (!range?.from) return;

        if (!range.to) {
            // First click of a fresh two-click selection: apply immediately
            // as a single day (existing behavior), but keep the Calendar's
            // OWN state "open" (to: undefined) so react-day-picker treats
            // the next click as widening this range, not starting a new one.
            setPendingFrom(range.from);
            onChange({ from: startOfLocalDay(range.from), to: endOfLocalDay(range.from) });
            return;
        }

        // Second click: a real multi-day range.
        setPendingFrom(null);
        onChange({ from: startOfLocalDay(range.from), to: endOfLocalDay(range.to) });
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    className={cn("h-9 gap-2 text-xs font-semibold justify-start")}
                >
                    <CalendarRange className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>
                        {formatDayLabel(value.from)}
                        {value.from.toDateString() !== value.to.toDateString() &&
                            ` — ${formatDayLabel(value.to)}`}
                    </span>
                </Button>
            </PopoverTrigger>

            <PopoverContent align="start" className="w-auto p-0">
                <div className="flex flex-wrap gap-1.5 border-b border-zinc-200 p-2 dark:border-zinc-800">
                    {PRESETS.map((preset) => (
                        <Button
                            key={preset.label}
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[11px] font-semibold"
                            onClick={() => onChange(preset.getRange())}
                        >
                            {preset.label}
                        </Button>
                    ))}
                </div>

                <Calendar
                    mode="range"
                    locale={ar}
                    selected={selected}
                    onSelect={handleSelect}
                    numberOfMonths={1}
                    className="p-3"
                />
            </PopoverContent>
        </Popover>
    );
}
