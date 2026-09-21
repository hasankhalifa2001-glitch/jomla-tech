"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, RefreshCw, Wifi, WifiOff, Clock } from "lucide-react";
import s from "./marketing.module.css";

/**
 * The only client component on the landing page. It plays a looping story:
 * device offline -> invoices wait in the queue -> connection returns -> they
 * upload one by one. The three steps on the side light up in sync with it.
 * The loop only runs while the queue is on screen, and is static when the
 * user prefers reduced motion.
 */

const steps = [
    { title: "تُحفظ على جهازك", body: "لحظة إتمام البيع، دون أي طلب إلى الإنترنت." },
    { title: "تنتظر في الطابور", body: "بنفس ترتيب البيع الفعلي." },
    { title: "تُرفع تلقائياً", body: "عند عودة الاتصال، ولا تتكرر إن أُعيد الإرسال." },
];

const queueRows = [
    { title: "فاتورة #1041", meta: "متجر الأمل" },
    { title: "فاتورة #1042", meta: "متجر الأمل" },
    { title: "دفعة 500,000 ل.س", meta: "بقالة النور" },
    { title: "زبون جديد", meta: "مخبز الفجر" },
];

const CYCLE = 8; // ticks per loop
const TICK_MS = 1500;
const PROGRESS = [0, 0, 25, 60, 90, 100, 100, 100];

type RowState = "done" | "pending" | "syncing";

// "Reduced motion" is an external (browser) value, so it is read with
// useSyncExternalStore instead of being copied into state from an effect.
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(onChange: () => void) {
    const mq = window.matchMedia(REDUCED_QUERY);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
}
const getReducedMotion = () => window.matchMedia(REDUCED_QUERY).matches;
const getReducedMotionServer = () => false;

function rowState(index: number, t: number): RowState {
    if (index === 0) return "done"; // already synced before the connection dropped
    if (t > index + 1) return "done";
    if (t === index + 1) return "syncing";
    return "pending";
}

export default function OfflineSection() {
    const reduced = useSyncExternalStore(
        subscribeReducedMotion,
        getReducedMotion,
        getReducedMotionServer,
    );
    const [tick, setTick] = useState(0);
    // With reduced motion the demo rests on its final, fully-synced frame.
    const t = reduced ? 5 : tick;
    const queueRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = queueRef.current;
        if (!el || reduced) return;

        let timer: ReturnType<typeof setInterval> | undefined;
        const start = () => {
            if (timer) return;
            setTick(0);
            timer = setInterval(() => setTick((p) => (p + 1) % CYCLE), TICK_MS);
        };
        const stop = () => {
            if (timer) clearInterval(timer);
            timer = undefined;
        };

        // Only run the loop while the queue is on screen.
        const io = new IntersectionObserver(
            ([entry]) => (entry.isIntersecting ? start() : stop()),
            { threshold: 0.5 },
        );
        io.observe(el);
        return () => {
            io.disconnect();
            stop();
        };
    }, [reduced]);

    const phase = t < 2 ? "offline" : t < 5 ? "syncing" : "done";
    const activeStep = t === 0 ? 0 : t === 1 ? 1 : t < 5 ? 2 : 3;

    return (
        <section id="offline" className={s.dark}>
            <div aria-hidden className={s.darkPattern} />
            <div aria-hidden className={`${s.glow} ${s.glowEmerald}`} />
            <div aria-hidden className={`${s.glow} ${s.glowPurple}`} />

            <div className={`${s.container} ${s.darkGrid}`}>
                <div className={s.reveal}>
                    <h2 className={s.h2}>
                        الفاتورة تُحفظ عندك أولاً، ثم تُرفع عندما يعود الإنترنت
                    </h2>
                    <p className={s.darkLead}>
                        لكل فاتورة ودفعة وزبون جديد معرّف فريد، فإذا انقطع الاتصال في منتصف الرفع تُعاد المحاولة دون أن تتكرر الفاتورة. وإذا فشلت فاتورة واحدة لا تتعطل بقية الفواتير، ويجد المدير سببها في شاشة الفواتير الفاشلة.
                    </p>
                    <ol className={s.seq}>
                        {steps.map((step, i) => {
                            const status =
                                i < activeStep ? "done" : i === activeStep ? "active" : "todo";
                            return (
                                <li
                                    key={step.title}
                                    className={`${s.seqItem} ${status === "todo" ? s.seqTodo : ""}`}
                                >
                                    <span
                                        className={`${s.seqNum} ${status === "done"
                                                ? s.seqNumDone
                                                : status === "active"
                                                    ? s.seqNumActive
                                                    : ""
                                            }`}
                                    >
                                        {status === "done" ? <Check size={18} aria-hidden /> : i + 1}
                                    </span>
                                    <div>
                                        <p className={s.seqTitle}>{step.title}</p>
                                        <p className={s.seqBody}>{step.body}</p>
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                </div>

                <div ref={queueRef} className={`${s.queue} ${s.revealPop}`}>
                    <div className={s.queueHead}>
                        <p className={s.queueTitle}>طابور المزامنة</p>
                        <span key={phase} className={`${s.pill} ${phase === "offline" ? s.pillOffline : phase === "syncing" ? s.pillSyncing : s.pillDone}`}>
                            {phase === "offline" ? (
                                <>
                                    <WifiOff size={14} aria-hidden />
                                    غير متصل
                                </>
                            ) : phase === "syncing" ? (
                                <>
                                    <RefreshCw size={14} aria-hidden />
                                    جارٍ المزامنة
                                </>
                            ) : (
                                <>
                                    <Wifi size={14} aria-hidden />
                                    متصل، تمت المزامنة
                                </>
                            )}
                        </span>
                    </div>
                    <div className={s.queueBar}>
                        <div className={s.queueBarFill} style={{ width: `${PROGRESS[t]}%` }} />
                    </div>

                    <ul className={s.queueList} aria-live="polite">
                        {queueRows.map((row, i) => {
                            const state = rowState(i, t);
                            return (
                                <li
                                    key={`${row.title}-${state}`}
                                    className={`${s.queueRow} ${state === "done" && i > 0 ? s.rowFlash : ""}`}
                                >
                                    <div>
                                        <p className={s.queueName}>{row.title}</p>
                                        <p className={s.queueMeta}>{row.meta}</p>
                                    </div>
                                    {state === "done" ? (
                                        <span className={s.stateDone}>
                                            <Check size={16} aria-hidden />
                                            تمت المزامنة
                                        </span>
                                    ) : state === "syncing" ? (
                                        <span className={s.stateSyncing}>
                                            <RefreshCw size={16} aria-hidden />
                                            جارٍ الرفع
                                        </span>
                                    ) : (
                                        <span className={s.statePending}>
                                            <Clock size={16} aria-hidden />
                                            بانتظار الاتصال
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </section>
    );
}