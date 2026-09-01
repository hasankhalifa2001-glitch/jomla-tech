"use client";

import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";

interface NegativeStockBadgeProps {
  quantity: number;
  unitName?: string;
}

export function NegativeStockBadge({ quantity, unitName }: NegativeStockBadgeProps) {
  if (quantity >= 0) return null;

  return (
    <Badge className="bg-purple-500/15 text-purple-700 hover:bg-purple-500/25 dark:bg-purple-500/20 dark:text-purple-300 border-purple-300 dark:border-purple-800 flex items-center gap-1 text-[11px] font-semibold">
      <AlertCircle className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
      <span>
        مخزون سالب ({quantity} {unitName || ""}) — يحتاج تسوية
      </span>
    </Badge>
  );
}