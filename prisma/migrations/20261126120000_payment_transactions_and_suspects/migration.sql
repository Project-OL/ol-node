-- Payment transaction list + suspect list (2026-11-26). Additive only: two new enums, two new
-- tables, one new value on ModerationNotificationType, and a backfill of the Epay purchases and
-- payouts that already happened (staging only; prod Epay is off, so prod copies nothing).
-- Live-server does not map these tables or enums.

-- AlterEnum
ALTER TYPE "ModerationNotificationType" ADD VALUE 'PAYMENT_REFUND_SUSPENSION';

-- CreateEnum
CREATE TYPE "PaymentChannel" AS ENUM ('EPAY', 'GOOGLE_PLAY', 'APPLE');

-- CreateEnum
CREATE TYPE "PaymentTxnKind" AS ENUM ('PURCHASE', 'REFUND', 'PAYOUT', 'PAYOUT_REVERSAL');

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "channel" "PaymentChannel" NOT NULL,
    "kind" "PaymentTxnKind" NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "external_id" VARCHAR(128) NOT NULL,
    "provider_ref" VARCHAR(128),
    "parent_id" UUID,
    "user_id" UUID NOT NULL,
    "wallet_currency" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "units" BIGINT,
    "source_table" VARCHAR(64),
    "source_id" UUID,
    "ledger_entry_id" UUID,
    "reason" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "actions_done_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_suspects" (
    "id" UUID NOT NULL,
    "identity_type" VARCHAR(16) NOT NULL,
    "identity_value" VARCHAR(255) NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "source_txn_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "hit_count" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "last_flagged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_at" TIMESTAMP(3),
    "cleared_by_admin_id" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_suspects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_channel_kind_external_id_key" ON "payment_transactions"("channel", "kind", "external_id");

-- CreateIndex
CREATE INDEX "payment_transactions_user_id_occurred_at_idx" ON "payment_transactions"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "payment_transactions_channel_occurred_at_idx" ON "payment_transactions"("channel", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "payment_transactions_kind_occurred_at_idx" ON "payment_transactions"("kind", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "payment_transactions_parent_id_idx" ON "payment_transactions"("parent_id");

-- CreateIndex
CREATE INDEX "payment_transactions_source_table_source_id_idx" ON "payment_transactions"("source_table", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_suspects_identity_type_identity_value_key" ON "payment_suspects"("identity_type", "identity_value");

-- CreateIndex
CREATE INDEX "payment_suspects_status_last_flagged_at_idx" ON "payment_suspects"("status", "last_flagged_at" DESC);

-- CreateIndex
CREATE INDEX "payment_suspects_user_id_idx" ON "payment_suspects"("user_id");

-- Backfill: Epay purchases already credited (personal top-ups PAID, trading top-ups COMPLETED).
INSERT INTO "payment_transactions" (
    "id", "channel", "kind", "status", "external_id", "provider_ref", "user_id", "wallet_currency",
    "amount", "currency", "units", "source_table", "source_id", "ledger_entry_id", "occurred_at",
    "updated_at")
SELECT gen_random_uuid(), 'EPAY', 'PURCHASE', 'SUCCEEDED', o."merchant_order_no", o."gateway_ref",
       o."user_id", 'COIN', COALESCE(o."paid_amount", o."price_cents" / 100.0),
       COALESCE(o."paid_currency", o."currency"), o."coins", 'coin_topup_orders', o."id",
       o."ledger_entry_id", COALESCE(o."paid_at", o."updated_at"), CURRENT_TIMESTAMP
FROM "coin_topup_orders" o
WHERE o."merchant_order_no" IS NOT NULL AND o."status" IN ('PAID', 'COMPLETED')
ON CONFLICT DO NOTHING;

INSERT INTO "payment_transactions" (
    "id", "channel", "kind", "status", "external_id", "provider_ref", "user_id", "wallet_currency",
    "amount", "currency", "units", "source_table", "source_id", "ledger_entry_id", "occurred_at",
    "updated_at")
SELECT gen_random_uuid(), 'EPAY', 'PURCHASE', 'SUCCEEDED', o."merchant_order_no", o."epay_ref",
       o."agent_user_id", 'TRADING_COIN', COALESCE(o."paid_amount", o."amount_usd"),
       COALESCE(o."paid_currency", o."currency"), o."trading_coins_awarded",
       'coin_trading_topup_orders', o."id", o."ledger_entry_id",
       COALESCE(o."paid_at", o."updated_at"), CURRENT_TIMESTAMP
FROM "coin_trading_topup_orders" o
WHERE o."merchant_order_no" IS NOT NULL AND o."status" = 'COMPLETED'
ON CONFLICT DO NOTHING;

-- Backfill: Epay payouts that succeeded.
INSERT INTO "payment_transactions" (
    "id", "channel", "kind", "status", "external_id", "provider_ref", "user_id", "wallet_currency",
    "amount", "currency", "units", "source_table", "source_id", "occurred_at", "metadata",
    "updated_at")
SELECT gen_random_uuid(), 'EPAY', 'PAYOUT', 'SUCCEEDED', p."merchant_order_no", p."epay_order_no",
       w."user_id", 'POINT', p."amount", p."currency", w."amount_points", 'epay_payout_orders',
       p."id", COALESCE(p."completed_at", p."updated_at"),
       jsonb_build_object('withdrawalId', p."withdrawal_id", 'fee', p."fee",
                          'receiveEpayAccount', p."receive_epay_account"),
       CURRENT_TIMESTAMP
FROM "epay_payout_orders" p
JOIN "withdrawals" w ON w."id" = p."withdrawal_id"
WHERE p."status" = 'SUCCESS'
ON CONFLICT DO NOTHING;
