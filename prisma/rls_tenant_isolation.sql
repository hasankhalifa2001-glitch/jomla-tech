-- Row-Level Security: tenant isolation
-- Run this AFTER `npx prisma db push` / `prisma migrate dev` since Prisma's
-- schema language has no RLS syntax.
--
-- How it works: every request must SET app.current_tenant_id at the start
-- of the request (see the application-side snippet at the bottom of this
-- file). Postgres then silently filters every row to that tenant, even if
-- a query in application code forgets a `where: { tenantId }` clause.
--
-- Superusers and table owners bypass RLS by default — make sure the role
-- your app connects with (DATABASE_URL) is NOT a superuser in production.

ALTER TABLE "User"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductUnit"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductBatch"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceItem"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerPayment"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription"     ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_user ON "User"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation_product ON "Product"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

-- NEW: ProductUnit and ProductBatch now carry a direct tenantId column
-- (added alongside the schema's per-tenant barcode uniqueness), so they can
-- be isolated directly instead of only transitively through Product.
CREATE POLICY tenant_isolation_product_unit ON "ProductUnit"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation_product_batch ON "ProductBatch"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation_customer ON "Customer"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation_invoice ON "Invoice"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

-- NEW: InvoiceItem now carries a direct tenantId column too.
CREATE POLICY tenant_isolation_invoice_item ON "InvoiceItem"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation_payment ON "CustomerPayment"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation_subscription ON "Subscription"
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

-- ---------------------------------------------------------------------
-- Application side: set this once per request, before any query, using
-- the tenantId from the authenticated session (NextAuth JWT claim).
-- Example with Prisma's $executeRaw in a request-scoped client:
--
--   await prisma.$executeRawUnsafe(
--     `SET app.current_tenant_id = '${session.tenantId}'`
--   );
--
-- Prefer a parameterized helper over string interpolation in real code —
-- this is illustrative only. With Prisma, this is easiest wired as a
-- middleware/extension that runs on every request before the first query.
--
-- NOTE: the public storefront (T5) and the /api/store/orders endpoint read
-- Product/ProductUnit/ProductBatch data WITHOUT an authenticated session
-- (a retailer browsing tenant.domain.com never logs in). That code path
-- must still SET app.current_tenant_id — resolved from the tenantSlug in
-- the URL, not from a JWT — before querying, or RLS will simply return
-- zero rows to it.
