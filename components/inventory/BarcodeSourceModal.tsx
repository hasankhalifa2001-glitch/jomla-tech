"use client";

/**
 * BarcodeSourceModal — the mandatory GS1/INTERNAL confirmation gate.
 *
 * SPEC (T3a §5, Master Technical Specification v3.9):
 *   "the first time a barcode is attached to a unit (via @zxing/library
 *   scan or manual entry), and only at that moment, a mandatory modal
 *   appears with two mutually exclusive radio options, no pre-selected
 *   default... The modal's Save button is disabled until one option is
 *   chosen; barcodeSource stays null if the modal is dismissed, and in
 *   that case the barcode value itself is also not saved... Changing an
 *   existing unit's barcode... reopens the same modal from scratch; the
 *   old barcodeSource is never carried over onto a new value."
 *
 * [v4.5 — BATCHED: N barcodes in ONE modal]
 * A product create/edit session can now add MORE THAN ONE barcode at once
 * (several typed values, or a delimited paste). The spec's rule is unchanged
 * in substance and is simply applied PER BARCODE instead of once:
 *   * one radio group PER candidate barcode, all unselected on mount (no
 *     pre-selection, ever — `chosen` starts empty and is only ever written
 *     by an explicit human click),
 *   * Save stays DISABLED until EVERY candidate has an explicit choice,
 *   * an "apply to all" action sets every row to the same value in one
 *     click — still a deliberate human click, never a default,
 *   * dismissal discards ALL candidates in that action (spec: "the barcode
 *     value itself is also not saved"), and a later action's modal is
 *     mounted fresh via the parent's `key`, so a previously-set source can
 *     never carry over onto a new value.
 *
 * [UX — accidental dismissal] Once the merchant has made progress (at least
 * one explicit choice, or more than one barcode in play), clicking outside the
 * dialog or pressing Escape no longer discards everything: only the explicit
 * cancel button does. A single untouched barcode can still be dismissed any
 * way, exactly as before.
 *
 * [FIX — late catalog result vs. an explicit choice] The shared-catalog match
 * for a barcode arrives one network round-trip AFTER the modal opens. If the
 * merchant had already explicitly chosen INTERNAL for that row by then, the
 * row used to flip to the simplified "confirmed GS1" view while the stored
 * choice stayed INTERNAL — Save would then submit something the screen no
 * longer showed. A row the merchant has explicitly classified INTERNAL now
 * stays in the full manual view (with the existing warning) regardless of
 * when the catalog answer lands.
 *
 * This component is a pure, stateless-with-respect-to-persistence
 * confirmation gate. It does NOT decide when to open (the parent decides: on
 * Enter / the Add button / a scan / a delimited paste) and it does NOT infer a
 * source from a barcode's shape. No function here — or anywhere else in this
 * codebase — may guess GS1 vs INTERNAL from digit length or a known prefix
 * pattern; see the BarcodeSource enum comment in schema.prisma for why that is
 * a standing, permanent prohibition, not a placeholder for later.
 */

import { useMemo, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Barcode, Factory, PenLine, CheckCircle2, ShieldQuestion, Layers } from "lucide-react";
import m from "./modals.module.css";

export type BarcodeSourceChoice = "GS1" | "INTERNAL";

/** One barcode awaiting classification in this session. */
export interface BarcodeSourceCandidate {
    barcode: string;
    /**
     * Present ONLY when this exact barcode value was just found in the
     * platform-wide shared catalog (ProductCatalogEntry). This is
     * fundamentally different information from "inferring GS1 from the
     * barcode's digit pattern," which remains permanently forbidden (see the
     * BarcodeSource enum note in schema.prisma). A catalog barcode row exists
     * only because some OTHER merchant already explicitly classified this exact
     * barcode as GS1 (the catalog write path only ever records barcodes
     * classified GS1 — see lib/data/products.ts's
     * resolveSharedCatalogForBarcode()). A match here is therefore a structural
     * fact about the platform's own data, not an inference about the barcode's
     * shape.
     *
     * Even so, the modal NEVER auto-assigns GS1: a matched row still needs its
     * own explicit human click, and an escape hatch is offered for the rare
     * case of a genuine barcode collision (the same physical number reused by
     * mistake across two unrelated products), which falls back to the full
     * manual choice.
     */
    catalogMatch?: { name: string } | null;
}

