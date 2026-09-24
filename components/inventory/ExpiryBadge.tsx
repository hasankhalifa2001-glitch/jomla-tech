"use client";

import { AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react";
import s from "./inventory.module.css";

interface ExpiryBadgeProps {
  daysToExpiry: number | null;
  expiryDate: string | Date | null;
  status: "RED" | "YELLOW" | "NORMAL";
}

export function ExpiryBadge({ daysToExpiry, expiryDate, status }: ExpiryBadgeProps) {
  if (!expiryDate || daysToExpiry === null) {
    return <span className={`${s.badge} ${s.badgeSlate}`}>بدون تاريخ انتهاء</span>;
  }

  // Targets Syrian Arabic specifically (per the Global UI/UX spec's
  // Intl.NumberFormat('ar-SY') requirement for currency) — "ar-EG" would
  // produce Egyptian month names (e.g. "يناير") rather than the Levantine
  // convention Syrian users expect (e.g. "كانون الثاني").
  const formattedDate = new Date(expiryDate).toLocaleDateString("ar-SY", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  if (status === "RED") {
    const isExpired = daysToExpiry <= 0;
    return (
      <span className={`${s.badge} ${s.badgeRed}`}>
        <AlertCircle size={14} aria-hidden />
        <span>{isExpired ? "منتهي الصلاحية" : `ينتهي خلال ${daysToExpiry} يوم (${formattedDate})`}</span>
      </span>
    );
  }

  if (status === "YELLOW") {
    return (
      <span className={`${s.badge} ${s.badgeAmber}`}>
        <AlertTriangle size={14} aria-hidden />
        <span>ينتهي خلال {daysToExpiry} يوم ({formattedDate})</span>
      </span>
    );
  }

  return (
    <span className={`${s.badge} ${s.badgeGreen}`}>
      <CheckCircle2 size={14} aria-hidden />
      <span>صالح ({formattedDate})</span>
    </span>
  );
}