-- Singleton config for phone OTP WhatsApp→SMS routing window.
CREATE TABLE "otp_delivery_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "sms_trigger_interval_sec" INTEGER NOT NULL DEFAULT 120,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" UUID,

    CONSTRAINT "otp_delivery_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "otp_delivery_config" ("id", "sms_trigger_interval_sec", "updated_at")
VALUES (1, 120, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
