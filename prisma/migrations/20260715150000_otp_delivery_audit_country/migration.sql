-- Country attribution for OTP delivery cost reports (phone ISO2 or users.country).
ALTER TABLE "otp_delivery_audits" ADD COLUMN "country" VARCHAR(100);

CREATE INDEX "otp_delivery_audits_country_created_at_idx"
ON "otp_delivery_audits"("country", "created_at" DESC);