/** One confirmed classification, returned in the SAME ORDER as the candidates. */
export interface BarcodeSourceSelection {
    barcode: string;
    barcodeSource: BarcodeSourceChoice;
}

interface BarcodeSourceModalProps {
    open: boolean;
    /** Every barcode awaiting classification in this one session. */
    candidates: BarcodeSourceCandidate[];
    /**
     * Fired only when the merchant has explicitly resolved EVERY candidate and
     * presses Save. Never fired automatically, never fired with a
     * partially-resolved or guessed set.
     */
    onConfirm: (selections: BarcodeSourceSelection[]) => void;
    /**
     * Fired when the modal is closed WITHOUT a complete confirmed set — the
     * "X" button, clicking outside (only while untouched), pressing Escape
     * (only while untouched), or the explicit cancel button. Per spec, the
     * caller must treat this as "these barcode values themselves are also not
     * saved," not merely "barcodeSource stays null while the barcodes persist."
     */
    onDismiss: () => void;
}

export function BarcodeSourceModal({
    open,
    candidates,
    onConfirm,
    onDismiss,
}: BarcodeSourceModalProps) {
    // Deliberately initialized to `{}` — "no pre-selected default" is a
    // literal acceptance criterion here, not a UX nicety. Do not change this
    // to seed either option, for any row. The PARENT mounts this component with
    // a `key` per classification action instead of this component resetting
    // itself in an effect: a changing `key` makes React mount a brand-new
    // instance, so `useState({})` starts fresh through normal initialization —
    // no effect, no extra render, and the same "never carries over the previous
    // selection" guarantee.
    const [chosen, setChosen] = useState<Record<string, BarcodeSourceChoice>>({});

    // Lets the merchant override the simplified catalog-match view on a
    // SPECIFIC row and drop down into the full manual radio choice — the
    // barcode-collision escape hatch, tracked per barcode. Once toggled, that
    // row behaves identically to a no-catalog-match classification for the rest
    // of this session.
    const [manualOverride, setManualOverride] = useState<Record<string, boolean>>({});

    // Defensive de-duplication: the same value twice in one action is
    // meaningless (a barcode resolves to exactly one unit) and would collide
    // as a React key AND a state key. First occurrence wins.
    const rows = useMemo(() => {
        const seen = new Set<string>();
        return candidates.filter((c) => {
            if (seen.has(c.barcode)) return false;
            seen.add(c.barcode);
            return true;
        });
    }, [candidates]);

    // [FIX] A row explicitly classified INTERNAL is never shown in the
    // simplified "confirmed GS1" view, even if its catalog match arrives late.
    const isRowSimplified = (row: BarcodeSourceCandidate) =>
        !!row.catalogMatch &&
        !manualOverride[row.barcode] &&
        chosen[row.barcode] !== "INTERNAL";

    const selectSource = (barcode: string, source: BarcodeSourceChoice) => {
        setChosen((prev) => ({ ...prev, [barcode]: source }));
    };

    const overrideToManual = (barcode: string) => {
        setManualOverride((prev) => ({ ...prev, [barcode]: true }));
    };

    /**
     * "Apply to all" — one click, every row. Still an explicit human action,
     * so it satisfies the no-default rule while sparing the merchant five
     * identical clicks on a unit with five barcodes.
     *
     * A catalog-matched row applied as GS1 needs no override: that IS the
     * structural fact the simplified view states, and no warning belongs on
     * it. Applying INTERNAL to a matched row genuinely contradicts the
     * catalog's own record, so that row switches to the manual view (with its
     * existing "you chose to classify this manually" warning) rather than
     * silently disagreeing with the platform's data.
     */
    const applyToAll = (source: BarcodeSourceChoice) => {
        setChosen((prev) => {
            const next = { ...prev };
            for (const row of rows) next[row.barcode] = source;
            return next;
        });
        if (source === "INTERNAL") {
            setManualOverride((prev) => {
                const next = { ...prev };
                for (const row of rows) {
                    if (row.catalogMatch) next[row.barcode] = true;
                }
                return next;
            });
        }
    };

    const resolvedCount = rows.filter((row) => !!chosen[row.barcode]).length;
    const allResolved = rows.length > 0 && resolvedCount === rows.length;
    const showApplyToAll = rows.length > 1;

    // Outside-click / Escape protection: only once there is something to lose.
    const hasProgress = resolvedCount > 0 || rows.length > 1;

    const handleOpenChange = (isOpen: boolean) => {
        if (!isOpen) {
            // Any path that closes this dialog without going through the Save
            // button (backdrop click, Escape, the built-in close "X") is a
            // dismissal, not a confirmation — route it through the same
            // onDismiss the explicit "إلغاء" button uses.
            onDismiss();
        }
    };

    const handleSave = () => {
        if (!allResolved) return; // Defense-in-depth; the button is disabled anyway.
        onConfirm(
            rows.map((row) => ({
                barcode: row.barcode,
                barcodeSource: chosen[row.barcode],
            }))
        );
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                dir="rtl"
                className="sm:max-w-md"
                // With progress made (or several barcodes in play), a stray tap
                // outside or an Escape press must not throw everything away —
                // the explicit cancel button still can. A single untouched
                // barcode keeps the original "dismiss any way" behavior, since
                // there is nothing yet to lose.
                onInteractOutside={(e) => {
                    if (hasProgress) e.preventDefault();
                }}
                onEscapeKeyDown={(e) => {
                    if (hasProgress) e.preventDefault();
                }}
            >
                <div className={m.m}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-base font-bold">
                            <Barcode className={`w-5 h-5 ${m.titleIcon}`} aria-hidden />
                            <span>تصنيف مصدر الباركود</span>
                            {rows.length > 1 && (
                                <span className="text-xs font-normal text-zinc-500">
                                    ({rows.length} باركودات جديدة)
                                </span>
                            )}
                        </DialogTitle>
                        <DialogDescription className="text-xs text-zinc-500 leading-relaxed">
                            هذا التصنيف إجباري ولا يمكن تخمينه تلقائياً — الرجاء تحديد مصدر كل باركود بدقة قبل حفظه.
                        </DialogDescription>
                    </DialogHeader>

                    <div
                        className={m.stack}
                        style={{ paddingBlock: 8, maxHeight: "55vh", overflowY: "auto" }}
                    >
                        {showApplyToAll && (
                            <div
                                className={m.statusRow}
                                style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}
                            >
                                <Layers size={14} aria-hidden />
                                <span>تطبيق على كل الباركودات:</span>
                                <button
                                    type="button"
                                    className={`${m.btn} ${m.btnOutline}`}
                                    style={{ padding: "2px 10px" }}
                                    onClick={() => applyToAll("GS1")}
                                >
                                    الكل GS1
                                </button>
                                <button
                                    type="button"
                                    className={`${m.btn} ${m.btnOutline}`}
                                    style={{ padding: "2px 10px" }}
                                    onClick={() => applyToAll("INTERNAL")}
                                >
                                    الكل داخلي
                                </button>
                            </div>
                        )}

                        {rows.map((row, index) => {
                            const simplified = isRowSimplified(row);
                            const radioName = `barcode-source-${index}`;

                            return (
                                <div
                                    key={row.barcode}
                                    className={m.box}
                                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                                >
                                    <span className={m.label}>
                                        {rows.length > 1 ? `الباركود ${index + 1}:` : "الباركود المدخل:"}
                                    </span>
                                    <p
                                        className={`${m.inputMono} ${m.summaryName}`}
                                        style={{ marginTop: 2 }}
                                        dir="ltr"
                                    >
                                        {row.barcode || "—"}
                                    </p>

                                    {simplified ? (
                                        // Simplified confirmation view — shown only when this
                                        // exact barcode was just found in the shared catalog.
                                        // Asking "GS1 or internal?" here would be asking a
                                        // question the system already knows the answer to with
                                        // certainty (see the prop-level comment above). Still
                                        // requires an explicit click before anything is saved.
                                        <div className={m.stack}>
                                            <div
                                                className={`${m.radioCard} ${m.radioCardActive}`}
                                                style={{ cursor: "default" }}
                                            >
                                                <CheckCircle2
                                                    className={`w-5 h-5 ${m.radioIconEmerald}`}
                                                    style={{ marginTop: 1 }}
                                                    aria-hidden
                                                />
                                                <div>
                                                    <p className={m.radioTitle}>
                                                        هذا الباركود مؤكَّد مسبقاً كـ GS1 في الكتالوج المشترك
                                                    </p>
                                                    <p className={m.radioBody}>
                                                        تاجر آخر على المنصّة صنّف هذا الباركود بنفسه كـ GS1 عند ربطه بالمنتج &quot;{row.catalogMatch?.name}&quot;.
                                                        بما أن الكتالوج المشترك لا يقبل إلا الباركودات المصنّفة GS1 صراحةً، هذا التصنيف مؤكد وليس تخميناً.
                                                    </p>
                                                </div>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() => overrideToManual(row.barcode)}
                                                className={m.statusRow}
                                                style={{
                                                    border: 0,
                                                    background: "transparent",
                                                    cursor: "pointer",
                                                    textDecoration: "underline",
                                                }}
                                            >
                                                <ShieldQuestion size={14} aria-hidden />
                                                <span>هذا غير صحيح، أريد تصنيفه يدوياً بنفسي</span>
                                            </button>

                                            {/* The matched row's OWN explicit confirmation — a
                                                single deliberate click instead of a two-option
                                                radio choice, since only one answer is
                                                structurally possible until the override above. */}
                                            <button
                                                type="button"
                                                onClick={() => selectSource(row.barcode, "GS1")}
                                                className={`${m.btn} ${m.btnSolid}`}
                                            >
                                                {chosen[row.barcode] === "GS1"
                                                    ? "تم التأكيد كـ GS1 ✓"
                                                    : "تأكيد كـ GS1"}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className={m.stack}>
                                            {/* GS1 option */}
                                            <label
                                                className={`${m.radioCard} ${chosen[row.barcode] === "GS1" ? m.radioCardActive : ""}`}
                                            >
                                                <input
                                                    type="radio"
                                                    name={radioName}
                                                    value="GS1"
                                                    checked={chosen[row.barcode] === "GS1"}
                                                    onChange={() => selectSource(row.barcode, "GS1")}
                                                    className={m.radioInput}
                                                />
                                                <Factory
                                                    className={`w-4 h-4 ${m.radioIconEmerald}`}
                                                    style={{ marginTop: 2 }}
                                                    aria-hidden
                                                />
                                                <div>
                                                    <p className={m.radioTitle}>باركود قياسي مطبوع من المصنّع (GS1)</p>
                                                    <p className={m.radioBody}>
                                                        باركود دولي حقيقي مطبوع على المنتج من الشركة المصنّعة — يؤهّل هذا المنتج للاستفادة من الكتالوج المشترك بين التجّار على المنصّة.
                                                    </p>
                                                </div>
                                            </label>

                                            {/* INTERNAL option */}
                                            <label
                                                className={`${m.radioCard} ${chosen[row.barcode] === "INTERNAL" ? m.radioCardActive : ""}`}
                                            >
                                                <input
                                                    type="radio"
                                                    name={radioName}
                                                    value="INTERNAL"
                                                    checked={chosen[row.barcode] === "INTERNAL"}
                                                    onChange={() => selectSource(row.barcode, "INTERNAL")}
                                                    className={m.radioInput}
                                                />
                                                <PenLine
                                                    className={`w-4 h-4 ${m.radioIconBlue}`}
                                                    style={{ marginTop: 2 }}
                                                    aria-hidden
                                                />
                                                <div>
                                                    <p className={m.radioTitle}>باركود داخلي أنشأته بنفسي لهذا المنتج</p>
                                                    <p className={m.radioBody}>
                                                        رقم أو ملصق داخلي خاص بمتجرك فقط — لن يُستخدم للمساهمة في الكتالوج المشترك بين التجّار.
                                                    </p>
                                                </div>
                                            </label>

                                            {/* Shown whenever a catalog match exists but this row is
                                                in the manual view (explicit override, "all internal",
                                                or an INTERNAL choice made before the catalog
                                                answered). */}
                                            {row.catalogMatch && (
                                                <p className={m.pendingNote}>
                                                    <ShieldQuestion size={12} aria-hidden />
                                                    <span>تنبيه: هذا الباركود موجود في الكتالوج المشترك كـ GS1 — اخترت تصنيفه يدوياً مع ذلك، سيُعتمد اختيارك.</span>
                                                </p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <DialogFooter>
                        <div className={m.footerRow} style={{ width: "100%" }}>
                            <button type="button" onClick={onDismiss} className={`${m.btn} ${m.btnOutline}`}>
                                إلغاء (لن تُحفظ الباركودات)
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={!allResolved}
                                className={`${m.btn} ${m.btnSolid}`}
                            >
                                {allResolved || rows.length <= 1
                                    ? "تأكيد وحفظ"
                                    : `تأكيد وحفظ (${resolvedCount}/${rows.length})`}
                            </button>
                        </div>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}