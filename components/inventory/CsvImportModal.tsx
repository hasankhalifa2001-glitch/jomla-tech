"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileUp, CheckCircle, RefreshCw, UploadCloud, XCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface CsvImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface RejectedRow {
  lineNumber: number;
  rowContent: string;
  reason: string;
}

interface NewProductRow {
  lineNumber: number;
  name: string;
  barcode?: string;
  unitName: string;
  priceUSD: number;
}

interface PriceUpdateRow {
  lineNumber: number;
  barcode: string;
  productName: string;
  unitName: string;
  currentPriceUSD: number;
  newPriceUSD: number;
  unitId: string;
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

// Matches CommitCsvImportResult in lib/inventory/csv-parser.ts
interface CommitResult {
  createdProductsCount: number;
  updatedPricesCount: number;
  skippedPriceUpdates: number;
  failedNewProducts: { lineNumber: number; name: string; barcode?: string; reason: string }[];
}

export function CsvImportModal({ open, onOpenChange, onSuccess }: CsvImportModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingCommit, setLoadingCommit] = useState(false);
  // FIX (feature completion): commitCsvImport() was updated on the backend
  // to catch a per-row barcode collision (P2002) instead of aborting the
  // whole import, reporting those rows in `failedNewProducts` instead of
  // silently dropping them. This modal previously ignored that field
  // entirely and just closed on any 2xx response — a merchant could see
  // "تم تنفيذ الاستيراد بنجاح" while one or more products silently failed
  // to import. commitResult now holds that response so it can be shown
  // instead of immediately closing the dialog.
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);

  const resetAll = () => {
    setFile(null);
    setPreview(null);
    setCommitResult(null);
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

      // FIX: only auto-close and reset when nothing failed. If
      // hasFailures is true, keep the dialog open and show exactly which
      // rows failed and why — closing immediately would hide that from
      // the merchant entirely.
      if (data.hasFailures) {
        setCommitResult(data.result);
        toast.warning(data.message || "تم الاستيراد مع بعض الأخطاء.");
      } else {
        toast.success(data.message || "تم تنفيذ الاستيراد بنجاح!");
        onOpenChange(false);
        resetAll();
      }
    } catch (err: any) {
      toast.error(err.message || "فشلت عملية حفظ الاستيراد.");
    } finally {
      setLoadingCommit(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) resetAll();
      }}
    >
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
          {/* Post-commit failures panel — shown only after a commit that
              had partial failures. Takes priority over the upload/preview
              UI so the merchant sees it immediately. */}
          {commitResult && commitResult.failedNewProducts.length > 0 && (
            <div className="p-4 rounded-xl border border-amber-300 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span className="font-semibold text-sm text-amber-800 dark:text-amber-300">
                  تم إنشاء {commitResult.createdProductsCount} منتج وتحديث {commitResult.updatedPricesCount} سعر،
                  لكن تعذّر إنشاء {commitResult.failedNewProducts.length} منتج
                </span>
              </div>
              <div className="space-y-1.5">
                {commitResult.failedNewProducts.map((row) => (
                  <div
                    key={row.lineNumber}
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  resetAll();
                }}
                className="text-xs"
              >
                إغلاق
              </Button>
            </div>
          )}

          {!commitResult && (
            <>
              <div className="p-4 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-900/50 text-center">
                <UploadCloud className="w-8 h-8 text-zinc-400 mb-2" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  اختر ملف CSV من جهازك
                </p>
                <p className="text-xs text-zinc-400 mt-1 mb-3">
                  يدعم أعمدة: الباركود، اسم المنتج، التصنيف، الوحدة، معامل التحويل، السعر (USD)، رقم الدفعة، الكمية، تاريخ الانتهاء.
                </p>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileChange}
                  className="text-xs text-zinc-500 file:ml-4 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
                />
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
                        <p className="text-xs text-zinc-400 text-center py-6">لا توجد أسطر مرفوضة.</p>
                      ) : (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto">
                          {preview.rejectedRows.map((row) => (
                            <div
                              key={row.lineNumber}
                              className="p-2.5 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded-lg text-xs"
                            >
                              <span className="text-red-700 dark:text-red-400">{row.reason}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="new" className="mt-3">
                      {preview.newProducts.length === 0 ? (
                        <p className="text-xs text-zinc-400 text-center py-6">لا توجد منتجات جديدة في هذا الملف.</p>
                      ) : (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto">
                          {preview.newProducts.map((row) => (
                            <div
                              key={row.lineNumber}
                              className="p-2.5 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 rounded-lg flex items-center justify-between text-xs"
                            >
                              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                                {row.name} {row.barcode ? `(${row.barcode})` : ""}
                              </span>
                              <span className="font-mono text-emerald-700 dark:text-emerald-400 font-bold">
                                ${row.priceUSD.toFixed(2)} / {row.unitName}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="prices" className="mt-3">
                      {preview.priceUpdates.length === 0 ? (
                        <p className="text-xs text-zinc-400 text-center py-6">لا توجد تحديثات أسعار في هذا الملف.</p>
                      ) : (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto">
                          {preview.priceUpdates.map((row) => (
                            <div
                              key={row.lineNumber}
                              className="p-2.5 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/50 rounded-lg flex items-center justify-between text-xs"
                            >
                              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                                {row.productName} — {row.unitName}
                              </span>
                              <span className="font-mono text-xs">
                                <span className="text-zinc-400 line-through ml-1">${row.currentPriceUSD.toFixed(2)}</span>
                                <span className="text-blue-700 dark:text-blue-400 font-bold">${row.newPriceUSD.toFixed(2)}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>

                  <Button
                    type="button"
                    onClick={handleCommitImport}
                    disabled={loadingCommit || (preview.newProducts.length === 0 && preview.priceUpdates.length === 0)}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                  >
                    <CheckCircle className={`w-4 h-4 ${loadingCommit ? "animate-pulse" : ""}`} />
                    <span>{loadingCommit ? "جاري تنفيذ الاستيراد..." : "تأكيد وحفظ الاستيراد"}</span>
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter dir="rtl">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              resetAll();
            }}
          >
            {commitResult ? "تم" : "إلغاء"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}