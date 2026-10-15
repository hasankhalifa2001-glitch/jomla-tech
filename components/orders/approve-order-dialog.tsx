/**
 * components/orders/approve-order-dialog.tsx
 *
 * T5c Phase 5 — ADMIN-only approval dialog (JSX). Form state lives in
 * approve-form.ts; fetching lives in orders-client.tsx. dir=rtl,
 * logical properties, 375px-safe. No trust labels.
 *
 * Layout: fixed header · scrollable body · sticky footer (total + actions).
 * Motion: light entrance stagger, sliding payment selector, smooth
 * expand/collapse for conditional fields. All motion respects
 * prefers-reduced-motion.
 */

"use client";

import type { CSSProperties, ReactNode } from "react";
import {
    AlertTriangle,
    Banknote,
    Check,
    CheckCircle2,
    Coins,
    Loader2,
    Minus,
    Package,
    Plus,
    UserPlus,
    Wallet,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { formatMoney } from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import { APPROVE_PAYMENT_METHODS, type ApproveForm } from "./approve-form";
import type { ApproveOrderPayload, InsufficientStockDetail, OrderDetailView } from "./types";

/* ───────────────────────── motion helpers ───────────────────────── */

const RISE = "animate-in fade-in slide-in-from-bottom-2 duration-300 motion-reduce:animate-none";
const rise = (i: number): CSSProperties => ({ animationDelay: `${i * 70}ms`, animationFillMode: "both" });

/** Smooth height + opacity expand. Closed content is invisible → not focusable. */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
    return (
        <div
            aria-hidden={!open}
            className={cn(
                "grid transition-[grid-template-rows,opacity,visibility] duration-300 ease-out motion-reduce:transition-none",
                open ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0",
            )}
        >
            <div className="-m-1 min-h-0 overflow-hidden p-1">{children}</div>
        </div>
    );
}

/* ───────────────────────── dialog shell ───────────────────────── */

export function ApproveOrderDialog(props: {
    open: boolean;
    order: OrderDetailView | null;
    form: ApproveForm;
    busy: boolean;
    serverError: string | null;
    insufficient: InsufficientStockDetail[];
    onOpenChange: (open: boolean) => void;
    onConfirm: (payload: ApproveOrderPayload) => void;
}) {
    const { open, order, form, busy, serverError, insufficient, onOpenChange, onConfirm } = props;
    const shortById = new Map(insufficient.map((s) => [s.itemId, s]));
    const message = form.localError ?? serverError;
    const totalText = form.totalSYP !== null ? `${formatMoney(form.totalSYP, "SYP")} ل.س` : "—";

    return (
        <Dialog open={open} onOpenChange={(n) => { if (!busy) onOpenChange(n); }}>
            <DialogContent
                dir="rtl"
                className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden rounded-2xl border-zinc-200 p-0 sm:max-w-2xl"
            >
                <DialogHeader className="gap-0 border-b border-zinc-100 bg-linear-to-b from-emerald-50/70 to-white px-4 pb-3 pt-4 pe-14 text-start sm:px-6">
                    <div className="flex items-center gap-3">
                        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/25">
                            <CheckCircle2 className="size-5" aria-hidden />
                        </span>
                        <div className="min-w-0">
                            <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-extrabold leading-tight text-zinc-900">
                                قبول الطلب
                                {order && (
                                    <span dir="ltr" className="rounded-md bg-zinc-100 px-2 py-0.5 text-sm font-bold tabular-nums text-zinc-600">
                                        #{order.orderRef}
                                    </span>
                                )}
                            </DialogTitle>
                            <DialogDescription className="mt-1 text-xs leading-relaxed text-zinc-500 sm:text-sm">
                                عدّل الكميات، اختر الزبون، ثم حدد الدفعة. السعر ثابت من لحظة الطلب.
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
                    {order && <ApproveBody order={order} form={form} shortById={shortById} message={message} />}
                </div>

                <div className="border-t border-zinc-100 bg-white px-4 py-3 sm:px-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-baseline justify-between gap-3 sm:justify-start">
                            <span className="text-sm font-bold text-zinc-500">الإجمالي</span>
                            <span
                                key={totalText}
                                dir="ltr"
                                className={cn(
                                    "text-xl font-extrabold tabular-nums animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none",
                                    form.totalSYP !== null ? "text-emerald-700" : "text-zinc-400",
                                )}
                            >
                                {totalText}
                            </span>
                        </div>
                        <div className="flex gap-2">
                            <Button
                                className="h-11 flex-1 rounded-xl bg-emerald-600 px-6 font-extrabold text-white shadow-sm shadow-emerald-600/25 transition-all hover:bg-emerald-700 hover:shadow-md active:scale-[0.98] sm:flex-none"
                                disabled={busy || !order || form.totalSYP === null}
                                onClick={() => { const p = form.buildPayload(); if (p) onConfirm(p); }}
                            >
                                {busy ? (
                                    <><Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ القبول…</>
                                ) : (
                                    <>
                                        <CheckCircle2 className="size-4" aria-hidden />
                                        <span className="sm:hidden">تأكيد وإنشاء الفاتورة</span>
                                        <span className="hidden sm:inline">تأكيد القبول وإنشاء الفاتورة</span>
                                    </>
                                )}
                            </Button>
                            <Button
                                variant="outline"
                                disabled={busy}
                                className="h-11 rounded-xl px-5 font-bold transition-transform active:scale-[0.98]"
                                onClick={() => onOpenChange(false)}
                            >
                                إلغاء
                            </Button>
                        </div>
                    </div>
                </div>
                <p className="sr-only"><Link href="/dashboard/sales-log">سجل المبيعات</Link></p>
            </DialogContent>
        </Dialog>
    );
}

