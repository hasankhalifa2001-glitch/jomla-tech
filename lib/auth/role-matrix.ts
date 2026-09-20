import { NextResponse } from "next/server";

export type UserRole = "ADMIN" | "CASHIER";

export type AppAction =
  | "dashboard:analytics"
  | "pos:create_sale"
  | "pos:walkin_customer"
  | "inventory:view"
  | "inventory:mutate"
  | "ledger:view_balances"
  | "ledger:log_repayment"
  | "ledger:void_invoice"
  | "ledger:merge_customers"
  | "ledger:view_failed_sync"
  | "orders:view"
  | "orders:manage"
  | "settings:manage"
  // [ADDED — T4c2] /dashboard/sales-log — an ADMIN filtering the invoice
  // log by a staff member OTHER than themselves. Not needed for: an ADMIN
  // viewing the unfiltered (all-staff) log, or any CASHIER request — a
  // CASHIER is always scoped to their own invoices directly in
  // app/api/invoices/route.ts, before this permission is ever checked.
  | "sales_log:view_all_staff";

/**
 * Single authoritative statement of CASHIER vs ADMIN access across every screen/action in the system.
 * Every later task's role-restriction language ("ADMIN-only", "CASHIER-blocked") points back to this table.
 */
export const ROLE_CAPABILITY_MATRIX: Record<AppAction, Record<UserRole, boolean>> = {
  // /dashboard (T1) — analytics & KPIs: not permitted for CASHIER; CASHIER landing page is /dashboard/pos
  "dashboard:analytics": {
    ADMIN: true,
    CASHIER: false,
  },
  // /dashboard/pos (T4b) — create sale
  "pos:create_sale": {
    ADMIN: true,
    CASHIER: true,
  },
  // /dashboard/pos (T4b) — walk-in customer creation
  "pos:walkin_customer": {
    ADMIN: true,
    CASHIER: true,
  },
  // /dashboard/inventory (T3) — view products, batches, stock, expiry
  "inventory:view": {
    ADMIN: true,
    CASHIER: true,
  },
  // /dashboard/inventory (T3) — create/edit products, batches, CSV import, storefront toggle, barcode source
  "inventory:mutate": {
    ADMIN: true,
    CASHIER: false,
  },
  // /dashboard/ledger (T4e) — view customer balances
  "ledger:view_balances": {
    ADMIN: true,
    CASHIER: true,
  },
  // /dashboard/ledger (T4e) — log a repayment
  "ledger:log_repayment": {
    ADMIN: true,
    CASHIER: false,
  },
  // /dashboard/ledger (T4e) — void/refund an invoice (T4d)
  "ledger:void_invoice": {
    ADMIN: true,
    CASHIER: false,
  },
  // /dashboard/ledger (T4e) — customer merge
  "ledger:merge_customers": {
    ADMIN: true,
    CASHIER: false,
  },
  // /dashboard/ledger (T4e) — failed-sync items view
  "ledger:view_failed_sync": {
    ADMIN: true,
    CASHIER: false,
  },
  // /dashboard/orders (T5) — view pending B2B requests
  "orders:view": {
    ADMIN: true,
    CASHIER: true,
  },
  // /dashboard/orders (T5) — approve or reject B2B requests
  "orders:manage": {
    ADMIN: true,
    CASHIER: false,
  },
  // /dashboard/settings, /settings/billing, /settings/staff, daily exchange rate
  "settings:manage": {
    ADMIN: true,
    CASHIER: false,
  },
  // [ADDED — T4c2] /dashboard/sales-log — filtering the tenant-wide
  // invoice log by a staff member other than yourself.
  "sales_log:view_all_staff": {
    ADMIN: true,
    CASHIER: false,
  },
};

export class ForbiddenRoleError extends Error {
  readonly role: UserRole;
  readonly action: AppAction;

  constructor(role: UserRole, action: AppAction) {
    super(`غير مصرح: هذا الإجراء متاح لمدير المتجر فقط.`);
    this.name = "ForbiddenRoleError";
    this.role = role;
    this.action = action;
  }
}

export function canRolePerform(role: UserRole | undefined | null, action: AppAction): boolean {
  if (!role) return false;
  return !!ROLE_CAPABILITY_MATRIX[action]?.[role];
}

export function assertRolePermission(
  role: UserRole | undefined | null,
  action: AppAction
): asserts role is UserRole {
  if (!role || !ROLE_CAPABILITY_MATRIX[action]?.[role]) {
    throw new ForbiddenRoleError(role || "CASHIER", action);
  }
}

// [FIX] `action` is now an explicit (optional) parameter instead of being
// hardcoded to "settings:manage" on every call. Previously, any call site
// enforcing ADMIN-only access for a DIFFERENT action (e.g. ledger:void_invoice,
// orders:manage) would still record "settings:manage" on the thrown
// ForbiddenRoleError — misleading for logging/monitoring and for anyone
// inspecting the error downstream. Defaults to "settings:manage" only for
// backward compatibility with call sites that genuinely are settings-related
// (e.g. the exchange-rate route) and haven't been updated to pass one yet.
export function assertAdmin(
  role: UserRole | undefined | null,
  action: AppAction = "settings:manage"
): asserts role is "ADMIN" {
  if (role !== "ADMIN") {
    throw new ForbiddenRoleError(role || "CASHIER", action);
  }
}

export function forbiddenRoleResponse(error?: ForbiddenRoleError | string) {
  const message =
    typeof error === "string"
      ? error
      : error?.message || "غير مصرح: هذا الإجراء متاح لمدير المتجر فقط.";
  return NextResponse.json(
    {
      error: "FORBIDDEN",
      message,
    },
    { status: 403 }
  );
}