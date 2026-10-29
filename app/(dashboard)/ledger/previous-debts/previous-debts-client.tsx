"use client";

/**
 * app/(dashboard)/ledger/previous-debts/previous-debts-client.tsx
 *
 * T4e v6.1 — fast entry screen for previous (opening) debts. ADMIN only (the
 * server page.tsx guards it), ONLINE only: no Dexie table, no offline queue.
 *
 * One customer per submission. "حفظ وإضافة التالي" clears the form and returns
 * focus to the name field at once; the saving happens in a small in-memory
 * queue, one request at a time, in order, so the merchant keeps typing while
 * the previous row saves. Every row carries its own idempotencyKey and a retry
 * re-sends the SAME row (same key). The session list lives in memory only, and
 * beforeunload warns while any row is queued / saving / failed.
 *
 * Customer mode is DERIVED, never stored: a customer picked from the typeahead
 * means EXISTING, otherwise NEW. (Storing it separately let it go stale after a
 * submit and send an EXISTING request with no customer id.)
 *
 * A mistake is fixed with a CORRECTION row (increase or decrease), never an
 * edit or delete — the history is kept in full.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plus, RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { MAX_ADJUSTMENT_AMOUNT_SYP } from "@/lib/config/ledger";
import { compareMoney, formatMoney, subtractMoney, sumMoney } from "@/lib/utils/money";
import { generateOfflineId } from "@/lib/offline/id";
import { normalizePhone } from "@/lib/utils/phone";
// ASSUMED PATH — T4a's refreshCustomerCache(tenantId). Adjust the import to
// wherever it lives in the repo; it must no-op silently when offline.
import {
    filterSuggestions,
    findDuplicateByName,
    findDuplicateByPhone,
    hasUnsavedEntries,
    markForRetry,
    parseAmountInput,
    sanitizeAmountInput,
    type RowStatus,
} from "@/lib/ledger/previous-debts";
import styles from "./previous-debts.module.css";
import { refreshCustomerCache } from "@/lib/offline";

const DEFAULT_OPENING_REASON = "دين سابق من الدفتر";
const KIND_LABEL = { OPENING_BALANCE: "رصيد سابق", CORRECTION: "تصحيح رصيد" } as const;
const STATUS_LABEL: Record<RowStatus, string> = {
    queued: "بالانتظار",
    saving: "يُحفظ…",
    saved: "محفوظ",
    failed: "فشل",
};
const STATUS_TONE: Record<RowStatus, string> = {
    queued: "text-zinc-500",
    saving: "text-amber-600",
    saved: "text-emerald-600",
    failed: "text-rose-600",
};

type Kind = keyof typeof KIND_LABEL;

interface CustomerOption {
    id: string;
    name: string;
    phone: string | null;
    shopName: string | null;
    balanceSYP: string;
}

interface SessionRow {
    id: string;
    idempotencyKey: string;
    kind: Kind;
    /** Signed: a decreasing CORRECTION is negative. */
    amountSYP: string;
    reason: string;
    customerName: string;
    target:
    | { mode: "EXISTING"; customerId: string }
    | { mode: "NEW"; phone: string | null; shopName: string | null };
    /** Known once the row is saved (a NEW customer's id comes from the server). */
    customerId?: string;
    newBalanceSYP?: string;
    status: RowStatus;
    error?: string;
}

interface Props {
    tenantId: string;
}

function toErrorMessage(err: unknown): string {
    if (err instanceof TypeError) return "تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.";
    return err instanceof Error ? err.message : "فشل الحفظ.";
}

/** "+5,000 ل.س" / "−5,000 ل.س" — the sign comes from the Decimal string. */
function signedMoney(amountSYP: string): string {
    const negative = amountSYP.startsWith("-");
    return `${negative ? "−" : "+"}${formatMoney(negative ? amountSYP.slice(1) : amountSYP, "SYP")}`;
}

