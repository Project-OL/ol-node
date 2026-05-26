CREATE TABLE "withdrawal_payout_rail_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "epay_fee_rate_bp" INTEGER NOT NULL DEFAULT 600,
    "epay_arrival_time" VARCHAR(200) NOT NULL DEFAULT 'Within 24 hours',
    "bank_fee_rate_bp" INTEGER NOT NULL DEFAULT 600,
    "bank_arrival_time" VARCHAR(200) NOT NULL DEFAULT '3-5 business days',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" UUID,

    CONSTRAINT "withdrawal_payout_rail_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "withdrawal_payout_rail_config" ("id", "updated_at")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
