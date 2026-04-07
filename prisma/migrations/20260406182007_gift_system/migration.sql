-- AlterEnum
ALTER TYPE "PointTxType" ADD VALUE 'GIFT_RECEIVE';

-- CreateTable
CREATE TABLE "gifts" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "coin_cost" INTEGER NOT NULL,
    "display_image_url" TEXT NOT NULL,
    "effect_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_tags" (
    "id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "tag" VARCHAR(64) NOT NULL,

    CONSTRAINT "gift_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_galleries" (
    "id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_galleries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_gallery_sections" (
    "id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "gift_gallery_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_gallery_section_items" (
    "id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "gift_gallery_section_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_gallery_progress" (
    "id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "first_gifter_user_id" UUID NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_gallery_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_transactions" (
    "id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "receiver_user_id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "coin_cost" INTEGER NOT NULL,
    "points_awarded" INTEGER NOT NULL,
    "context" VARCHAR(32) NOT NULL DEFAULT 'direct',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fan_spend" (
    "id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "receiver_user_id" UUID NOT NULL,
    "period_type" VARCHAR(16) NOT NULL,
    "period_key" VARCHAR(16) NOT NULL,
    "coins_spent" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fan_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gifts_is_active_idx" ON "gifts"("is_active");

-- CreateIndex
CREATE INDEX "gift_tags_tag_idx" ON "gift_tags"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "gift_tags_gift_id_tag_key" ON "gift_tags"("gift_id", "tag");

-- CreateIndex
CREATE INDEX "gift_galleries_host_user_id_idx" ON "gift_galleries"("host_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_galleries_host_user_id_year_month_key" ON "gift_galleries"("host_user_id", "year", "month");

-- CreateIndex
CREATE INDEX "gift_gallery_sections_gallery_id_idx" ON "gift_gallery_sections"("gallery_id");

-- CreateIndex
CREATE INDEX "gift_gallery_section_items_gift_id_idx" ON "gift_gallery_section_items"("gift_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_gallery_section_items_section_id_gift_id_key" ON "gift_gallery_section_items"("section_id", "gift_id");

-- CreateIndex
CREATE INDEX "gift_gallery_progress_gallery_id_idx" ON "gift_gallery_progress"("gallery_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_gallery_progress_gallery_id_gift_id_key" ON "gift_gallery_progress"("gallery_id", "gift_id");

-- CreateIndex
CREATE INDEX "gift_transactions_sender_user_id_idx" ON "gift_transactions"("sender_user_id");

-- CreateIndex
CREATE INDEX "gift_transactions_receiver_user_id_idx" ON "gift_transactions"("receiver_user_id");

-- CreateIndex
CREATE INDEX "gift_transactions_created_at_idx" ON "gift_transactions"("created_at");

-- CreateIndex
CREATE INDEX "fan_spend_receiver_user_id_period_type_period_key_idx" ON "fan_spend"("receiver_user_id", "period_type", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "fan_spend_sender_user_id_receiver_user_id_period_type_perio_key" ON "fan_spend"("sender_user_id", "receiver_user_id", "period_type", "period_key");

-- AddForeignKey
ALTER TABLE "gift_tags" ADD CONSTRAINT "gift_tags_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_galleries" ADD CONSTRAINT "gift_galleries_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_gallery_sections" ADD CONSTRAINT "gift_gallery_sections_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "gift_galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_gallery_section_items" ADD CONSTRAINT "gift_gallery_section_items_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "gift_gallery_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_gallery_section_items" ADD CONSTRAINT "gift_gallery_section_items_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "gift_galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_first_gifter_user_id_fkey" FOREIGN KEY ("first_gifter_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_receiver_user_id_fkey" FOREIGN KEY ("receiver_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fan_spend" ADD CONSTRAINT "fan_spend_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fan_spend" ADD CONSTRAINT "fan_spend_receiver_user_id_fkey" FOREIGN KEY ("receiver_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
