/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileUp, CheckCircle, RefreshCw, UploadCloud, XCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { formatMoney } from "@/lib/utils/money";

interface CsvImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

// [FIX] Field names now match NewProductImportData / PriceUpdateImportData
// in lib/inventory/csv-parser.ts exactly — this is exactly what
// /api/inventory/import/preview actually returns as of that file's
// currency-safety fix (priceUSD/currentPriceUSD/newPriceUSD do not exist
// anywhere in the schema or this codebase since v3.1; see T1 acceptance
// criteria). The previous version's stale field names caused a guaranteed
// runtime crash (`.toFixed()` on `undefined`) the moment either tab
// rendered — this is what actually broke, not a cosmetic mismatch.
interface NewProductRow {
  lineNumber: number;
  barcode?: string;
  name: string;
  category?: string;
  unitName: string;
  conversionFactor: number;
  priceWholesale: number;
  priceRetail?: number;
  pricingCurrency?: "SYP" | "USD";
  batchNumber?: string;
  quantity?: number;
  expiryDate?: string;
}

interface PriceUpdateRow {
  lineNumber: number;
  barcode: string;
  productName: string;
  unitName: string;
  currentPriceWholesale: number;
  newPriceWholesale: number;
  pricingCurrency: "SYP" | "USD";
  unitId: string;
}

interface RejectedRow {
  lineNumber: number;
  rowContent: string;
  reason: string;
}

interface PreviewData {
  summary: {
    totalRows: number;
    newProductsCount: number;
    priceUpdatesCount: number;
    rejectedRowsCount: number;
  };
  newProducts: NewProductRow[];
  priceUpdates: PriceUpdateRow[];
  rejectedRows: RejectedRow[];
}

// [FIX] Added `failedPriceUpdates` — matches CommitCsvImportResult in
// lib/inventory/csv-parser.ts after its per-row error-isolation fix.
// Without this, a real (non-"skipped") price-update failure was silently
// invisible to `hasPartialFailure` below, even though the server's
// `hasFailures` flag correctly reported it.
interface CommitResult {
  createdProductsCount: number;
  updatedPricesCount: number;
  skippedPriceUpdates: number;
  failedNewProducts: { lineNumber: number; name: string; barcode?: string; reason: string }[];
  failedPriceUpdates: { lineNumber: number; barcode: string; unitName: string; reason: string }[];
}

