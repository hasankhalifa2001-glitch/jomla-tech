"use client";

import { Badge } from "@/components/ui/badge";
import { AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react";

interface ExpiryBadgeProps {
  daysToExpiry: number | null;
  expiryDate: string | Date | null;
  status: "RED" | "YELLOW" | "NORMAL";
}

export function ExpiryBadge({ daysToExpiry, expiryDate, status }: ExpiryBadgeProps) {
  if (!expiryDate || daysToExpiry === null) {
    return (
      <Badge variant="outline" className="text-zinc-500 border-zinc-200 dark:border-zinc-800 dark:text-zinc-400">
        بدون تاريخ انتهاء
      </Badge>
    );
  }

  // [FIX] Was "ar-EG" — the rest of this app's locale-sensitive formatting
  // (per the Global UI/UX spec's Intl.NumberFormat('ar-SY') requirement for
  // currency) targets Syrian Arabic specifically. "ar-EG" produces
  // Egyptian month names (e.g. "يناير") rather than the Levantine
  // convention Syrian users expect (e.g. "كانون الثاني"), which reads as a
  // locale mismatch even though both are valid Arabic. Aligned to "ar-SY"
  // for consistency with the currency formatting used elsewhere.
  const formattedDate = new Date(expiryDate).toLocaleDateString("ar-SY", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  if (status === "RED") {
    const isExpired = daysToExpiry <= 0;
    return (
      <Badge className="bg-red-500/15 text-red-700 hover:bg-red-500/25 dark:bg-red-500/20 dark:text-red-400 border-red-200 dark:border-red-900/50 flex items-center gap-1">
        <AlertCircle className="w-3.5 h-3.5" />
        <span>
          {isExpired ? "منتهي الصلاحية" : `ينتهي خلال ${daysToExpiry} يوم (${formattedDate})`}
        </span>
      </Badge>
    );
  }

  if (status === "YELLOW") {
    return (
      <Badge className="bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 dark:bg-amber-500/20 dark:text-amber-300 border-amber-200 dark:border-amber-900/50 flex items-center gap-1">
        <AlertTriangle className="w-3.5 h-3.5" />
        <span>ينتهي خلال {daysToExpiry} يوم ({formattedDate})</span>
      </Badge>
    );
  }

  return (
    <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:bg-emerald-500/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 flex items-center gap-1">
      <CheckCircle2 className="w-3.5 h-3.5" />
      <span>صالح ({formattedDate})</span>
    </Badge>
  );
}