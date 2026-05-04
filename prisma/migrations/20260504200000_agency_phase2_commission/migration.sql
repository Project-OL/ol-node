-- AlterEnum
ALTER TYPE "PointTxType" ADD VALUE 'AGENT_COMMISSION';
ALTER TYPE "PointTxType" ADD VALUE 'AGENT_POINT_TRANSFER';

-- CreateTable
CREATE TABLE "agency_commission_levels" (
    "level" VARCHAR(8) NOT NULL,
    "min_window_points" BIGINT NOT NULL,
    "live_rate_bp" INTEGER NOT NULL,
    "match_chat_rate_bp" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_commission_levels_pkey" PRIMARY KEY ("level")
);

-- Seed ladder (rates in basis points; 400 = 4%)
INSERT INTO "agency_commission_levels" ("level", "min_window_points", "live_rate_bp", "match_chat_rate_bp", "sort_order", "updated_at")
VALUES
  ('D', 0, 400, 400, 1, CURRENT_TIMESTAMP),
  ('C', 1500000, 800, 800, 2, CURRENT_TIMESTAMP),
  ('B', 7500000, 1200, 1200, 3, CURRENT_TIMESTAMP),
  ('A', 35000000, 1600, 1600, 4, CURRENT_TIMESTAMP),
  ('S', 100000000, 2000, 2000, 5, CURRENT_TIMESTAMP),
  ('SS+', 250000000, 2400, 2400, 6, CURRENT_TIMESTAMP);

-- CreateTable
CREATE TABLE "agency_daily_earnings" (
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "host_earnings_points" BIGINT NOT NULL DEFAULT 0,
    "host_commission_points" BIGINT NOT NULL DEFAULT 0,
    "host_was_active" BOOLEAN NOT NULL DEFAULT true,
    "last_credit_at" TIMESTAMP(3),

    CONSTRAINT "agency_daily_earnings_pkey" PRIMARY KEY ("agency_user_id","host_user_id","day")
);

CREATE INDEX "agency_daily_earnings_agency_user_id_day_idx" ON "agency_daily_earnings"("agency_user_id", "day" DESC);
CREATE INDEX "agency_daily_earnings_host_user_id_day_idx" ON "agency_daily_earnings"("host_user_id", "day" DESC);

ALTER TABLE "agency_daily_earnings" ADD CONSTRAINT "agency_daily_earnings_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agency_daily_earnings" ADD CONSTRAINT "agency_daily_earnings_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "agent_point_transfers" (
    "id" UUID NOT NULL,
    "sender_agent_user_id" UUID NOT NULL,
    "recipient_agent_user_id" UUID NOT NULL,
    "points" BIGINT NOT NULL,
    "sender_ledger_entry_id" UUID NOT NULL,
    "recipient_ledger_entry_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_point_transfers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_point_transfers_idempotency_key_key" ON "agent_point_transfers"("idempotency_key");
CREATE INDEX "agent_point_transfers_sender_agent_user_id_created_at_idx" ON "agent_point_transfers"("sender_agent_user_id", "created_at" DESC);
CREATE INDEX "agent_point_transfers_recipient_agent_user_id_created_at_idx" ON "agent_point_transfers"("recipient_agent_user_id", "created_at" DESC);

ALTER TABLE "agent_point_transfers" ADD CONSTRAINT "agent_point_transfers_sender_agent_user_id_fkey" FOREIGN KEY ("sender_agent_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_point_transfers" ADD CONSTRAINT "agent_point_transfers_recipient_agent_user_id_fkey" FOREIGN KEY ("recipient_agent_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
