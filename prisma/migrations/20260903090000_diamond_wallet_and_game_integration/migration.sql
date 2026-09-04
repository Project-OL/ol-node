-- CreateEnum
CREATE TYPE "DiamondConversionDirection" AS ENUM ('BUY', 'REDEEM');

-- CreateEnum
CREATE TYPE "GameSessionStatus" AS ENUM ('ISSUED', 'ACTIVE', 'EXPIRED');

-- AlterEnum
ALTER TYPE "WalletCurrencyType" ADD VALUE 'DIAMOND';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CoinTxType" ADD VALUE 'DIAMOND_PURCHASE_OUT';
ALTER TYPE "CoinTxType" ADD VALUE 'DIAMOND_PURCHASE_IN';
ALTER TYPE "CoinTxType" ADD VALUE 'DIAMOND_REDEEM_OUT';
ALTER TYPE "CoinTxType" ADD VALUE 'DIAMOND_REDEEM_IN';
ALTER TYPE "CoinTxType" ADD VALUE 'GAME_WAGER_OUT';
ALTER TYPE "CoinTxType" ADD VALUE 'GAME_WAGER_IN';
ALTER TYPE "CoinTxType" ADD VALUE 'GAME_RESULT_OUT';
ALTER TYPE "CoinTxType" ADD VALUE 'GAME_RESULT_IN';
ALTER TYPE "CoinTxType" ADD VALUE 'GAME_REFUND_OUT';
ALTER TYPE "CoinTxType" ADD VALUE 'GAME_REFUND_IN';
ALTER TYPE "CoinTxType" ADD VALUE 'GAME_ADJUSTMENT';

-- AlterEnum
ALTER TYPE "LedgerAccountRoleType" ADD VALUE 'GAME_HOUSE';

-- CreateTable
CREATE TABLE "diamond_conversions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "direction" "DiamondConversionDirection" NOT NULL,
    "coin_amount" BIGINT NOT NULL,
    "diamond_amount" BIGINT NOT NULL,
    "coin_ledger_entry_id" UUID NOT NULL,
    "diamond_ledger_entry_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diamond_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_providers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "channel" VARCHAR(100) NOT NULL,
    "app_id" VARCHAR(100) NOT NULL,
    "app_channel" VARCHAR(100) NOT NULL,
    "base_url" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_catalog_entries" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "game_id" INTEGER NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "preview_url" VARCHAR(500),
    "download_url" VARCHAR(500),
    "game_version" VARCHAR(30),
    "game_mode" INTEGER[],
    "orientation" INTEGER,
    "safe_height" INTEGER,
    "venue_level" INTEGER[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_catalog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "game_id" INTEGER NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "code_used_at" TIMESTAMP(3),
    "ss_token" VARCHAR(255),
    "ss_token_expires_at" TIMESTAMP(3),
    "room_id" VARCHAR(100),
    "status" "GameSessionStatus" NOT NULL DEFAULT 'ISSUED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_round_ledger_links" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "order_id" VARCHAR(255) NOT NULL,
    "game_id" INTEGER NOT NULL,
    "room_id" VARCHAR(100),
    "diff_msg" VARCHAR(20) NOT NULL,
    "user_id" UUID NOT NULL,
    "currency_diff" BIGINT NOT NULL,
    "user_ledger_entry_id" UUID NOT NULL,
    "house_ledger_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_round_ledger_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diamond_conversions_idempotency_key_key" ON "diamond_conversions"("idempotency_key");

-- CreateIndex
CREATE INDEX "diamond_conversions_user_id_created_at_idx" ON "diamond_conversions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "diamond_conversions_coin_ledger_entry_id_key" ON "diamond_conversions"("coin_ledger_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_conversions_diamond_ledger_entry_id_key" ON "diamond_conversions"("diamond_ledger_entry_id");

-- CreateIndex
CREATE INDEX "game_providers_is_active_idx" ON "game_providers"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "game_providers_code_channel_key" ON "game_providers"("code", "channel");

-- CreateIndex
CREATE INDEX "game_catalog_entries_provider_id_is_active_idx" ON "game_catalog_entries"("provider_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "game_catalog_entries_provider_id_game_id_key" ON "game_catalog_entries"("provider_id", "game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_sessions_code_key" ON "game_sessions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "game_sessions_ss_token_key" ON "game_sessions"("ss_token");

-- CreateIndex
CREATE INDEX "game_sessions_user_id_created_at_idx" ON "game_sessions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "game_sessions_status_ss_token_expires_at_idx" ON "game_sessions"("status", "ss_token_expires_at");

-- CreateIndex
CREATE INDEX "game_round_ledger_links_user_id_created_at_idx" ON "game_round_ledger_links"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "game_round_ledger_links_provider_id_order_id_key" ON "game_round_ledger_links"("provider_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_round_ledger_links_user_ledger_entry_id_key" ON "game_round_ledger_links"("user_ledger_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_round_ledger_links_house_ledger_entry_id_key" ON "game_round_ledger_links"("house_ledger_entry_id");

-- AddForeignKey
ALTER TABLE "diamond_conversions" ADD CONSTRAINT "diamond_conversions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_conversions" ADD CONSTRAINT "diamond_conversions_coin_ledger_entry_id_fkey" FOREIGN KEY ("coin_ledger_entry_id") REFERENCES "coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_conversions" ADD CONSTRAINT "diamond_conversions_diamond_ledger_entry_id_fkey" FOREIGN KEY ("diamond_ledger_entry_id") REFERENCES "coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_catalog_entries" ADD CONSTRAINT "game_catalog_entries_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "game_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "game_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_round_ledger_links" ADD CONSTRAINT "game_round_ledger_links_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "game_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_round_ledger_links" ADD CONSTRAINT "game_round_ledger_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_round_ledger_links" ADD CONSTRAINT "game_round_ledger_links_user_ledger_entry_id_fkey" FOREIGN KEY ("user_ledger_entry_id") REFERENCES "coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_round_ledger_links" ADD CONSTRAINT "game_round_ledger_links_house_ledger_entry_id_fkey" FOREIGN KEY ("house_ledger_entry_id") REFERENCES "coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

