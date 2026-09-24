"use client";

import { AlertCircle } from "lucide-react";
import s from "./inventory.module.css";

interface NegativeStockBadgeProps {
  quantity: number;
  unitName?: string;
}

export function NegativeStockBadge({ quantity, unitName }: NegativeStockBadgeProps) {
  if (quantity >= 0) return null;

  // Rounds display to at most 2 decimal places (quantities can carry up to
  // 4 per ProductBatch.quantity's Decimal(18,4) precision) and trims
  // trailing zeros, so an offline-sync-conflict quantity like -2.3333
  // doesn't render as a raw, unpolished-looking decimal string. Display
  // only — the underlying `quantity` value passed in is untouched.
  const displayQty = Number(quantity.toFixed(2));
  const quantityLabel = unitName ? `${displayQty} ${unitName}` : `${displayQty}`;

  return (
    <span className={`${s.badge} ${s.badgePurple}`}>
      <AlertCircle size={14} aria-hidden />
      <span>مخزون سالب ({quantityLabel}) — يحتاج تسوية</span>
    </span>
  );
}