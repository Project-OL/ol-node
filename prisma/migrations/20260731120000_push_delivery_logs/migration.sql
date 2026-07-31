-- FCM push delivery audit (per-recipient sent / failed / skipped)
CREATE TYPE "PushDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');
CREATE TYPE "PushDeliverySource" AS ENUM ('ADMIN_SINGLE', 'ADMIN_BROADCAST', 'TRANSACTION', 'NEW_MESSAGE');

CREATE TABLE "push_delivery_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "admin_user_id" UUID,
    "source" "PushDeliverySource" NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL,
    "campaign_id" VARCHAR(128),
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "data" JSONB,
    "error_code" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_delivery_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "push_delivery_logs_created_at_idx" ON "push_delivery_logs"("created_at" DESC);
CREATE INDEX "push_delivery_logs_status_created_at_idx" ON "push_delivery_logs"("status", "created_at" DESC);
CREATE INDEX "push_delivery_logs_source_created_at_idx" ON "push_delivery_logs"("source", "created_at" DESC);
CREATE INDEX "push_delivery_logs_user_id_created_at_idx" ON "push_delivery_logs"("user_id", "created_at" DESC);
CREATE INDEX "push_delivery_logs_campaign_id_idx" ON "push_delivery_logs"("campaign_id");

ALTER TABLE "push_delivery_logs" ADD CONSTRAINT "push_delivery_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
