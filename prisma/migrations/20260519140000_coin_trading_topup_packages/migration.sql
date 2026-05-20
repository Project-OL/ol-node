-- CreateTable
CREATE TABLE "coin_trading_topup_packages" (
    "id" UUID NOT NULL,
    "trading_coins" BIGINT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "coins_per_usd" INTEGER NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "label" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_trading_topup_packages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coin_trading_topup_packages_is_active_sort_order_idx" ON "coin_trading_topup_packages"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "coin_trading_topup_packages_trading_coins_price_cents_key" ON "coin_trading_topup_packages"("trading_coins", "price_cents");

-- AlterTable
ALTER TABLE "coin_trading_topup_orders" ADD COLUMN "package_id" UUID;

-- AddForeignKey
ALTER TABLE "coin_trading_topup_orders" ADD CONSTRAINT "coin_trading_topup_orders_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "coin_trading_topup_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
