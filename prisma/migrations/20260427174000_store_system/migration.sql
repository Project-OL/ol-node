-- CreateEnum
CREATE TYPE "StoreItemCategory" AS ENUM ('RIDE', 'AVATAR_FRAME', 'CHAT_BUBBLE', 'PROFILE_CARD');

-- AlterEnum
ALTER TYPE "CoinTxType" ADD VALUE 'STORE_ITEM_PURCHASE';

-- CreateTable
CREATE TABLE "store_items" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "category" "StoreItemCategory" NOT NULL,
    "coin_cost" INTEGER NOT NULL,
    "validity_days" INTEGER NOT NULL DEFAULT 15,
    "display_image_url" TEXT NOT NULL,
    "effect_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_store_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "store_item_id" UUID NOT NULL,
    "purchased_by_id" UUID NOT NULL,
    "coins_paid" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_applied" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "activated_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_store_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_active_store_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "StoreItemCategory" NOT NULL,
    "user_store_item_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_active_store_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_items_category_is_active_sort_order_idx" ON "store_items"("category", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "store_items_is_active_idx" ON "store_items"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "user_store_items_idempotency_key_key" ON "user_store_items"("idempotency_key");

-- CreateIndex
CREATE INDEX "user_store_items_user_id_is_applied_idx" ON "user_store_items"("user_id", "is_applied");

-- CreateIndex
CREATE INDEX "user_store_items_user_id_is_active_idx" ON "user_store_items"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "user_store_items_expires_at_is_active_idx" ON "user_store_items"("expires_at", "is_active");

-- CreateIndex
CREATE INDEX "user_store_items_store_item_id_idx" ON "user_store_items"("store_item_id");

-- CreateIndex
CREATE INDEX "user_active_store_items_user_id_idx" ON "user_active_store_items"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_active_store_items_user_id_category_key" ON "user_active_store_items"("user_id", "category");

-- AddForeignKey
ALTER TABLE "user_store_items" ADD CONSTRAINT "user_store_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_store_items" ADD CONSTRAINT "user_store_items_purchased_by_id_fkey" FOREIGN KEY ("purchased_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_store_items" ADD CONSTRAINT "user_store_items_store_item_id_fkey" FOREIGN KEY ("store_item_id") REFERENCES "store_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_active_store_items" ADD CONSTRAINT "user_active_store_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_active_store_items" ADD CONSTRAINT "user_active_store_items_user_store_item_id_fkey" FOREIGN KEY ("user_store_item_id") REFERENCES "user_store_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
