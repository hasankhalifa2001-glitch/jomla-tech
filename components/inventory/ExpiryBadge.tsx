"use client";

import { AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react";
import { StatusBadge } from "@/components/inventory/status-badge";

interface ExpiryBadgeProps {
  daysToExpiry: number | null;
  expiryDate: string | Date | null;
  status: "RED" | "YELLOW" | "NORMAL";
}

export function ExpiryBadge({ daysToExpiry, expiryDate, status }: ExpiryBadgeProps) {
  if (!expiryDate || daysToExpiry === null) {
    return <StatusBadge tone="slate">بدون تاريخ انتهاء</StatusBadge>;
  }

  // Targets Syrian Arabic specifically (per the Global UI/UX spec's
  // Intl.NumberFormat('ar-SY') requirement) — "ar-EG" would produce Egyptian
  // month names rather than the Levantine convention Syrian users expect.
  const formattedDate = new Date(expiryDate).toLocaleDateString("ar-SY", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  if (status === "RED") {
    const isExpired = daysToExpiry <= 0;
    return (
      <StatusBadge tone="red">
        <AlertCircle className="size-3.5" aria-hidden />
        <span>{isExpired ? "منتهي الصلاحية" : `ينتهي خلال ${daysToExpiry} يوم (${formattedDate})`}</span>
      </StatusBadge>
    );
  }

  if (status === "YELLOW") {
    return (
      <StatusBadge tone="amber">
        <AlertTriangle className="size-3.5" aria-hidden />
        <span>
          ينتهي خلال {daysToExpiry} يوم ({formattedDate})
        </span>
      </StatusBadge>
    );
  }

  return (
    <StatusBadge tone="green">
      <CheckCircle2 className="size-3.5" aria-hidden />
      <span>صالح ({formattedDate})</span>
    </StatusBadge>
  );
}