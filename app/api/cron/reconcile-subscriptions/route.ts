import { NextResponse } from "next/server";
import { reconcileSubscriptions } from "@/lib/data/subscription-reconcile";

export const dynamic = "force-dynamic";

/**
 * T6c §5 — Daily reconciliation. Idempotent, never required for correctness.
 * Protection: `Authorization: Bearer <CRON_SECRET>`. Missing/empty/wrong → 401.
 * All DB logic lives in lib/data/subscription-reconcile.ts.
 */
function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim().length === 0) return false;
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length);
  if (presented.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= secret.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "UNAUTHORIZED", message: "غير مصرح." }, { status: 401 });
  }
  try {
    const result = await reconcileSubscriptions(new Date());
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[cron] reconcile-subscriptions failed", err);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "فشلت مهمة المطابقة." },
      { status: 500 }
    );
  }
}