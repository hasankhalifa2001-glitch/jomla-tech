import type { CSSProperties } from "react";
import s from "./logo.module.css";

/**
 * جملة تك — brand mark + wordmark.
 *
 * The mark: a folded-corner document (the invoice) holding a geometric ج,
 * whose dot is the emerald "online" light of the offline-first system.
 *
 *   <Logo />                          full lockup on a light background
 *   <Logo tone="dark" />              full lockup on a dark background
 *   <Logo variant="mark" size={40} /> mark only
 *   <Logo animated />                 adds a soft pulse around the dot
 *
 * The wordmark is live text: it inherits the page font (Cairo) so it stays
 * crisp and searchable. No Tailwind and no other dependency is needed.
 */

export type LogoTone = "light" | "dark";

const PALETTE = {
    light: { tile: "#0f172a", flap: "#10b981", ink: "#ffffff", dot: "#34d399" },
    dark: { tile: "#f8fafc", flap: "#10b981", ink: "#0f172a", dot: "#059669" },
} as const;

// Geometry on a 64 x 64 grid (keep in sync with brand-kit/*.svg)
const TILE = "M18 4H45A15 15 0 0 1 60 19V45A15 15 0 0 1 45 60H19A15 15 0 0 1 4 45V18Z";
const FLAP = "M18 4L4 18H18Z";
const JEEM =
    "M47 19.5L28 21.5C21.5 22.2 17.5 25.5 17.5 31.5C17.5 39.5 23.5 44.5 31 44.5H41";
const DOT = { cx: 37.6, cy: 32.6, r: 4.6 } as const;

type MarkProps = {
    size?: number;
    tone?: LogoTone;
    animated?: boolean;
    /** Hide from assistive tech (use when the mark sits next to the wordmark). */
    decorative?: boolean;
    className?: string;
};

export function LogoMark({
    size,
    tone = "light",
    animated = false,
    decorative = false,
    className,
}: MarkProps) {
    const c = PALETTE[tone];
    const a11y = decorative
        ? ({ "aria-hidden": true } as const)
        : ({ role: "img", "aria-label": "جملة تك" } as const);
    return (
        <svg
            viewBox="0 0 64 64"
            width={size}
            height={size}
            className={className ? `${s.svg} ${className}` : s.svg}
            {...a11y}
        >
            <path d={TILE} fill={c.tile} />
            <path d={FLAP} fill={c.flap} />
            {animated && (
                <circle
                    className={s.ring}
                    cx={DOT.cx}
                    cy={DOT.cy}
                    r={DOT.r}
                    fill="none"
                    stroke={c.dot}
                    strokeWidth={1.4}
                />
            )}
            <path
                d={JEEM}
                fill="none"
                stroke={c.ink}
                strokeWidth={5.8}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx={DOT.cx} cy={DOT.cy} r={DOT.r} fill={c.dot} />
        </svg>
    );
}

type LogoProps = {
    variant?: "full" | "mark";
    tone?: LogoTone;
    /** Height of the mark in px; the wordmark scales with it (default 38). Omit it
     *  to size the logo from CSS by setting --logo-size on a parent selector. */
    size?: number;
    animated?: boolean;
    className?: string;
};

export function Logo({
    variant = "full",
    tone = "light",
    size,
    animated = false,
    className,
}: LogoProps) {
    if (variant === "mark") {
        return <LogoMark size={size ?? 40} tone={tone} animated={animated} className={className} />;
    }
    return (
        <span
            className={className ? `${s.root} ${className}` : s.root}
            data-tone={tone}
            style={size ? ({ "--logo-size": `${size}px` } as CSSProperties) : undefined}
            role="img"
            aria-label="جملة تك"
        >
            <LogoMark tone={tone} animated={animated} decorative />
            <span className={s.word} aria-hidden>
                <span className={s.name}>جملة</span>
                <span className={s.tag}>تك</span>
            </span>
        </span>
    );
}

export default Logo;