/* ───────────────────────── body ───────────────────────── */

function ApproveBody({ order, form, shortById, message }: {
    order: OrderDetailView;
    form: ApproveForm;
    shortById: Map<string, InsufficientStockDetail>;
    message: string | null;
}) {
    const n = order.lines.length;
    return (
        <div className="space-y-5">
            <section className="space-y-2.5">
                <SectionTitle
                    icon={<Package className="size-4" aria-hidden />}
                    aside={<span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold tabular-nums text-zinc-600">{n}</span>}
                >
                    الأصناف
                </SectionTitle>
                <div className="space-y-2.5">
                    {order.lines.map((l, i) => (
                        <LineCard
                            key={l.id}
                            index={i}
                            line={l}
                            form={form}
                            short={shortById.get(l.id)}
                            err={form.qtyErrors[l.id] ?? null}
                        />
                    ))}
                </div>
            </section>
            <ApproveCustomer order={order} form={form} index={n} />
            <ApprovePayment form={form} index={n + 1} />
            <ApproveNotices form={form} shortCount={shortById.size} message={message} />
        </div>
    );
}

function SectionTitle({ icon, children, aside }: { icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg bg-emerald-50 text-emerald-700">{icon}</span>
                <h3 className="text-sm font-extrabold text-zinc-900">{children}</h3>
            </div>
            {aside}
        </div>
    );
}

/* ───────────────────────── line item ───────────────────────── */

function LineCard({ line: l, form, short, err, index }: {
    line: OrderDetailView["lines"][number];
    form: ApproveForm;
    short: InsufficientStockDetail | undefined;
    err: string | null;
    index: number;
}) {
    const warn = Boolean(err || short);
    const inputId = `qty-${l.id}`;
    return (
        <div
            style={rise(index + 1)}
            className={cn(
                RISE,
                "rounded-2xl border p-3 transition-colors duration-300 sm:p-4",
                warn ? "border-amber-300 bg-amber-50/50" : "border-zinc-200 bg-white",
            )}
        >
            <div className="wrap-break-word font-extrabold leading-snug text-zinc-900">{l.productName}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-bold text-zinc-600">{l.unitName}</span>
                <span className="font-extrabold text-emerald-700">
                    {l.pricingCurrencySnapshot === "USD"
                        ? <span dir="ltr" className="tabular-nums">${formatMoney(l.priceWholesaleSnapshot, "USD")}</span>
                        : <span dir="ltr" className="tabular-nums">{formatMoney(l.priceWholesaleSnapshot, "SYP")} ل.س</span>}
                </span>
            </div>

            <div className="mt-3 grid grid-cols-[1fr_1fr_1.7fr] gap-2">
                <Stat label="المطلوبة" value={l.quantity} />
                <Stat label="المتاح" value={l.availableInUnit ?? "—"} warn={Boolean(short)} />
                <div>
                    <Label htmlFor={inputId} className="mb-1 block text-[11px] font-bold text-zinc-500">المعتمدة</Label>
                    <QtyStepper
                        id={inputId}
                        value={form.quantities[l.id] ?? ""}
                        invalid={warn}
                        onChange={(v) => form.setQty(l.id, v)}
                    />
                </div>
            </div>

            {warn && (
                <p
                    key={err ?? "short"}
                    aria-live="polite"
                    className="mt-2.5 flex items-start gap-1.5 text-xs font-semibold text-amber-700 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none"
                >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {err ?? `المتاح ${short?.available ?? ""} ${short?.unitName ?? ""} فقط — خفّض الكمية وأعد المحاولة.`}
                </p>
            )}
        </div>
    );
}

function Stat({ label, value, warn }: { label: string; value: ReactNode; warn?: boolean }) {
    return (
        <div>
            <div className="mb-1 text-[11px] font-bold text-zinc-500">{label}</div>
            <div
                dir="ltr"
                className={cn(
                    "grid h-11 place-items-center rounded-xl text-base font-extrabold tabular-nums transition-colors duration-300",
                    warn ? "bg-amber-100 text-amber-800" : "bg-zinc-50 text-zinc-800",
                )}
            >
                {value}
            </div>
        </div>
    );
}

function QtyStepper({ id, value, invalid, onChange }: {
    id: string;
    value: string;
    invalid: boolean;
    onChange: (v: string) => void;
}) {
    const bump = (d: number) => {
        const cur = Number(value.replace(",", "."));
        const base = Number.isFinite(cur) ? cur : 0;
        onChange(String(Math.max(0, Math.round((base + d) * 1000) / 1000)));
    };
    const btn = "grid w-9 shrink-0 place-items-center text-zinc-500 transition-all hover:bg-emerald-50 hover:text-emerald-700 active:scale-90";
    return (
        <div
            dir="ltr"
            className={cn(
                "flex h-11 items-stretch overflow-hidden rounded-xl border bg-white transition-all duration-200 focus-within:ring-2",
                invalid
                    ? "border-amber-400 focus-within:ring-amber-400/30"
                    : "border-zinc-200 focus-within:border-emerald-600 focus-within:ring-emerald-500/25",
            )}
        >
            <button type="button" className={btn} onClick={() => bump(-1)} aria-label="إنقاص الكمية">
                <Minus className="size-4" aria-hidden />
            </button>
            <input
                id={id}
                inputMode="decimal"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                aria-invalid={invalid || undefined}
                className="w-full min-w-0 bg-transparent text-center text-base font-extrabold tabular-nums text-zinc-900 outline-none"
            />
            <button type="button" className={btn} onClick={() => bump(1)} aria-label="زيادة الكمية">
                <Plus className="size-4" aria-hidden />
            </button>
        </div>
    );
}

/* ───────────────────────── customer ───────────────────────── */

function ApproveCustomer({ order, form, index }: { order: OrderDetailView; form: ApproveForm; index: number }) {
    const suggested = order.matchedCustomer ?? order.candidates[0] ?? null;
    const isNew = !form.customer || form.customer.kind === "NEW";
    const isExisting = form.customer?.kind === "EXISTING";
    return (
        <section style={rise(index + 1)} className={cn(RISE, "space-y-3 rounded-2xl border border-zinc-200 bg-white p-3 sm:p-4")}>
            <SectionTitle icon={<UserPlus className="size-4" aria-hidden />}>الزبون</SectionTitle>
            <div className="grid gap-2 sm:grid-cols-2">
                {suggested && (
                    <ChoiceCard
                        selected={isExisting}
                        onClick={() => form.setCustomer({ kind: "EXISTING", customerId: suggested.id })}
                        icon={<span aria-hidden>{suggested.name.trim().charAt(0).toUpperCase()}</span>}
                        title={suggested.name}
                        subtitle="الزبون المقترح"
                    />
                )}
                <ChoiceCard
                    selected={isNew}
                    onClick={() => form.setCustomer({ kind: "NEW", name: form.newName, phone: form.newPhone, shopName: form.newShop })}
                    icon={<Plus className="size-4" aria-hidden />}
                    title="إنشاء زبون جديد"
                    subtitle="أدخل بياناته أدناه"
                />
            </div>
            <Collapse open={isNew}>
                <div className="grid gap-3 pt-1 sm:grid-cols-2">
                    <div>
                        <Label className="mb-1 block text-xs font-bold text-zinc-600">الاسم</Label>
                        <Input className="h-11 rounded-xl" value={form.newName} onChange={(e) => form.setNewName(e.target.value)} maxLength={80} />
                    </div>
                    <div>
                        <Label className="mb-1 block text-xs font-bold text-zinc-600">الهاتف</Label>
                        <Input dir="ltr" inputMode="tel" className="h-11 rounded-xl tabular-nums" value={form.newPhone} onChange={(e) => form.setNewPhone(e.target.value)} />
                    </div>
                    <div className="sm:col-span-2">
                        <Label className="mb-1 block text-xs font-bold text-zinc-600">المتجر (اختياري)</Label>
                        <Input className="h-11 rounded-xl" value={form.newShop} onChange={(e) => form.setNewShop(e.target.value)} maxLength={120} />
                    </div>
                </div>
            </Collapse>
        </section>
    );
}

function ChoiceCard({ selected, onClick, icon, title, subtitle }: {
    selected: boolean;
    onClick: () => void;
    icon: ReactNode;
    title: string;
    subtitle: string;
}) {
    return (
        <button
            type="button"
            aria-pressed={selected}
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-3 rounded-xl border p-3 text-start transition-all duration-200 active:scale-[0.98]",
                selected
                    ? "border-emerald-600 bg-emerald-50/70 shadow-sm ring-1 ring-emerald-600/20"
                    : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50",
            )}
        >
            <span
                className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-full text-sm font-extrabold transition-colors duration-200",
                    selected ? "bg-emerald-600 text-white" : "bg-zinc-100 text-zinc-500",
                )}
            >
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-sm font-extrabold text-zinc-900">{title}</span>
                <span className="block text-xs text-zinc-500">{subtitle}</span>
            </span>
            <span
                className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border transition-all duration-200",
                    selected ? "scale-100 border-emerald-600 bg-emerald-600 text-white" : "scale-90 border-zinc-300 text-transparent",
                )}
            >
                <Check className="size-3" strokeWidth={3} aria-hidden />
            </span>
        </button>
    );
}

