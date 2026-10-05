"use client";

import { AlertCircle } from "lucide-react";
import { StatusBadge } from "@/components/inventory/status-badge";

interface NegativeStockBadgeProps {
  quantity: number;
  unitName?: string;
}

export function NegativeStockBadge({ quantity, unitName }: NegativeStockBadgeProps) {
  if (quantity >= 0) return null;

  // Rounds display to at most 2 decimal places (quantities can carry up to 4
  // per ProductBatch.quantity's Decimal(18,4) precision) and trims trailing
  // zeros, so an offline-sync-conflict quantity like -2.3333 doesn't render as
  // a raw decimal string. Display only — the value passed in is untouched.
  const displayQty = Number(quantity.toFixed(2));
  const quantityLabel = unitName ? `${displayQty} ${unitName}` : `${displayQty}`;

  // Red, not purple: negative stock means more was sold than was ever
  // received — that is the most serious state on this screen.
  return (
    <StatusBadge tone="red">
      <AlertCircle className="size-3.5" aria-hidden />
      <span>مخزون سالب ({quantityLabel}) — يحتاج تسوية</span>
    </StatusBadge>
  );
}