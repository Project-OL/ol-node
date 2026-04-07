-- CreateEnum
CREATE TYPE "WalletCurrencyType" AS ENUM ('COIN', 'POINT');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "CoinTxType" AS ENUM ('TOPUP', 'GIFT_SEND', 'GIFT_REFUND', 'TRANSFER_OUT', 'TRANSFER_IN', 'VIP_PURCHASE', 'VIP_REWARD', 'DAILY_LOGIN', 'WEEKLY_TOPUP', 'PLATFORM_REWARD', 'EXPIRE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PointTxType" AS ENUM ('LIVESTREAM_GIFT', 'SUBSCRIPTION', 'COMMISSION', 'TRANSFER_IN', 'TRANSFER_OUT', 'MYSTERY_CHEST', 'PLATFORM_REWARD', 'WITHDRAWAL', 'WITHDRAWAL_REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'KYC_CHECK', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "coin_packages" (
    "id" UUID NOT NULL,
    "coins" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "label" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency_type" "WalletCurrencyType" NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_ledger_entries" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "tx_type" "CoinTxType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "ref_id" VARCHAR(255),
    "counterparty_id" UUID,
    "description" TEXT,
    "metadata" JSONB,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_ledger_entries" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "tx_type" "PointTxType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "ref_id" VARCHAR(255),
    "counterparty_id" UUID,
    "description" TEXT,
    "metadata" JSONB,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_topup_orders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "coins" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "gateway_ref" VARCHAR(256),
    "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "ledger_entry_id" UUID,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_topup_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount_points" BIGINT NOT NULL,
    "amount_fiat_cents" BIGINT,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "payout_ref" VARCHAR(256),
    "fail_reason" TEXT,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_idempotency_log" (
    "key" VARCHAR(200) NOT NULL,
    "request_hash" VARCHAR(128) NOT NULL,
    "response_snapshot" JSONB,
    "status" VARCHAR(50) NOT NULL DEFAULT 'PROCESSING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_idempotency_log_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "coin_packages_is_active_sort_order_idx" ON "coin_packages"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "coin_packages_coins_price_cents_key" ON "coin_packages"("coins", "price_cents");

-- CreateIndex
CREATE INDEX "wallets_user_id_idx" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_currency_type_key" ON "wallets"("user_id", "currency_type");

-- CreateIndex
CREATE UNIQUE INDEX "coin_ledger_entries_idempotency_key_key" ON "coin_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "coin_ledger_entries_wallet_id_created_at_idx" ON "coin_ledger_entries"("wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "coin_ledger_entries_wallet_id_tx_type_created_at_idx" ON "coin_ledger_entries"("wallet_id", "tx_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "coin_ledger_entries_idempotency_key_idx" ON "coin_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "point_ledger_entries_idempotency_key_key" ON "point_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "point_ledger_entries_wallet_id_created_at_idx" ON "point_ledger_entries"("wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "point_ledger_entries_wallet_id_tx_type_created_at_idx" ON "point_ledger_entries"("wallet_id", "tx_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "point_ledger_entries_idempotency_key_idx" ON "point_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "coin_topup_orders_gateway_ref_key" ON "coin_topup_orders"("gateway_ref");

-- CreateIndex
CREATE UNIQUE INDEX "coin_topup_orders_idempotency_key_key" ON "coin_topup_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "coin_topup_orders_user_id_created_at_idx" ON "coin_topup_orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_idempotency_key_key" ON "withdrawals"("idempotency_key");

-- CreateIndex
CREATE INDEX "withdrawals_user_id_status_idx" ON "withdrawals"("user_id", "status");

-- CreateIndex
CREATE INDEX "withdrawals_wallet_id_requested_at_idx" ON "withdrawals"("wallet_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "wallet_idempotency_log_expires_at_idx" ON "wallet_idempotency_log"("expires_at");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_ledger_entries" ADD CONSTRAINT "coin_ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_ledger_entries" ADD CONSTRAINT "point_ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_topup_orders" ADD CONSTRAINT "coin_topup_orders_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "coin_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