/* ───────────────────────── payment ───────────────────────── */

const PAY_MODES = [
    { m: "FULL_CREDIT", label: "على الحساب بالكامل", Icon: Wallet },
    { m: "FULL_CASH", label: "نقدي بالكامل", Icon: Banknote },
    { m: "PARTIAL", label: "دفع جزئي", Icon: Coins },
] as const;

function ApprovePayment({ form, index }: { form: ApproveForm; index: number }) {
    const idx = Math.max(0, PAY_MODES.findIndex((p) => p.m === form.payMode));
    const cashLike = form.payMode === "FULL_CASH" || form.payMode === "PARTIAL";
    return (
        <section style={rise(index + 1)} className={cn(RISE, "space-y-3 rounded-2xl border border-zinc-200 bg-white p-3 sm:p-4")}>
            <SectionTitle icon={<Wallet className="size-4" aria-hidden />}>الدفعة</SectionTitle>

            {/* segmented control with a sliding indicator */}
            <div role="group" aria-label="طريقة احتساب الدفعة" className="relative grid grid-cols-3 rounded-2xl bg-zinc-100 p-1">
                <span
                    aria-hidden
                    className="absolute inset-y-1 rounded-xl bg-emerald-600 shadow-sm shadow-emerald-600/30 transition-[inset-inline-start] duration-300 ease-out motion-reduce:transition-none"
                    style={{
                        width: "calc((100% - 0.5rem) / 3)",
                        insetInlineStart: `calc(0.25rem + ${idx} * (100% - 0.5rem) / 3)`,
                    }}
                />
                {PAY_MODES.map(({ m, label, Icon }) => {
                    const active = form.payMode === m;
                    return (
                        <button
                            key={m}
                            type="button"
                            aria-pressed={active}
                            onClick={() => form.setPayMode(m)}
                            className={cn(
                                "relative z-10 flex h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-extrabold leading-tight transition-colors duration-300 active:scale-[0.97] sm:text-xs",
                                active ? "text-white" : "text-zinc-600 hover:text-zinc-900",
                            )}
                        >
                            <Icon className="size-4" aria-hidden />
                            <span className="text-center">{label}</span>
                        </button>
                    );
                })}
            </div>

            <Collapse open={form.payMode === "FULL_CREDIT"}>
                <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                    <CheckCircle2 className="size-3.5" aria-hidden /> الخيار الافتراضي
                </p>
            </Collapse>

            <Collapse open={cashLike}>
                <div className="grid gap-3 pt-1 sm:grid-cols-2">
                    {form.payMode === "PARTIAL" && (
                        <div className="animate-in fade-in duration-200 motion-reduce:animate-none">
                            <Label className="mb-1 block text-xs font-bold text-zinc-600">المبلغ المدفوع (ل.س)</Label>
                            <Input dir="ltr" inputMode="decimal" className="h-11 rounded-xl tabular-nums" value={form.paidInput} onChange={(e) => form.setPaidInput(e.target.value)} />
                        </div>
                    )}
                    <div>
                        <Label className="mb-1 block text-xs font-bold text-zinc-600">طريقة الدفع</Label>
                        <select
                            className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold outline-none transition-all focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/25"
                            value={form.payMethod}
                            onChange={(e) => form.setPayMethod(e.target.value)}
                        >
                            {APPROVE_PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </select>
                    </div>
                </div>
            </Collapse>
        </section>
    );
}

/* ───────────────────────── notices ───────────────────────── */

function Notice({ tone, children }: { tone: "warn" | "error"; children: ReactNode }) {
    return (
        <div
            aria-live="polite"
            className={cn(
                "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none",
                tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-700",
            )}
        >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{children}</span>
        </div>
    );
}

function ApproveNotices({ form, shortCount, message }: { form: ApproveForm; shortCount: number; message: string | null }) {
    const usdNoRate = form.totalSYP === null && form.hasUsdWithoutRate;
    const cantCompute = form.totalSYP === null && !form.hasUsdWithoutRate;
    if (!usdNoRate && !cantCompute && shortCount === 0 && !message) return null;
    return (
        <div className="space-y-2">
            {usdNoRate && <Notice tone="warn">يوجد صنف مسعّر بالدولار ولا يوجد سعر صرف — حدّد سعر الصرف أولاً.</Notice>}
            {cantCompute && <Notice tone="warn">تعذّر حساب الإجمالي — راجع الكميات.</Notice>}
            {shortCount > 0 && (
                <Notice tone="warn">المخزون لا يكفي لبعض البنود — خفّض الكمية وأعد المحاولة دون فقدان باقي النموذج.</Notice>
            )}
            {message && <Notice key={message} tone="error">{message}</Notice>}
        </div>
    );
}