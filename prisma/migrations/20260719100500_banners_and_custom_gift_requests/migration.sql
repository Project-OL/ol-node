-- Home banner slider (admin-managed, status derived from enabled + start/end window)
CREATE TABLE "banners" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "image_url" TEXT NOT NULL,
    "position" VARCHAR(100) NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "banners_enabled_start_at_end_at_idx" ON "banners"("enabled", "start_at", "end_at");
CREATE INDEX "banners_position_idx" ON "banners"("position");
CREATE INDEX "banners_created_at_idx" ON "banners"("created_at" DESC);

-- Custom gift requests (user pays configured coin cost; CS reaches out on WhatsApp)
CREATE TYPE "CustomGiftRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

CREATE TABLE "custom_gift_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "coin_cost" BIGINT NOT NULL DEFAULT 100000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_admin_id" UUID,

    CONSTRAINT "custom_gift_config_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "custom_gift_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "whatsapp_number" VARCHAR(32) NOT NULL,
    "note" TEXT,
    "coin_cost" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "status" "CustomGiftRequestStatus" NOT NULL DEFAULT 'PENDING',
    "gift_id" UUID,
    "admin_note" TEXT,
    "failure_reason" TEXT,
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "refund_ledger_entry_id" UUID,
    "resolved_by_admin_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_gift_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_gift_requests_ledger_entry_id_key" ON "custom_gift_requests"("ledger_entry_id");
CREATE INDEX "custom_gift_requests_user_id_created_at_idx" ON "custom_gift_requests"("user_id", "created_at" DESC);
CREATE INDEX "custom_gift_requests_status_created_at_idx" ON "custom_gift_requests"("status", "created_at" DESC);

-- One PENDING request per user (partial unique; race backstop for the 409 pre-check)
CREATE UNIQUE INDEX "custom_gift_requests_one_pending_per_user"
    ON "custom_gift_requests"("user_id") WHERE "status" = 'PENDING';

ALTER TABLE "custom_gift_requests"
    ADD CONSTRAINT "custom_gift_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "custom_gift_requests"
    ADD CONSTRAINT "custom_gift_requests_ledger_entry_id_fkey"
    FOREIGN KEY ("ledger_entry_id") REFERENCES "coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custom_gift_requests"
    ADD CONSTRAINT "custom_gift_requests_refund_ledger_entry_id_fkey"
    FOREIGN KEY ("refund_ledger_entry_id") REFERENCES "coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custom_gift_requests"
    ADD CONSTRAINT "custom_gift_requests_gift_id_fkey"
    FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
