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
import { Button } from "@/components/ui/button";
import { Barcode, Factory, PenLine, CheckCircle2, ShieldQuestion } from "lucide-react";

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
     * [ADDED] Present ONLY when this exact barcode value was just found in
     * the platform-wide shared catalog (ProductCatalogEntry). This is
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
    // [FIX] There is deliberately NO effect here re-resetting `selected`
    // when `open`/`barcode` change. Calling setState synchronously inside a
    // useEffect body to sync internal state with a prop is exactly the
    // anti-pattern React's own docs warn against (it forces an extra,
    // avoidable render pass every time this modal opens). Instead, the
    // PARENT (AddProductModal) is responsible for mounting this component
    // with a `key` derived from the specific barcode-classification request
    // — e.g. `key={`${unitIndex}-${barcode}`}` — every time a genuinely new
    // value needs classifying. A changing `key` makes React unmount the old
    // instance and mount a brand-new one, so `useState(null)` below starts
    // fresh purely through normal initialization — no effect, no extra
    // render, and the same "never carries over the previous selection"
    // guarantee the old effect existed to provide.
    const [selected, setSelected] = useState<BarcodeSourceChoice | null>(null);

    // [ADDED] Lets the merchant override the simplified catalog-match view
    // and drop down into the full manual radio choice — the barcode-
    // collision escape hatch. Once toggled, behaves identically to a
    // no-catalog-match classification for the rest of this session.
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

    // [ADDED] The simplified path's own explicit confirmation — still a
    // deliberate human click, just a single one instead of a two-option
    // radio choice, since only one answer is structurally possible here.
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
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-base font-bold">
                        <Barcode className="w-5 h-5 text-emerald-600" />
                        <span>تصنيف مصدر الباركود</span>
                    </DialogTitle>
                    {!showSimplifiedView && (
                        <DialogDescription className="text-xs text-zinc-500 leading-relaxed">
                            هذا التصنيف إجباري ولا يمكن تخمينه تلقائياً — الرجاء تحديد مصدر
                            هذا الباركود بدقة قبل حفظه.
                        </DialogDescription>
                    )}
                </DialogHeader>

                <div className="py-2 space-y-3">
                    <div className="p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800">
                        <span className="text-[11px] text-zinc-500">الباركود المدخل:</span>
                        <p className="font-mono font-bold text-sm text-zinc-800 dark:text-zinc-200 mt-0.5">
                            {barcode || "—"}
                        </p>
                    </div>

                    {showSimplifiedView ? (
                        // [ADDED] Simplified confirmation view — shown only when this
                        // exact barcode was just found in the shared catalog. Asking
                        // "GS1 or internal?" here would be asking a question the
                        // system already knows the answer to with certainty (see the
                        // prop-level comment above for why this is a known fact, not
                        // a guess). Still requires an explicit click before anything
                        // is saved.
                        <div className="space-y-3">
                            <div className="p-3 rounded-lg border-2 border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-700">
                                <div className="flex items-start gap-2.5">
                                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-xs font-bold text-emerald-800 dark:text-emerald-300">
                                            هذا الباركود مؤكَّد مسبقاً كـ GS1 في الكتالوج المشترك
                                        </p>
                                        <p className="text-[11px] text-emerald-700/90 dark:text-emerald-400/90 mt-1 leading-relaxed">
                                            تاجر آخر على المنصّة صنّف هذا الباركود بنفسه كـ GS1 عند
                                            ربطه بالمنتج &quot;{catalogMatch?.name}&quot;. بما أن
                                            الكتالوج المشترك لا يقبل إلا الباركودات المصنّفة GS1
                                            صراحةً، هذا التصنيف مؤكد وليس تخميناً.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={() => setManualOverride(true)}
                                className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline underline-offset-2"
                            >
                                <ShieldQuestion className="w-3.5 h-3.5" />
                                <span>هذا غير صحيح، أريد تصنيفه يدوياً بنفسي</span>
                            </button>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {/* GS1 option */}
                            <label
                                className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${selected === "GS1"
                                        ? "border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/20"
                                        : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                                    }`}
                            >
                                <input
                                    type="radio"
                                    name="barcode-source"
                                    value="GS1"
                                    checked={selected === "GS1"}
                                    onChange={() => setSelected("GS1")}
                                    className="mt-1 w-4 h-4 accent-emerald-600"
                                />
                                <div className="flex items-start gap-2">
                                    <Factory className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                                            باركود قياسي مطبوع من المصنّع (GS1)
                                        </p>
                                        <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                                            باركود دولي حقيقي مطبوع على المنتج من الشركة المصنّعة —
                                            يؤهّل هذا المنتج للاستفادة من الكتالوج المشترك بين
                                            التجّار على المنصّة.
                                        </p>
                                    </div>
                                </div>
                            </label>

                            {/* INTERNAL option */}
                            <label
                                className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${selected === "INTERNAL"
                                        ? "border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/20"
                                        : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                                    }`}
                            >
                                <input
                                    type="radio"
                                    name="barcode-source"
                                    value="INTERNAL"
                                    checked={selected === "INTERNAL"}
                                    onChange={() => setSelected("INTERNAL")}
                                    className="mt-1 w-4 h-4 accent-emerald-600"
                                />
                                <div className="flex items-start gap-2">
                                    <PenLine className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                                    <div>
                                        <p className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                                            باركود داخلي أنشأته بنفسي لهذا المنتج
                                        </p>
                                        <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                                            رقم أو ملصق داخلي خاص بمتجرك فقط — لن يُستخدم للمساهمة
                                            في الكتالوج المشترك بين التجّار.
                                        </p>
                                    </div>
                                </div>
                            </label>

                            {catalogMatch && manualOverride && (
                                <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1 px-1">
                                    <ShieldQuestion className="w-3 h-3 shrink-0" />
                                    <span>
                                        تنبيه: هذا الباركود موجود في الكتالوج المشترك كـ GS1 —
                                        اخترت تصنيفه يدوياً مع ذلك، سيُعتمد اختيارك.
                                    </span>
                                </p>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
                    <Button type="button" variant="outline" onClick={onDismiss} className="h-10 sm:h-9">
                        إلغاء (لن يُحفظ الباركود)
                    </Button>
                    {showSimplifiedView ? (
                        <Button
                            type="button"
                            onClick={handleConfirmCatalogGs1}
                            className="h-10 sm:h-9 bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                            تأكيد كـ GS1
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            onClick={handleSave}
                            disabled={!selected}
                            className="h-10 sm:h-9 bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40"
                        >
                            تأكيد وحفظ
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}