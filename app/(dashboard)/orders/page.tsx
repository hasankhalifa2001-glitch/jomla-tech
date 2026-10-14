/**
 * T5b — /dashboard/orders (also reachable as /orders: the dashboard group
 * layout covers both; the sidebar links to /orders).
 *
 * Thin server wrapper: the screen is a client component (session role for
 * controls, tabs, search, cursor pagination, drawer + dialog state).
 * Both ADMIN and CASHIER may open it; CASHIER scope is enforced server-side.
 */
import { OrdersClient } from "@/components/orders/orders-client";

export default function OrdersPage() {
    return (
        <section dir="rtl">
            <h1 className="text-2xl font-semibold text-zinc-900">طلبات الجملة B2B</h1>
            <p className="mt-2 text-sm text-zinc-600">
                طلبات تجار التجزئة الواردة وفي انتظار مراجعة التاجر.
            </p>
            <div className="mt-4">
                <OrdersClient />
            </div>
        </section>
    );
}
