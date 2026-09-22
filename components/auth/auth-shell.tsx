import Link from "next/link";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import s from "./auth.module.css";

/**
 * Shared frame for the auth screens (register now, login next):
 * form on one side, brand panel on the other (hidden on small screens,
 * where a compact logo sits above the form instead).
 */

export type AuthPoint = { title: string; body: string };

type Props = {
    children: ReactNode;
    panelTitle: string;
    panelLead: string;
    points: AuthPoint[];
    /** true: numbered steps joined by a line (a sequence); false: check-marked highlights. */
    numbered?: boolean;
};

export function AuthShell({ children, panelTitle, panelLead, points, numbered = true }: Props) {
    const List = numbered ? "ol" : "ul";
    return (
        <div className={s.shell}>
            <main className={s.formSide}>
                <Link href="/" className={s.homeLink} aria-label="جملة تك، الصفحة الرئيسية">
                    <Logo size={32} />
                </Link>
                <div className={s.formWrap}>{children}</div>
                <p className={s.legal}>© {new Date().getFullYear()} جملة تك</p>
            </main>

            <aside className={s.panel}>
                <div aria-hidden className={s.panelPattern} />
                <div aria-hidden className={`${s.glow} ${s.glowGreen}`} />
                <div aria-hidden className={`${s.glow} ${s.glowPurple}`} />

                <div className={s.panelTop}>
                    <Link href="/" aria-label="جملة تك، الصفحة الرئيسية">
                        <Logo tone="dark" size={40} />
                    </Link>
                </div>

                <div className={s.panelMain}>
                    <h2 className={s.panelTitle}>{panelTitle}</h2>
                    <p className={s.panelLead}>{panelLead}</p>
                    <List className={numbered ? s.points : `${s.points} ${s.pointsPlain}`}>
                        {points.map((p, i) => (
                            <li key={p.title} className={s.point}>
                                <span className={s.pointNum}>{numbered ? i + 1 : <Check size={16} aria-hidden />}</span>
                                <div>
                                    <p className={s.pointTitle}>{p.title}</p>
                                    <p className={s.pointBody}>{p.body}</p>
                                </div>
                            </li>
                        ))}
                    </List>
                </div>

                <div className={s.panelFoot}>
                    <span className={s.live}>
                        <span className={s.liveDot} />
                        يعمل حتى لو انقطع الإنترنت
                    </span>
                </div>
            </aside>
        </div>
    );
}