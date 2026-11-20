-- Epay integration (2026-11-20): pay-in tracking on both top-up order tables + Epay-to-Epay
-- payout attempts for platform-handled (EPAY) withdrawals. Additive only: new nullable or
-- defaulted columns and one new table. Both order tables were empty in prod on 2026-11-20.

-- AlterTable
ALTER TABLE "coin_topup_orders" ADD COLUMN     "epay_status" VARCHAR(10),
ADD COLUMN     "failure_reason" VARCHAR(255),
ADD COLUMN     "last_queried_at" TIMESTAMP(3),
ADD COLUMN     "merchant_order_no" VARCHAR(64),
ADD COLUMN     "paid_amount" DECIMAL(12,2),
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "paid_currency" VARCHAR(10),
ADD COLUMN     "payment_url" TEXT,
ADD COLUMN     "query_attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "coin_trading_topup_orders" ADD COLUMN     "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
ADD COLUMN     "epay_status" VARCHAR(10),
ADD COLUMN     "failure_reason" VARCHAR(255),
ADD COLUMN     "last_queried_at" TIMESTAMP(3),
ADD COLUMN     "merchant_order_no" VARCHAR(64),
ADD COLUMN     "paid_amount" DECIMAL(12,2),
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "paid_currency" VARCHAR(10),
ADD COLUMN     "payment_url" TEXT,
ADD COLUMN     "query_attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "epay_payout_orders" (
    "id" UUID NOT NULL,
    "withdrawal_id" UUID NOT NULL,
    "merchant_order_no" VARCHAR(64) NOT NULL,
    "epay_order_no" VARCHAR(64),
    "receive_epay_account" VARCHAR(255) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "status" VARCHAR(20) NOT NULL DEFAULT 'SUBMITTING',
    "epay_status" VARCHAR(10),
    "fee" DECIMAL(12,2),
    "failure_reason" VARCHAR(255),
    "requested_by_admin_id" VARCHAR(64),
    "submitted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_queried_at" TIMESTAMP(3),
    "query_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epay_payout_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "epay_payout_orders_merchant_order_no_key" ON "epay_payout_orders"("merchant_order_no");

-- CreateIndex
CREATE UNIQUE INDEX "epay_payout_orders_epay_order_no_key" ON "epay_payout_orders"("epay_order_no");

-- CreateIndex
CREATE INDEX "epay_payout_orders_withdrawal_id_idx" ON "epay_payout_orders"("withdrawal_id");

-- CreateIndex
CREATE INDEX "epay_payout_orders_status_created_at_idx" ON "epay_payout_orders"("status", "created_at");

-- Double-pay guard (not expressible in Prisma): at most ONE payout attempt per withdrawal that
-- is not FAILED. A retry is only possible after Epay reported the previous attempt as failed.
CREATE UNIQUE INDEX "epay_payout_orders_one_live_per_withdrawal" ON "epay_payout_orders"("withdrawal_id") WHERE "status" <> 'FAILED';

-- CreateIndex
CREATE UNIQUE INDEX "coin_topup_orders_merchant_order_no_key" ON "coin_topup_orders"("merchant_order_no");

-- CreateIndex
CREATE INDEX "coin_topup_orders_status_created_at_idx" ON "coin_topup_orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "coin_trading_topup_orders_merchant_order_no_key" ON "coin_trading_topup_orders"("merchant_order_no");