export function CsvImportModal({ open, onOpenChange, onSuccess }: CsvImportModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingCommit, setLoadingCommit] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);

  const resetAll = () => {
    setFile(null);
    setPreview(null);
    setCommitResult(null);
  };

  const resetToFilePicker = () => {
    setFile(null);
    setPreview(null);
  };

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetAll();
    }
    onOpenChange(nextOpen);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setPreview(null);
      setCommitResult(null);
    }
  };

  const handleUploadAndPreview = async () => {
    if (!file) {
      toast.error("يرجى اختيار ملف CSV أولاً.");
      return;
    }

    setLoadingPreview(true);

    try {
      const csvText = await file.text();

      const res = await fetch("/api/inventory/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvString: csvText }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "حدث خطأ أثناء معاينة الاستيراد.");
      }

      setPreview(data.preview);
      toast.success("تم تحليل الملف وإظهار المعاينة بنجاح.");
    } catch (err: any) {
      toast.error(err.message || "فشلت عملية التحليل.");
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleCommitImport = async () => {
    if (!preview) return;

    if (preview.newProducts.length === 0 && preview.priceUpdates.length === 0) {
      toast.error("لا توجد بيانات صالحة للاستيراد.");
      return;
    }

    setLoadingCommit(true);

    try {
      const res = await fetch("/api/inventory/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newProducts: preview.newProducts,
          priceUpdates: preview.priceUpdates,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "حدث خطأ أثناء تنفيذ الاستيراد.");
      }

      onSuccess();

      if (data.hasFailures) {
        setCommitResult(data.result);
        toast.warning(data.message || "تم الاستيراد جزئياً مع بعض الأخطاء.");
      } else {
        toast.success(data.message || "تم تنفيذ الاستيراد بنجاح!");
        handleClose(false);
      }
    } catch (err: any) {
      toast.error(err.message || "فشلت عملية حفظ الاستيراد.");
    } finally {
      setLoadingCommit(false);
    }
  };

  const canCommit =
    !!preview && (preview.newProducts.length > 0 || preview.priceUpdates.length > 0);

  // [FIX] Now also triggers on failedPriceUpdates — see interface comment.
  const hasPartialFailure =
    !!commitResult &&
    (commitResult.failedNewProducts.length > 0 ||
      commitResult.skippedPriceUpdates > 0 ||
      commitResult.failedPriceUpdates.length > 0);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <FileUp className="w-5 h-5 text-blue-600" />
            <span>الاستيراد الجماعي (CSV Bulk Import)</span>
          </DialogTitle>
          <DialogDescription>
            قم برفع ملف CSV لمعاينة التعديلات والتأكد من سلامة البيانات قبل حفظها نهائياً.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {hasPartialFailure && commitResult && (
            <div className="p-4 rounded-xl border border-amber-300 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span className="font-semibold text-sm text-amber-800 dark:text-amber-300">
                  تم إنشاء {commitResult.createdProductsCount} منتج وتحديث {commitResult.updatedPricesCount} سعر.
                  {commitResult.failedNewProducts.length > 0 &&
                    ` تعذّر إنشاء ${commitResult.failedNewProducts.length} منتج.`}
                  {commitResult.skippedPriceUpdates > 0 &&
                    ` تم تجاهل ${commitResult.skippedPriceUpdates} تحديث سعر (الوحدة غير موجودة).`}
                  {commitResult.failedPriceUpdates.length > 0 &&
                    ` تعذّر تنفيذ ${commitResult.failedPriceUpdates.length} تحديث سعر بسبب خطأ غير متوقع.`}
                </span>
              </div>

              {commitResult.failedNewProducts.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">منتجات لم يتم إنشاؤها:</p>
                  {commitResult.failedNewProducts.map((row) => (
                    <div
                      key={`np-${row.lineNumber}`}
                      className="p-2.5 bg-white dark:bg-zinc-900 rounded-lg border border-amber-200 dark:border-amber-900/50 text-xs"
                    >
                      <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                        السطر {row.lineNumber} — {row.name}
                        {row.barcode ? ` (${row.barcode})` : ""}:
                      </span>{" "}
                      <span className="text-amber-700 dark:text-amber-400">{row.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* [FIX] New — renders failedPriceUpdates the same way
                  failedNewProducts is rendered above. Previously these
                  rows existed on the server response but were never shown
                  anywhere in this modal. */}
              {commitResult.failedPriceUpdates.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">تحديثات أسعار فشلت:</p>
                  {commitResult.failedPriceUpdates.map((row) => (
                    <div
                      key={`pu-${row.lineNumber}`}
                      className="p-2.5 bg-white dark:bg-zinc-900 rounded-lg border border-amber-200 dark:border-amber-900/50 text-xs"
                    >
                      <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                        السطر {row.lineNumber} — {row.unitName} ({row.barcode}):
                      </span>{" "}
                      <span className="text-amber-700 dark:text-amber-400">{row.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              {commitResult.skippedPriceUpdates > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {commitResult.skippedPriceUpdates} تحديث سعر تم تجاهله لأن الوحدة المرتبطة به لم تعد موجودة —
                  يُنصح بإعادة معاينة الملف واستيراده من جديد للتأكد من سلامة البيانات.
                </p>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleClose(false)}
                className="text-xs"
              >
                إغلاق
              </Button>
            </div>
          )}

          {!hasPartialFailure && (
            <>
              <div className="p-4 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-900/50 text-center">
                <UploadCloud className="w-8 h-8 text-zinc-400 mb-2" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  اختر ملف CSV من جهازك
                </p>
                {/* [FIX] "السعر (USD)" removed from the hint — priceWholesale
                    is denominated in whichever pricingCurrency the row
                    specifies (SYP by default if omitted, never assumed
                    USD). The old wording directly encouraged the exact
                    currency-mixup csv-parser.ts's own currency-safety
                    logic exists to prevent. */}
                <p className="text-xs text-zinc-400 mt-1 mb-3">
                  يدعم أعمدة: الباركود، اسم المنتج، التصنيف، الوحدة، معامل التحويل، السعر، العملة (SYP أو USD، اختياري)، رقم الدفعة، الكمية، تاريخ الانتهاء (YYYY-MM-DD).
                </p>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileChange}
                  className="text-xs text-zinc-500 file:ml-4 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
                />
                {file && (
                  <p className="text-[11px] text-zinc-500 mt-2">
                    الملف المحدد: <span className="font-medium">{file.name}</span>
                  </p>
                )}
              </div>

              {file && !preview && (
                <Button
                  type="button"
                  onClick={handleUploadAndPreview}
                  disabled={loadingPreview}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingPreview ? "animate-spin" : ""}`} />
                  <span>{loadingPreview ? "جاري فحص وتحليل الملف..." : "معاينة ملف CSV والتحقق من الأخطاء"}</span>
                </Button>
              )}

              {preview && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                    <div className="p-3 bg-zinc-100 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <p className="text-xs text-zinc-500">إجمالي الأسطر</p>
                      <p className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{preview.summary.totalRows}</p>
                    </div>
                    <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg border border-emerald-200 dark:border-emerald-900/50">
                      <p className="text-xs text-emerald-600 dark:text-emerald-400">منتجات جديدة</p>
                      <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300">{preview.summary.newProductsCount}</p>
                    </div>
                    <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-900/50">
                      <p className="text-xs text-blue-600 dark:text-blue-400">تحديث الأسعار</p>
                      <p className="text-lg font-bold text-blue-700 dark:text-blue-300">{preview.summary.priceUpdatesCount}</p>
                    </div>
                    <div className="p-3 bg-red-50 dark:bg-red-950/30 rounded-lg border border-red-200 dark:border-red-900/50">
                      <p className="text-xs text-red-600 dark:text-red-400">أسطر مرفوضة</p>
                      <p className="text-lg font-bold text-red-700 dark:text-red-300">{preview.summary.rejectedRowsCount}</p>
                    </div>
                  </div>

                  {preview.summary.rejectedRowsCount > 0 && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 text-xs text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        يوجد {preview.summary.rejectedRowsCount} سطر مرفوض لن يتم استيراده. راجع تبويب
                        &quot;المرفوضة&quot; أدناه، وبإمكانك المتابعة باستيراد باقي الأسطر الصالحة.
                      </span>
                    </div>
                  )}

                  <Tabs defaultValue={preview.summary.rejectedRowsCount > 0 ? "rejected" : "new"} dir="rtl">
                    <TabsList className="w-full grid grid-cols-3">
                      <TabsTrigger value="rejected" className="text-xs gap-1">
                        <XCircle className="w-3.5 h-3.5 text-red-500" />
                        <span>المرفوضة ({preview.summary.rejectedRowsCount})</span>
                      </TabsTrigger>
                      <TabsTrigger value="new" className="text-xs gap-1">
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                        <span>الجديدة ({preview.summary.newProductsCount})</span>
                      </TabsTrigger>
                      <TabsTrigger value="prices" className="text-xs gap-1">
                        <RefreshCw className="w-3.5 h-3.5 text-blue-500" />
                        <span>تحديث السعر ({preview.summary.priceUpdatesCount})</span>
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="rejected" className="mt-3">
                      {preview.rejectedRows.length === 0 ? (
                        <p className="text-xs text-zinc-400 text-center py-6">لا توجد أسطر مرفوضة. كل الأسطر صالحة للاستيراد.</p>
                      ) : (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                          {preview.rejectedRows.map((row, idx) => (
                            <div
                              key={`${row.lineNumber}-${idx}`}
                              className="p-2.5 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded-lg text-xs"
                            >
                              <p className="font-semibold text-red-700 dark:text-red-400">
                                السطر {row.lineNumber}
                              </p>
                              <p className="text-red-600 dark:text-red-400 mt-0.5">{row.reason}</p>
                              {row.rowContent && (
                                <p className="text-zinc-400 mt-1 font-mono text-[10px] truncate" title={row.rowContent}>
                                  {row.rowContent}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="new" className="mt-3">
                      {preview.newProducts.length === 0 ? (
                        <p className="text-xs text-zinc-400 text-center py-6">لا توجد منتجات جديدة في هذا الملف.</p>
                      ) : (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                          {preview.newProducts.map((row) => (
                            <div
                              key={row.lineNumber}
                              className="p-2.5 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 rounded-lg flex items-center justify-between gap-3 text-xs"
                            >
                              <div>
                                <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                                  السطر {row.lineNumber}: {row.name}
                                </p>
                                <p className="text-zinc-500 mt-0.5">
                                  {row.unitName} · معامل {row.conversionFactor}
                                  {row.barcode ? ` · باركود ${row.barcode}` : " · بدون باركود"}
                                  {row.quantity ? ` · كمية أولية ${row.quantity}` : ""}
                                  {row.expiryDate ? ` · ينتهي ${row.expiryDate}` : ""}
                                </p>
                              </div>
                              {/* [FIX] priceUSD → priceWholesale, rendered
                                  via the shared money formatter in whichever
                                  currency this row actually specified
                                  (defaulting to SYP, matching the schema's
                                  own default) — never a hardcoded "$". */}
                              <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400 shrink-0">
                                {formatMoney(row.priceWholesale, row.pricingCurrency ?? "SYP")}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="prices" className="mt-3">
                      {preview.priceUpdates.length === 0 ? (
                        <p className="text-xs text-zinc-400 text-center py-6">لا توجد تحديثات أسعار في هذا الملف.</p>
                      ) : (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                          {preview.priceUpdates.map((row) => (
                            <div
                              key={row.lineNumber}
                              className="p-2.5 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/50 rounded-lg flex items-center justify-between gap-3 text-xs"
                            >
                              <div>
                                <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                                  السطر {row.lineNumber}: {row.productName}
                                </p>
                                <p className="text-zinc-500 mt-0.5">
                                  {row.unitName} · باركود {row.barcode}
                                </p>
                              </div>
                              {/* [FIX] currentPriceUSD/newPriceUSD →
                                  currentPriceWholesale/newPriceWholesale,
                                  formatted in the unit's actual
                                  pricingCurrency (always present on this
                                  row per csv-parser.ts's currency-safety
                                  fix — never assumed/hardcoded). */}
                              <div className="text-left font-mono text-xs shrink-0">
                                <span className="text-zinc-400 line-through">
                                  {formatMoney(row.currentPriceWholesale, row.pricingCurrency)}
                                </span>
                                <span className="mx-1 text-zinc-400">→</span>
                                <span className="font-bold text-blue-700 dark:text-blue-400">
                                  {formatMoney(row.newPriceWholesale, row.pricingCurrency)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>

                  <div className="flex items-center justify-between gap-3 pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={resetToFilePicker}
                      className="text-xs"
                    >
                      اختيار ملف آخر
                    </Button>

                    <Badge variant="outline" className="text-[11px] text-zinc-500">
                      سيتم استيراد {preview.summary.newProductsCount + preview.summary.priceUpdatesCount} من أصل {preview.summary.totalRows} سطر
                    </Badge>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0" dir="rtl">
          <Button type="button" variant="outline" onClick={() => handleClose(false)}>
            {hasPartialFailure ? "تم" : "إلغاء"}
          </Button>
          {!hasPartialFailure && (
            <Button
              type="button"
              onClick={handleCommitImport}
              disabled={!canCommit || loadingCommit}
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
            >
              <CheckCircle className="w-4 h-4" />
              <span>{loadingCommit ? "جاري تنفيذ الاستيراد..." : "تأكيد الاستيراد وحفظ البيانات"}</span>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}