export function PreviousDebtsClient({ tenantId }: Props) {
    // ----- entry form (opening balances only; corrections use the dialog) -----
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [shopName, setShopName] = useState("");
    const [amountInput, setAmountInput] = useState("");
    const [reason, setReason] = useState("");
    const [selected, setSelected] = useState<CustomerOption | null>(null);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);

    // ----- data -----
    const [customers, setCustomers] = useState<CustomerOption[]>([]);
    const [customersFailed, setCustomersFailed] = useState(false);
    const [rows, setRows] = useState<SessionRow[]>([]);

    // ----- correction dialog -----
    const [correctionFor, setCorrectionFor] = useState<SessionRow | null>(null);
    const [direction, setDirection] = useState<"decrease" | "increase">("decrease");
    const [corrAmount, setCorrAmount] = useState("");
    const [corrReason, setCorrReason] = useState("");

    // ----- queue -----
    const queueRef = useRef<SessionRow[]>([]);
    const processingRef = useRef(false);
    const needsRefreshRef = useRef(false);

    // ===== customers for the typeahead / duplicate hints =====
    useEffect(() => {
        let cancelled = false;
        fetch("/api/customers")
            .then((res) => res.json())
            .then((data) => {
                if (cancelled) return;
                if (!data?.success) {
                    setCustomersFailed(true);
                    return;
                }
                type ApiCustomer = {
                    id: string;
                    name: string;
                    phone: string | null;
                    shopName: string | null;
                    cachedBalanceDebtSYP: string;
                    isSystemGenerated: boolean;
                };
                setCustomers(
                    (data.customers as ApiCustomer[])
                        // The system cash customer can never receive an adjustment (D8).
                        .filter((c) => !c.isSystemGenerated)
                        .map((c) => ({
                            id: c.id,
                            name: c.name,
                            phone: c.phone ?? null,
                            shopName: c.shopName ?? null,
                            balanceSYP: c.cachedBalanceDebtSYP ?? "0.0000",
                        }))
                );
            })
            .catch(() => {
                if (!cancelled) setCustomersFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // ===== unsaved-work warning =====
    const unsaved = useMemo(() => hasUnsavedEntries(rows), [rows]);
    useEffect(() => {
        if (!unsaved) return;
        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "يوجد مدخلات لم تُحفظ بعد. إذا غادرت الصفحة ستفقدها.";
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, [unsaved]);

    // ===== queue =====
    const updateRow = useCallback((id: string, patch: Partial<SessionRow>) => {
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    }, []);

    /** Keep the typeahead (and its duplicate hints) in step with what was saved. */
    const applySavedCustomer = useCallback(
        (row: SessionRow, customerId: string, customerName: string, balanceSYP: string) => {
            setCustomers((prev) => {
                if (prev.some((c) => c.id === customerId)) {
                    return prev.map((c) => (c.id === customerId ? { ...c, balanceSYP } : c));
                }
                return [
                    ...prev,
                    {
                        id: customerId,
                        name: customerName,
                        phone: row.target.mode === "NEW" ? row.target.phone : null,
                        shopName: row.target.mode === "NEW" ? row.target.shopName : null,
                        balanceSYP,
                    },
                ];
            });
        },
        []
    );

    const sendRow = useCallback(
        async (row: SessionRow) => {
            updateRow(row.id, { status: "saving", error: undefined });
            try {
                const res = await fetch("/api/ledger/adjustments", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        idempotencyKey: row.idempotencyKey,
                        kind: row.kind,
                        amountSYP: row.amountSYP,
                        reason: row.reason,
                        customer:
                            row.target.mode === "EXISTING"
                                ? { mode: "EXISTING", customerId: row.target.customerId }
                                : {
                                    mode: "NEW",
                                    name: row.customerName,
                                    phone: row.target.phone || undefined,
                                    shopName: row.target.shopName || undefined,
                                },
                    }),
                });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data) throw new Error(data?.message || "فشل الحفظ.");

                // The server's answer is the truth: the customer it resolved (a merge
                // may have redirected to the survivor), its name, and the NET balance.
                updateRow(row.id, {
                    status: "saved",
                    customerId: data.customerId,
                    customerName: data.customerName || row.customerName,
                    amountSYP: data.amountSYP,
                    newBalanceSYP: data.newBalanceSYP,
                });
                applySavedCustomer(row, data.customerId, data.customerName || row.customerName, data.newBalanceSYP);
                needsRefreshRef.current = true;
            } catch (err) {
                updateRow(row.id, { status: "failed", error: toErrorMessage(err) });
            }
        },
        [updateRow, applySavedCustomer]
    );

    const processQueue = useCallback(async () => {
        if (processingRef.current) return;
        processingRef.current = true;
        try {
            // The outer loop re-checks the queue after each drain (and after the
            // cache refresh), so a row pushed while we were awaiting is never
            // stranded. processingRef stays true the whole time, so no second
            // loop can start in parallel.
            do {
                while (queueRef.current.length > 0) {
                    const next = queueRef.current.shift()!;
                    await sendRow(next);
                }
                // One cache refresh per drained batch, not one per row. It no-ops offline.
                if (needsRefreshRef.current) {
                    needsRefreshRef.current = false;
                    try {
                        await refreshCustomerCache(tenantId);
                    } catch {
                        // Non-fatal: the cache simply refreshes on its next load.
                    }
                }
            } while (queueRef.current.length > 0);
        } finally {
            processingRef.current = false;
        }
    }, [sendRow, tenantId]);

    const enqueue = useCallback(
        (row: SessionRow) => {
            setRows((prev) => [row, ...prev]);
            queueRef.current.push(row);
            void processQueue();
        },
        [processQueue]
    );

    const retry = useCallback(
        (row: SessionRow) => {
            const again = markForRetry(row); // same idempotencyKey
            updateRow(row.id, { status: again.status, error: undefined });
            queueRef.current.push(again);
            void processQueue();
        },
        [updateRow, processQueue]
    );

    // ===== entry form =====
    const amount = parseAmountInput(amountInput);
    const amountOverLimit = amount !== null && compareMoney(amount, MAX_ADJUSTMENT_AMOUNT_SYP) > 0;
    const phoneInvalid = !selected && phone.trim() !== "" && normalizePhone(phone) === null;
    const nameLen = name.trim().length;
    const nameValid = selected !== null || (nameLen >= 2 && nameLen <= 80);
    const reasonTooLong = reason.trim().length > 300;
    const canSubmit =
        nameValid && amount !== null && !amountOverLimit && !phoneInvalid && !reasonTooLong && shopName.length <= 80;

    const suggestions = useMemo(
        () => (showSuggestions && !selected ? filterSuggestions(name, customers) : []),
        [showSuggestions, selected, name, customers]
    );
    const nameHint = !selected ? findDuplicateByName(name, customers) : null;
    const phoneHintRaw = !selected ? findDuplicateByPhone(phone, customers) : null;
    const phoneHint = phoneHintRaw && phoneHintRaw.id !== nameHint?.id ? phoneHintRaw : null;

    const pick = useCallback((c: CustomerOption) => {
        setSelected(c);
        setName(c.name);
        setPhone("");
        setShopName("");
        setShowSuggestions(false);
    }, []);

    const handleSubmit = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();
            if (!canSubmit || amount === null) return;
            const key = generateOfflineId();
            enqueue({
                id: key,
                idempotencyKey: key,
                kind: "OPENING_BALANCE",
                amountSYP: amount,
                reason: reason.trim() || DEFAULT_OPENING_REASON,
                customerName: selected ? selected.name : name.trim(),
                target: selected
                    ? { mode: "EXISTING", customerId: selected.id }
                    : { mode: "NEW", phone: phone.trim() || null, shopName: shopName.trim() || null },
                status: "queued",
            });
            // Clear and go straight back to the name field for the next customer.
            setName("");
            setPhone("");
            setShopName("");
            setAmountInput("");
            setReason("");
            setSelected(null);
            setShowSuggestions(false);
            nameRef.current?.focus();
        },
        [canSubmit, amount, enqueue, reason, selected, name, phone, shopName]
    );

    // ===== correction dialog =====
    const openCorrection = (row: SessionRow) => {
        setCorrectionFor(row);
        setDirection("decrease");
        setCorrAmount("");
        setCorrReason("");
    };

    const corrParsed = parseAmountInput(corrAmount);
    const corrOverLimit = corrParsed !== null && compareMoney(corrParsed, MAX_ADJUSTMENT_AMOUNT_SYP) > 0;
    const corrReasonLen = corrReason.trim().length;
    const corrValid =
        corrParsed !== null && !corrOverLimit && corrReasonLen >= 3 && corrReasonLen <= 300;

    const submitCorrection = () => {
        if (!correctionFor?.customerId || corrParsed === null || !corrValid) return;
        const key = generateOfflineId();
        enqueue({
            id: key,
            idempotencyKey: key,
            kind: "CORRECTION",
            amountSYP: direction === "decrease" ? subtractMoney("0", corrParsed) : corrParsed,
            reason: corrReason.trim(),
            customerName: correctionFor.customerName,
            target: { mode: "EXISTING", customerId: correctionFor.customerId },
            status: "queued",
        });
        setCorrectionFor(null);
        nameRef.current?.focus();
    };

    // ===== session total (saved rows only; corrections are signed) =====
    const sessionTotal = useMemo(
        () => sumMoney(rows.filter((r) => r.status === "saved").map((r) => r.amountSYP)),
        [rows]
    );

    return (
        <div className={styles.root} dir="rtl" lang="ar">
            <header className={styles.header}>
                <h1>إضافة ديون سابقة</h1>
                <p>
                    سجّل ما كان على الزبون من دين قبل استخدام النظام. كل حفظ يضيف سطراً جديداً في سجل الزبون
                    ولا يُعدَّل ولا يُحذف.
                </p>
            </header>

            <main className={styles.content}>
                {customersFailed && (
                    <div role="status" className={styles.notice}>
                        تعذّر تحميل قائمة الزبائن، لذلك لن تظهر اقتراحات الأسماء ولا تنبيهات التكرار. يمكنك
                        المتابعة، لكن تأكد أن الزبون غير مسجّل سابقاً.
                    </div>
                )}

                <section className={styles.formCard}>
                    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
                        {/* Name + typeahead */}
                        <div className="relative space-y-1.5">
                            <Label htmlFor="pd-name">الاسم</Label>
                            <Input
                                id="pd-name"
                                ref={nameRef}
                                autoFocus
                                autoComplete="off"
                                value={name}
                                onChange={(e) => {
                                    setName(e.target.value);
                                    setSelected(null); // typing again drops the picked customer
                                    setShowSuggestions(true);
                                }}
                                onFocus={() => setShowSuggestions(true)}
                                onBlur={() => setShowSuggestions(false)}
                                placeholder="اكتب اسم الزبون…"
                                className="h-11 text-sm"
                            />
                            {suggestions.length > 0 && (
                                <ul className={styles.suggestions} role="listbox" aria-label="زبائن مطابقون">
                                    {suggestions.map((c) => (
                                        <li key={c.id} role="option" aria-selected={false}>
                                            <button
                                                type="button"
                                                className={styles.suggestionItem}
                                                // mousedown (not click) so the input's blur does not close the list first
                                                onMouseDown={(e) => {
                                                    e.preventDefault();
                                                    pick(c);
                                                }}
                                            >
                                                <span className="truncate font-semibold">{c.name}</span>
                                                <span className="shrink-0 text-xs text-zinc-500">
                                                    {formatMoney(c.balanceSYP, "SYP")}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        {selected ? (
                            <div className={styles.selectedCard}>
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-bold text-emerald-900">زبون موجود: {selected.name}</p>
                                    <p className="text-xs text-emerald-800">
                                        رصيده الحالي: <span className="font-bold tabular-nums">{formatMoney(selected.balanceSYP, "SYP")}</span>
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setSelected(null)}
                                    className="h-8 shrink-0 rounded-lg text-xs"
                                >
                                    تغيير
                                </Button>
                            </div>
                        ) : (
                            <>
                                {nameHint && (
                                    <div className={styles.hint}>
                                        <span className="min-w-0 flex-1">
                                            في زبون بنفس الاسم: {nameHint.name} — رصيده الحالي: {formatMoney(nameHint.balanceSYP, "SYP")}
                                        </span>
                                        <Button type="button" size="sm" variant="outline" onClick={() => pick(nameHint)} className="h-8 shrink-0 rounded-lg text-xs">
                                            استخدمه
                                        </Button>
                                    </div>
                                )}

                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                    <div className="space-y-1.5">
                                        <Label htmlFor="pd-phone">الهاتف (اختياري)</Label>
                                        <Input
                                            id="pd-phone"
                                            type="tel"
                                            inputMode="tel"
                                            value={phone}
                                            onChange={(e) => setPhone(e.target.value)}
                                            placeholder="مثال: 0944123456"
                                            className="h-11 text-sm"
                                        />
                                        {phoneInvalid && <p className="text-[11px] text-red-600">رقم الهاتف غير صالح.</p>}
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label htmlFor="pd-shop">اسم المحل (اختياري)</Label>
                                        <Input
                                            id="pd-shop"
                                            value={shopName}
                                            onChange={(e) => setShopName(e.target.value)}
                                            placeholder="مثال: سوبرماركت الشروق"
                                            className="h-11 text-sm"
                                        />
                                    </div>
                                </div>

                                {phoneHint && (
                                    <div className={styles.hint}>
                                        <span className="min-w-0 flex-1">
                                            في زبون مسجّل بنفس الرقم: {phoneHint.name} — رصيده الحالي: {formatMoney(phoneHint.balanceSYP, "SYP")}
                                        </span>
                                        <Button type="button" size="sm" variant="outline" onClick={() => pick(phoneHint)} className="h-8 shrink-0 rounded-lg text-xs">
                                            استخدمه
                                        </Button>
                                    </div>
                                )}
                            </>
                        )}

                        {/* Amount */}
                        <div className="space-y-1.5">
                            <Label htmlFor="pd-amount">المبلغ بالليرة</Label>
                            <Input
                                id="pd-amount"
                                type="text"
                                inputMode="numeric"
                                autoComplete="off"
                                value={amountInput}
                                onChange={(e) => setAmountInput(sanitizeAmountInput(e.target.value))}
                                placeholder="0"
                                className="h-14 text-2xl font-bold tabular-nums tracking-tight text-zinc-800"
                            />
                            {/* The typed amount, large and grouped, so a wrong zero is visible. */}
                            <p className={cn(styles.amountPreview, amount === null && "opacity-30")} aria-live="polite">
                                {formatMoney(amount ?? "0", "SYP")}
                            </p>
                            {amountInput && amount === null && (
                                <p className="text-[11px] text-red-600">أدخل مبلغاً أكبر من صفر.</p>
                            )}
                            {amountOverLimit && (
                                <p className="text-[11px] text-red-600">
                                    المبلغ أكبر من الحد المسموح ({formatMoney(MAX_ADJUSTMENT_AMOUNT_SYP, "SYP")}).
                                </p>
                            )}
                        </div>

                        {/* Note */}
                        <div className="space-y-1.5">
                            <Label htmlFor="pd-reason">ملاحظة (اختياري)</Label>
                            <Input
                                id="pd-reason"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder={DEFAULT_OPENING_REASON}
                                className="h-11 text-sm"
                            />
                            {reasonTooLong && <p className="text-[11px] text-red-600">الملاحظة يجب ألا تتجاوز 300 حرف.</p>}
                        </div>

                        <Button
                            type="submit"
                            disabled={!canSubmit}
                            className="h-12 w-full gap-2 rounded-xl bg-emerald-600 text-sm font-bold text-white shadow-sm shadow-emerald-600/25 transition-all hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Save className="size-4" aria-hidden />
                            حفظ وإضافة التالي
                        </Button>
                    </form>
                </section>

                {/* Session list */}
                <section className={styles.sessionList}>
                    <div className={styles.sessionHeader}>
                        <h2 className={styles.sessionTitle}>مدخلات هذه الجلسة ({rows.length})</h2>
                        <span className={styles.sessionTotal}>
                            <span className="text-xs font-semibold text-zinc-500">إجمالي المحفوظ: </span>
                            {formatMoney(sessionTotal, "SYP")}
                        </span>
                    </div>

                    {rows.length === 0 ? (
                        <p className={styles.emptyState}>لا توجد مدخلات بعد. أضف أول دين من النموذج أعلاه.</p>
                    ) : (
                        <ul>
                            {rows.map((row) => (
                                <li
                                    key={row.id}
                                    className={cn(
                                        styles.entryRow,
                                        row.status === "saving" && styles.saving,
                                        row.status === "failed" && styles.failed
                                    )}
                                >
                                    <div className={styles.entryInfo}>
                                        <p className={styles.entryName}>{row.customerName}</p>
                                        <p className={styles.entryMeta}>
                                            {KIND_LABEL[row.kind]} ·{" "}
                                            <span dir="ltr" className="font-bold tabular-nums [unicode-bidi:isolate]">
                                                {signedMoney(row.amountSYP)}
                                            </span>
                                        </p>
                                        {row.status === "saved" && row.newBalanceSYP !== undefined && (
                                            <p className={styles.entryMeta}>
                                                رصيده الآن: <span className="font-semibold tabular-nums">{formatMoney(row.newBalanceSYP, "SYP")}</span>
                                            </p>
                                        )}
                                        {row.status === "failed" && row.error && (
                                            <p className="mt-0.5 flex items-start gap-1 text-xs text-red-600">
                                                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                                                <span>{row.error}</span>
                                            </p>
                                        )}
                                    </div>

                                    <div className={styles.entryActions}>
                                        <span className={cn("text-xs font-bold", STATUS_TONE[row.status])}>
                                            {row.status === "saving" && <Loader2 className="me-1 inline size-3 animate-spin" aria-hidden />}
                                            {STATUS_LABEL[row.status]}
                                        </span>
                                        {row.status === "failed" && (
                                            <button type="button" onClick={() => retry(row)} className={styles.retryButton}>
                                                <RotateCcw className="me-1 inline size-3" aria-hidden />
                                                إعادة المحاولة
                                            </button>
                                        )}
                                        {row.status === "saved" && row.customerId && (
                                            <button type="button" onClick={() => openCorrection(row)} className={styles.correctButton}>
                                                <Plus className="me-1 inline size-3" aria-hidden />
                                                تصحيح
                                            </button>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </main>

            {/* Correction dialog */}
            <Dialog open={correctionFor !== null} onOpenChange={(open) => !open && setCorrectionFor(null)}>
                <DialogContent dir="rtl" className="w-[calc(100%-1.5rem)] rounded-2xl p-0 text-start sm:max-w-md">
                    <DialogHeader className="border-b border-zinc-100 px-4 pb-3 pt-4 pe-14 text-start">
                        <DialogTitle className="text-base font-extrabold">تصحيح رصيد {correctionFor?.customerName}</DialogTitle>
                        <DialogDescription className="text-xs leading-relaxed text-zinc-500">
                            نحافظ على سجل الحسابات كاملاً — التصحيح يُضاف كسطر جديد، ولا يُعدَّل السطر الأصلي.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3 px-4 py-3">
                        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="اتجاه التصحيح">
                            {(["decrease", "increase"] as const).map((d) => (
                                <button
                                    key={d}
                                    type="button"
                                    role="radio"
                                    aria-checked={direction === d}
                                    onClick={() => setDirection(d)}
                                    className={cn(
                                        "h-11 rounded-xl border text-sm font-bold transition-colors",
                                        direction === d
                                            ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                                            : "border-zinc-200 bg-white text-zinc-600"
                                    )}
                                >
                                    {d === "decrease" ? "إنقاص الدين" : "زيادة الدين"}
                                </button>
                            ))}
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="pd-corr-amount">المبلغ بالليرة</Label>
                            <Input
                                id="pd-corr-amount"
                                type="text"
                                inputMode="numeric"
                                autoComplete="off"
                                value={corrAmount}
                                onChange={(e) => setCorrAmount(sanitizeAmountInput(e.target.value))}
                                className="h-12 text-xl font-bold tabular-nums"
                            />
                            <p className={cn(styles.amountPreview, corrParsed === null && "opacity-30")}>
                                {formatMoney(corrParsed ?? "0", "SYP")}
                            </p>
                            {corrOverLimit && <p className="text-[11px] text-red-600">المبلغ أكبر من الحد المسموح.</p>}
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="pd-corr-reason">سبب التصحيح (مطلوب)</Label>
                            <Input
                                id="pd-corr-reason"
                                value={corrReason}
                                onChange={(e) => setCorrReason(e.target.value)}
                                placeholder="مثال: كتبت صفراً زائداً"
                                className="h-11 text-sm"
                            />
                            {corrReason.trim() !== "" && corrReasonLen < 3 && (
                                <p className="text-[11px] text-red-600">اكتب سبباً لا يقل عن 3 أحرف.</p>
                            )}
                            {corrReasonLen > 300 && <p className="text-[11px] text-red-600">السبب يجب ألا يتجاوز 300 حرف.</p>}
                        </div>
                    </div>

                    <DialogFooter className="gap-2 border-t border-zinc-100 px-4 py-3">
                        <Button type="button" variant="outline" onClick={() => setCorrectionFor(null)} className="h-11 rounded-xl text-xs font-bold">
                            إلغاء
                        </Button>
                        <Button
                            type="button"
                            disabled={!corrValid}
                            onClick={submitCorrection}
                            className="h-11 rounded-xl bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                            حفظ التصحيح
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}