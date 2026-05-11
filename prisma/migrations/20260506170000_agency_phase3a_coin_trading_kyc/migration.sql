-- Phase 3a: agency KYC + trading coin domain
ALTER TYPE "WalletCurrencyType" ADD VALUE IF NOT EXISTS 'TRADING_COIN';

ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'TRADING_TOPUP';
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'TRADING_TRANSFER_OUT';
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'TRADING_TRANSFER_IN';
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'TRADING_EXCHANGE_FROM_POINTS';
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'TRADING_TRANSFER_REVERSAL';

CREATE TABLE IF NOT EXISTS "agency_application_kyc" (
  "user_id" UUID PRIMARY KEY,
  "ticket_public_id" VARCHAR(255),
  "govt_id_s3_key" VARCHAR(255),
  "govt_id_s3_bucket" VARCHAR(255),
  "govt_id_submitted_at" TIMESTAMP(3),
  "contact_phone" VARCHAR(20),
  "contact_email" VARCHAR(255),
  "contact_submitted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agency_application_kyc_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agency_application_kyc_ticket_public_id_fkey"
    FOREIGN KEY ("ticket_public_id") REFERENCES "support_tickets"("public_id")
    ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "agency_application_kyc_ticket_public_id_idx"
  ON "agency_application_kyc"("ticket_public_id");

CREATE TABLE IF NOT EXISTS "coin_trading_topup_orders" (
  "id" UUID PRIMARY KEY,
  "agent_user_id" UUID NOT NULL,
  "amount_usd" DECIMAL(12,2) NOT NULL,
  "trading_coins_awarded" BIGINT NOT NULL,
  "rate_applied" INTEGER NOT NULL,
  "epay_ref" VARCHAR(256),
  "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  "ledger_entry_id" UUID,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "coin_trading_topup_orders_agent_user_id_fkey"
    FOREIGN KEY ("agent_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "coin_trading_topup_orders_epay_ref_key"
  ON "coin_trading_topup_orders"("epay_ref");
CREATE UNIQUE INDEX IF NOT EXISTS "coin_trading_topup_orders_idempotency_key_key"
  ON "coin_trading_topup_orders"("idempotency_key");
CREATE INDEX IF NOT EXISTS "coin_trading_topup_orders_agent_user_id_created_at_idx"
  ON "coin_trading_topup_orders"("agent_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "coin_trading_topup_orders_status_created_at_idx"
  ON "coin_trading_topup_orders"("status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "coin_trading_transfers" (
  "id" UUID PRIMARY KEY,
  "sender_agent_user_id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "trading_coins_debited" BIGINT NOT NULL,
  "coins_credited" BIGINT NOT NULL,
  "recipient_wallet_type" VARCHAR(20) NOT NULL,
  "sender_ledger_entry_id" UUID NOT NULL,
  "recipient_ledger_entry_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "reversed_at" TIMESTAMP(3),
  "reversed_by_user_id" UUID,
  "reverse_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coin_trading_transfers_sender_agent_user_id_fkey"
    FOREIGN KEY ("sender_agent_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coin_trading_transfers_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coin_trading_transfers_reversed_by_user_id_fkey"
    FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "coin_trading_transfers_idempotency_key_key"
  ON "coin_trading_transfers"("idempotency_key");
CREATE INDEX IF NOT EXISTS "coin_trading_transfers_sender_agent_user_id_created_at_idx"
  ON "coin_trading_transfers"("sender_agent_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "coin_trading_transfers_recipient_user_id_created_at_idx"
  ON "coin_trading_transfers"("recipient_user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "coin_trading_topup_rates" (
  "id" UUID PRIMARY KEY,
  "min_usd" DECIMAL(12,2) NOT NULL,
  "max_usd" DECIMAL(12,2),
  "coins_per_usd" INTEGER NOT NULL,
  "sort_order" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "coin_trading_topup_rates_is_active_sort_order_idx"
  ON "coin_trading_topup_rates"("is_active", "sort_order");

CREATE TABLE IF NOT EXISTS "agent_exchange_rates" (
  "id" UUID PRIMARY KEY,
  "min_usd_equiv" DECIMAL(12,2) NOT NULL,
  "max_usd_equiv" DECIMAL(12,2),
  "coins_per_usd" INTEGER NOT NULL,
  "sort_order" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "agent_exchange_rates_is_active_sort_order_idx"
  ON "agent_exchange_rates"("is_active", "sort_order");
