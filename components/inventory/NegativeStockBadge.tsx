"use client";

import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";

interface NegativeStockBadgeProps {
  quantity: number;
  unitName?: string;
}

export function NegativeStockBadge({ quantity, unitName }: NegativeStockBadgeProps) {
  if (quantity >= 0) return null;

  // [FIX] Rounds display to at most 2 decimal places (quantities can carry
  // up to 4 per ProductBatch.quantity's Decimal(18,4) precision) and trims
  // trailing zeros, so an offline-sync-conflict quantity like -2.3333
  // doesn't render as a raw, unpolished-looking decimal string. This is
  // display-only — the underlying `quantity` value passed in is untouched.
  const displayQty = Number(quantity.toFixed(2));

  // [FIX] Avoids a stray double-space/trailing-space before the closing
  // parenthesis when unitName is omitted — e.g. "(-5 )" → "(-5)".
  const quantityLabel = unitName ? `${displayQty} ${unitName}` : `${displayQty}`;

  return (
    <Badge className="bg-purple-500/15 text-purple-700 hover:bg-purple-500/25 dark:bg-purple-500/20 dark:text-purple-300 border-purple-300 dark:border-purple-800 flex items-center gap-1 text-[11px] font-semibold">
      <AlertCircle className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
      <span>
        مخزون سالب ({quantityLabel}) — يحتاج تسوية
      </span>
    </Badge>
  );
}