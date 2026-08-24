import Link from "next/link";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/pos", label: "POS" },
  { href: "/inventory", label: "Inventory" },
  { href: "/ledger", label: "Ledger" },
  { href: "/orders", label: "Orders" },
  { href: "/settings/billing", label: "Billing" },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1">
      <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-zinc-50 p-6 md:block">
        <div className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Merchant Console
          </p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-900">Jomla Tech</h2>
        </div>
        <nav className="space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-white hover:text-zinc-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="border-b border-zinc-200 bg-white px-6 py-4">
          <p className="text-sm text-zinc-600">Admin / POS shell</p>
        </header>
        <main className="flex-1 bg-zinc-50 p-6">{children}</main>
      </div>
    </div>
  );
}
