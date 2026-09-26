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
 * This component is a pure, stateless confirmation gate. It does NOT
 * decide when to open (the parent — AddProductModal — decides that, on
 * blur of a manual entry or immediately after a scanner result) and it
 * does NOT infer a source from the barcode's shape. It only presents the
 * two options and reports back an explicit choice or an explicit
 * cancellation. No function here — or anywhere else in this codebase —
 * may guess GS1 vs INTERNAL from digit length or a known prefix pattern;
 * see the BarcodeSource enum comment in schema.prisma for why that is a
 * standing, permanent prohibition, not a placeholder for later.
 */

import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Barcode, Factory, PenLine, CheckCircle2, ShieldQuestion } from "lucide-react";
import m from "./modals.module.css";

export type BarcodeSourceChoice = "GS1" | "INTERNAL";

interface BarcodeSourceModalProps {
    open: boolean;
    /** The barcode value awaiting classification. Display-only here. */
    barcode: string;
    /**
     * Fired only when the merchant explicitly picks a source and presses
     * Save. Never fired automatically, never fired with a guessed value.
     */
    onConfirm: (source: BarcodeSourceChoice) => void;
    /**
     * Fired when the modal is closed WITHOUT a confirmed choice — the "X"
     * button, clicking outside, or pressing Escape. Per spec, the caller
     * must treat this as "the barcode value itself is also not saved," not
     * merely "barcodeSource stays null while the barcode persists."
     */
    onDismiss: () => void;
    /**
     * Present ONLY when this exact barcode value was just found in the
     * platform-wide shared catalog (ProductCatalogEntry). This is
     * fundamentally different information from "inferring GS1 from the
     * barcode's digit pattern," which remains permanently forbidden (see
     * the BarcodeSource enum note in schema.prisma). A catalog match is not
     * a guess: ProductCatalogEntry rows are only ever written when some
     * OTHER merchant already explicitly confirmed GS1 on this exact barcode
     * (see the write-gate in app/api/inventory/products/route.ts —
     * `if (u.barcodeSource === "GS1" && u.barcode?.trim())`). A match here
     * is therefore a structural fact about the platform's own data, not an
     * inference about the barcode's shape.
     *
     * When present, the modal still requires an explicit human click before
     * saving anything (never silently auto-assigns GS1) — it just replaces
     * the two-option radio choice with a single confirmation, plus a small
     * escape hatch for the rare case of a genuine barcode collision (the
     * same physical number reused by mistake across two unrelated
     * products), which falls back to the full manual choice below.
     */
    catalogMatch?: { name: string } | null;
}

