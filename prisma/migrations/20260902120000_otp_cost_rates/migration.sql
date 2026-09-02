-- Per-country OTP cost override (WhatsApp/SMS pricing varies by destination country).
-- No row for a (means, country) pair falls back to the global OTP_COST_WHATSAPP_MINOR /
-- OTP_COST_SMS_MINOR env default.
CREATE TABLE "otp_cost_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "means" VARCHAR(20) NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "rate_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "otp_cost_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "otp_cost_rates_means_country_key" ON "otp_cost_rates"("means", "country");
