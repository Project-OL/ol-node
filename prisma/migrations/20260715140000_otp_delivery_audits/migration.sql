-- Durable OTP generation/delivery audit for admin portal.
CREATE TABLE "otp_delivery_audits" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "purpose" VARCHAR(50) NOT NULL,
    "means" VARCHAR(20) NOT NULL,
    "provider" VARCHAR(40),
    "status" VARCHAR(20) NOT NULL,
    "target_type" VARCHAR(20) NOT NULL,
    "target_masked" VARCHAR(255) NOT NULL,
    "charge_minor" INTEGER NOT NULL DEFAULT 0,
    "charge_currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "provider_message_id" VARCHAR(255),
    "fallback_from" VARCHAR(40),
    "route_reason" VARCHAR(60),
    "error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_delivery_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "otp_delivery_audits_created_at_idx" ON "otp_delivery_audits"("created_at" DESC);
CREATE INDEX "otp_delivery_audits_purpose_created_at_idx" ON "otp_delivery_audits"("purpose", "created_at" DESC);
CREATE INDEX "otp_delivery_audits_means_created_at_idx" ON "otp_delivery_audits"("means", "created_at" DESC);
CREATE INDEX "otp_delivery_audits_status_created_at_idx" ON "otp_delivery_audits"("status", "created_at" DESC);
CREATE INDEX "otp_delivery_audits_user_id_created_at_idx" ON "otp_delivery_audits"("user_id", "created_at" DESC);

ALTER TABLE "otp_delivery_audits"
ADD CONSTRAINT "otp_delivery_audits_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
