/*
  Warnings:

  - You are about to drop the column `priceUSD` on the `ProductUnit` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[invoiceId]` on the table `CustomerPayment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[systemCustomerId]` on the table `Tenant` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `priceWholesale` to the `ProductUnit` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PricingCurrency" AS ENUM ('USD', 'SYP');

-- CreateEnum
CREATE TYPE "BarcodeSource" AS ENUM ('GS1', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "isSystemGenerated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CustomerPayment" ADD COLUMN     "invoiceId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "receiptPdfUrl" TEXT;

-- AlterTable
ALTER TABLE "ProductUnit" DROP COLUMN "priceUSD",
ADD COLUMN     "barcodeSource" "BarcodeSource",
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "priceRetail" DECIMAL(18,4),
ADD COLUMN     "priceWholesale" DECIMAL(18,4) NOT NULL,
ADD COLUMN     "pricingCurrency" "PricingCurrency" NOT NULL DEFAULT 'SYP';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "systemCustomerId" TEXT;

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
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Customer_tenantId_isSystemGenerated_idx" ON "Customer"("tenantId", "isSystemGenerated");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPayment_invoiceId_key" ON "CustomerPayment"("invoiceId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_createdAt_idx" ON "Invoice"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductBatch_tenantId_quantity_idx" ON "ProductBatch"("tenantId", "quantity");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_systemCustomerId_key" ON "Tenant"("systemCustomerId");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_systemCustomerId_fkey" FOREIGN KEY ("systemCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCatalogEntryReport" ADD CONSTRAINT "ProductCatalogEntryReport_catalogEntryId_fkey" FOREIGN KEY ("catalogEntryId") REFERENCES "ProductCatalogEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