export function BarcodeSourceModal({
    open,
    barcode,
    onConfirm,
    onDismiss,
    catalogMatch,
}: BarcodeSourceModalProps) {
    // Deliberately initialized to `null` — "no pre-selected default" is a
    // literal acceptance criterion here, not a UX nicety. Do not change this
    // to default to either option.
    //
    // There is deliberately NO effect here re-resetting `selected` when
    // `open`/`barcode` change. Calling setState synchronously inside a
    // useEffect body to sync internal state with a prop is exactly the
    // anti-pattern React's own docs warn against. Instead, the PARENT
    // (AddProductModal) mounts this component with a `key` derived from the
    // specific barcode-classification request — e.g.
    // `key={`${unitIndex}-${barcode}`}` — every time a genuinely new value
    // needs classifying. A changing `key` makes React unmount the old
    // instance and mount a brand-new one, so `useState(null)` below starts
    // fresh purely through normal initialization — no effect, no extra
    // render, and the same "never carries over the previous selection"
    // guarantee.
    const [selected, setSelected] = useState<BarcodeSourceChoice | null>(null);

    // Lets the merchant override the simplified catalog-match view and drop
    // down into the full manual radio choice — the barcode-collision escape
    // hatch. Once toggled, behaves identically to a no-catalog-match
    // classification for the rest of this session.
    const [manualOverride, setManualOverride] = useState(false);

    const showSimplifiedView = !!catalogMatch && !manualOverride;

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
        if (!selected) return; // Defense-in-depth; the button is disabled anyway.
        onConfirm(selected);
    };

    // The simplified path's own explicit confirmation — still a deliberate
    // human click, just a single one instead of a two-option radio choice,
    // since only one answer is structurally possible here.
    const handleConfirmCatalogGs1 = () => {
        onConfirm("GS1");
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                dir="rtl"
                // Deliberately NOT closable by clicking outside on mobile-sheet-
                // style flows elsewhere in this app — but this one specifically
                // *is* allowed to be dismissed that way, since a dismissal has a
                // well-defined, spec-mandated meaning (discard the barcode) rather
                // than an ambiguous "did they mean to cancel or not" state.
                className="sm:max-w-md"
            >
                <div className={m.m}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-base font-bold">
                            <Barcode className={`w-5 h-5 ${m.titleIcon}`} aria-hidden />
                            <span>تصنيف مصدر الباركود</span>
                        </DialogTitle>
                        {!showSimplifiedView && (
                            <DialogDescription className="text-xs text-zinc-500 leading-relaxed">
                                هذا التصنيف إجباري ولا يمكن تخمينه تلقائياً — الرجاء تحديد مصدر هذا الباركود بدقة قبل حفظه.
                            </DialogDescription>
                        )}
                    </DialogHeader>

                    <div className={m.stack} style={{ paddingBlock: 8 }}>
                        <div className={m.box}>
                            <span className={m.label}>الباركود المدخل:</span>
                            <p className={`${m.inputMono} ${m.summaryName}`} style={{ marginTop: 2 }}>
                                {barcode || "—"}
                            </p>
                        </div>

                        {showSimplifiedView ? (
                            // Simplified confirmation view — shown only when this exact
                            // barcode was just found in the shared catalog. Asking "GS1
                            // or internal?" here would be asking a question the system
                            // already knows the answer to with certainty (see the
                            // prop-level comment above). Still requires an explicit
                            // click before anything is saved.
                            <div className={m.stack}>
                                <div className={`${m.radioCard} ${m.radioCardActive}`} style={{ cursor: "default" }}>
                                    <CheckCircle2 className={`w-5 h-5 ${m.radioIconEmerald}`} style={{ marginTop: 1 }} aria-hidden />
                                    <div>
                                        <p className={m.radioTitle}>هذا الباركود مؤكَّد مسبقاً كـ GS1 في الكتالوج المشترك</p>
                                        <p className={m.radioBody}>
                                            تاجر آخر على المنصّة صنّف هذا الباركود بنفسه كـ GS1 عند ربطه بالمنتج &quot;{catalogMatch?.name}&quot;.
                                            بما أن الكتالوج المشترك لا يقبل إلا الباركودات المصنّفة GS1 صراحةً، هذا التصنيف مؤكد وليس تخميناً.
                                        </p>
                                    </div>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => setManualOverride(true)}
                                    className={m.statusRow}
                                    style={{ border: 0, background: "transparent", cursor: "pointer", textDecoration: "underline" }}
                                >
                                    <ShieldQuestion size={14} aria-hidden />
                                    <span>هذا غير صحيح، أريد تصنيفه يدوياً بنفسي</span>
                                </button>
                            </div>
                        ) : (
                            <div className={m.stack}>
                                {/* GS1 option */}
                                <label className={`${m.radioCard} ${selected === "GS1" ? m.radioCardActive : ""}`}>
                                    <input
                                        type="radio"
                                        name="barcode-source"
                                        value="GS1"
                                        checked={selected === "GS1"}
                                        onChange={() => setSelected("GS1")}
                                        className={m.radioInput}
                                    />
                                    <Factory className={`w-4 h-4 ${m.radioIconEmerald}`} style={{ marginTop: 2 }} aria-hidden />
                                    <div>
                                        <p className={m.radioTitle}>باركود قياسي مطبوع من المصنّع (GS1)</p>
                                        <p className={m.radioBody}>
                                            باركود دولي حقيقي مطبوع على المنتج من الشركة المصنّعة — يؤهّل هذا المنتج للاستفادة من الكتالوج المشترك بين التجّار على المنصّة.
                                        </p>
                                    </div>
                                </label>

                                {/* INTERNAL option */}
                                <label className={`${m.radioCard} ${selected === "INTERNAL" ? m.radioCardActive : ""}`}>
                                    <input
                                        type="radio"
                                        name="barcode-source"
                                        value="INTERNAL"
                                        checked={selected === "INTERNAL"}
                                        onChange={() => setSelected("INTERNAL")}
                                        className={m.radioInput}
                                    />
                                    <PenLine className={`w-4 h-4 ${m.radioIconBlue}`} style={{ marginTop: 2 }} aria-hidden />
                                    <div>
                                        <p className={m.radioTitle}>باركود داخلي أنشأته بنفسي لهذا المنتج</p>
                                        <p className={m.radioBody}>
                                            رقم أو ملصق داخلي خاص بمتجرك فقط — لن يُستخدم للمساهمة في الكتالوج المشترك بين التجّار.
                                        </p>
                                    </div>
                                </label>

                                {catalogMatch && manualOverride && (
                                    <p className={m.pendingNote}>
                                        <ShieldQuestion size={12} aria-hidden />
                                        <span>تنبيه: هذا الباركود موجود في الكتالوج المشترك كـ GS1 — اخترت تصنيفه يدوياً مع ذلك، سيُعتمد اختيارك.</span>
                                    </p>
                                )}
                            </div>
                        )}
                    </div>

                    <DialogFooter>
                        <div className={m.footerRow} style={{ width: "100%" }}>
                            <button type="button" onClick={onDismiss} className={`${m.btn} ${m.btnOutline}`}>
                                إلغاء (لن يُحفظ الباركود)
                            </button>
                            {showSimplifiedView ? (
                                <button type="button" onClick={handleConfirmCatalogGs1} className={`${m.btn} ${m.btnSolid}`}>
                                    تأكيد كـ GS1
                                </button>
                            ) : (
                                <button type="button" onClick={handleSave} disabled={!selected} className={`${m.btn} ${m.btnSolid}`}>
                                    تأكيد وحفظ
                                </button>
                            )}
                        </div>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}