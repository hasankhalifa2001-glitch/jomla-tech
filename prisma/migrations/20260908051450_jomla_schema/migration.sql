-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'CASHIER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('COMPLETED', 'PENDING_REVIEW', 'VOIDED');

-- CreateEnum
CREATE TYPE "TenantSubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'PENDING');

-- CreateEnum
CREATE TYPE "SubscriptionRecordStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'SHAM_CASH', 'SYRIATEL_CASH', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "PricingCurrency" AS ENUM ('USD', 'SYP');

-- CreateEnum
CREATE TYPE "BarcodeSource" AS ENUM ('GS1', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "B2BOrderStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "phone" TEXT,
    "dailyExchangeRate" DECIMAL(18,4),
    "subscriptionStatus" "TenantSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "systemCustomerId" TEXT,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductUnit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitName" TEXT NOT NULL,
    "conversionFactor" DECIMAL(18,4) NOT NULL,
    "pricingCurrency" "PricingCurrency" NOT NULL DEFAULT 'SYP',
    "priceWholesale" DECIMAL(18,4) NOT NULL,
    "priceRetail" DECIMAL(18,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "barcode" TEXT,
    "barcodeSource" "BarcodeSource",

    CONSTRAINT "ProductUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "shopName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isSystemGenerated" BOOLEAN NOT NULL DEFAULT false,
    "offlineId" TEXT,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerifiedRetailer" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "shopName" TEXT,
    "firstVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificationCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "VerifiedRetailer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCatalogEntry" (
    "id" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "imageUrl" TEXT,
    "addedByTenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCatalogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCatalogEntryReport" (
    "id" TEXT NOT NULL,
    "catalogEntryId" TEXT NOT NULL,
    "reportedByTenantId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "suggestedName" TEXT,
    "suggestedCategory" TEXT,
    "suggestedImageUrl" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ProductCatalogEntryReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "totalSYP" DECIMAL(18,4) NOT NULL,
    "totalUSD" DECIMAL(18,4) NOT NULL,
    "exchangeRateUsed" DECIMAL(18,4) NOT NULL,
    "paidAmountSYP" DECIMAL(18,4) NOT NULL,
    "paidAmountUSD" DECIMAL(18,4) NOT NULL,
    "debtAmountSYP" DECIMAL(18,4) NOT NULL,
    "debtAmountUSD" DECIMAL(18,4) NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'COMPLETED',
    "isSynced" BOOLEAN NOT NULL DEFAULT true,
    "offlineId" TEXT,
    "syncedAt" TIMESTAMP(3),
    "receiptPdfUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidsInvoiceId" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPriceSYP" DECIMAL(18,4) NOT NULL,
    "unitPriceUSD" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amountSYP" DECIMAL(18,4) NOT NULL,
    "amountUSD" DECIMAL(18,4) NOT NULL,
    "exchangeRate" DECIMAL(18,4) NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "receiptNo" TEXT,
    "notes" TEXT,
    "isSynced" BOOLEAN NOT NULL DEFAULT true,
    "offlineId" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT,

    CONSTRAINT "CustomerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "receiptImageURL" TEXT,
    "amountUSD" DECIMAL(18,4) NOT NULL,
    "referenceCode" TEXT NOT NULL,
    "status" "SubscriptionRecordStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B2BOrderRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "retailerName" TEXT NOT NULL,
    "retailerPhone" TEXT NOT NULL,
    "retailerShopName" TEXT,
    "status" "B2BOrderStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "rejectionReason" TEXT,
    "matchedCustomerId" TEXT,
    "resultingInvoiceId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B2BOrderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B2BOrderRequestItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderRequestId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "priceWholesaleSnapshot" DECIMAL(18,4) NOT NULL,
    "pricingCurrencySnapshot" "PricingCurrency" NOT NULL,

    CONSTRAINT "B2BOrderRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMergeLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "survivingCustomerId" TEXT NOT NULL,
    "mergedCustomerId" TEXT NOT NULL,
    "performedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerMergeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_systemCustomerId_key" ON "Tenant"("systemCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE INDEX "Product_tenantId_idx" ON "Product"("tenantId");

-- CreateIndex
CREATE INDEX "Product_tenantId_isPublic_idx" ON "Product"("tenantId", "isPublic");

-- CreateIndex
CREATE INDEX "ProductUnit_tenantId_idx" ON "ProductUnit"("tenantId");

-- CreateIndex
CREATE INDEX "ProductUnit_productId_idx" ON "ProductUnit"("productId");

-- CreateIndex
CREATE INDEX "ProductUnit_tenantId_isActive_idx" ON "ProductUnit"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ProductUnit_tenantId_barcode_key" ON "ProductUnit"("tenantId", "barcode");

-- CreateIndex
CREATE INDEX "ProductBatch_tenantId_idx" ON "ProductBatch"("tenantId");

-- CreateIndex
CREATE INDEX "ProductBatch_productId_idx" ON "ProductBatch"("productId");

-- CreateIndex
CREATE INDEX "ProductBatch_unitId_idx" ON "ProductBatch"("unitId");

-- CreateIndex
CREATE INDEX "ProductBatch_expiryDate_idx" ON "ProductBatch"("expiryDate");

-- CreateIndex
CREATE INDEX "ProductBatch_tenantId_quantity_idx" ON "ProductBatch"("tenantId", "quantity");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_offlineId_key" ON "Customer"("offlineId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_idx" ON "Customer"("tenantId");

-- CreateIndex
CREATE INDEX "Customer_offlineId_idx" ON "Customer"("offlineId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_phone_idx" ON "Customer"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "Customer_tenantId_isSystemGenerated_idx" ON "Customer"("tenantId", "isSystemGenerated");

-- CreateIndex
CREATE UNIQUE INDEX "VerifiedRetailer_phone_key" ON "VerifiedRetailer"("phone");

-- CreateIndex
CREATE INDEX "VerifiedRetailer_phone_idx" ON "VerifiedRetailer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCatalogEntry_barcode_key" ON "ProductCatalogEntry"("barcode");

-- CreateIndex
CREATE INDEX "ProductCatalogEntry_barcode_idx" ON "ProductCatalogEntry"("barcode");

-- CreateIndex
CREATE INDEX "ProductCatalogEntry_addedByTenantId_idx" ON "ProductCatalogEntry"("addedByTenantId");

-- CreateIndex
CREATE INDEX "ProductCatalogEntryReport_catalogEntryId_idx" ON "ProductCatalogEntryReport"("catalogEntryId");

-- CreateIndex
CREATE INDEX "ProductCatalogEntryReport_status_idx" ON "ProductCatalogEntryReport"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_offlineId_key" ON "Invoice"("offlineId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_voidsInvoiceId_key" ON "Invoice"("voidsInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_idx" ON "Invoice"("tenantId");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "Invoice_offlineId_idx" ON "Invoice"("offlineId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_createdAt_idx" ON "Invoice"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "InvoiceItem_tenantId_idx" ON "InvoiceItem"("tenantId");

-- CreateIndex
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceItem_batchId_idx" ON "InvoiceItem"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPayment_offlineId_key" ON "CustomerPayment"("offlineId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPayment_invoiceId_key" ON "CustomerPayment"("invoiceId");

-- CreateIndex
CREATE INDEX "CustomerPayment_tenantId_idx" ON "CustomerPayment"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerPayment_customerId_idx" ON "CustomerPayment"("customerId");

-- CreateIndex
CREATE INDEX "CustomerPayment_offlineId_idx" ON "CustomerPayment"("offlineId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_referenceCode_key" ON "Subscription"("referenceCode");

-- CreateIndex
CREATE INDEX "Subscription_tenantId_status_idx" ON "Subscription"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE UNIQUE INDEX "B2BOrderRequest_resultingInvoiceId_key" ON "B2BOrderRequest"("resultingInvoiceId");

-- CreateIndex
CREATE INDEX "B2BOrderRequest_tenantId_idx" ON "B2BOrderRequest"("tenantId");

-- CreateIndex
CREATE INDEX "B2BOrderRequest_tenantId_status_idx" ON "B2BOrderRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "B2BOrderRequest_tenantId_retailerPhone_status_idx" ON "B2BOrderRequest"("tenantId", "retailerPhone", "status");

-- CreateIndex
CREATE INDEX "B2BOrderRequestItem_tenantId_idx" ON "B2BOrderRequestItem"("tenantId");

-- CreateIndex
CREATE INDEX "B2BOrderRequestItem_orderRequestId_idx" ON "B2BOrderRequestItem"("orderRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMergeLog_mergedCustomerId_key" ON "CustomerMergeLog"("mergedCustomerId");

-- CreateIndex
CREATE INDEX "CustomerMergeLog_tenantId_idx" ON "CustomerMergeLog"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerMergeLog_survivingCustomerId_idx" ON "CustomerMergeLog"("survivingCustomerId");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_systemCustomerId_fkey" FOREIGN KEY ("systemCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "ProductUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCatalogEntryReport" ADD CONSTRAINT "ProductCatalogEntryReport_catalogEntryId_fkey" FOREIGN KEY ("catalogEntryId") REFERENCES "ProductCatalogEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_voidsInvoiceId_fkey" FOREIGN KEY ("voidsInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "ProductUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ProductBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2BOrderRequest" ADD CONSTRAINT "B2BOrderRequest_matchedCustomerId_fkey" FOREIGN KEY ("matchedCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2BOrderRequest" ADD CONSTRAINT "B2BOrderRequest_resultingInvoiceId_fkey" FOREIGN KEY ("resultingInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2BOrderRequest" ADD CONSTRAINT "B2BOrderRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2BOrderRequest" ADD CONSTRAINT "B2BOrderRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2BOrderRequestItem" ADD CONSTRAINT "B2BOrderRequestItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2BOrderRequestItem" ADD CONSTRAINT "B2BOrderRequestItem_orderRequestId_fkey" FOREIGN KEY ("orderRequestId") REFERENCES "B2BOrderRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2BOrderRequestItem" ADD CONSTRAINT "B2BOrderRequestItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2BOrderRequestItem" ADD CONSTRAINT "B2BOrderRequestItem_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "ProductUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMergeLog" ADD CONSTRAINT "CustomerMergeLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMergeLog" ADD CONSTRAINT "CustomerMergeLog_survivingCustomerId_fkey" FOREIGN KEY ("survivingCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMergeLog" ADD CONSTRAINT "CustomerMergeLog_mergedCustomerId_fkey" FOREIGN KEY ("mergedCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMergeLog" ADD CONSTRAINT "CustomerMergeLog_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
