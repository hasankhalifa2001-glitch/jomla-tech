export default function MarketingPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24">
      <div className="max-w-3xl text-center">
        <p className="text-sm font-medium uppercase tracking-wider text-zinc-500">
          Jomla Tech
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">
          Multi-tenant wholesale SaaS for modern merchants
        </h1>
        <p className="mt-6 text-lg leading-8 text-zinc-600">
          Offline-first POS, smart debt ledger, B2B storefront, and dual-currency
          billing built for Syrian wholesale operations.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="/register"
            className="rounded-full bg-zinc-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-zinc-700"
          >
            Start onboarding
          </a>
          <a
            href="/login"
            className="rounded-full border border-zinc-300 px-6 py-3 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50"
          >
            Sign in
          </a>
        </div>
      </div>
    </main>
  );
}
