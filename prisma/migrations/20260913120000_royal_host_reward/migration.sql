-- AlterEnum
ALTER TYPE "PointTxType" ADD VALUE 'ROYAL_HOST_REWARD';

-- CreateTable
CREATE TABLE "royal_host_reward_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "weekly_hours_required" INTEGER NOT NULL DEFAULT 14,
    "daily_hours_cap_minutes" INTEGER NOT NULL DEFAULT 180,
    "timing_step1_points" BIGINT NOT NULL DEFAULT 40000,
    "timing_step2_points" BIGINT NOT NULL DEFAULT 60000,
    "timing_step2_earning_threshold" BIGINT NOT NULL DEFAULT 1000000,
    "gifting_tiers" JSONB NOT NULL,
    "consecutive_miss_weeks_limit" INTEGER NOT NULL DEFAULT 3,
    "auto_revoke_earning_threshold" BIGINT NOT NULL DEFAULT 1000000,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_admin_id" TEXT,

    CONSTRAINT "royal_host_reward_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "royal_host_reward_config"
    ("id", "weekly_hours_required", "daily_hours_cap_minutes", "timing_step1_points", "timing_step2_points", "timing_step2_earning_threshold", "gifting_tiers", "consecutive_miss_weeks_limit", "auto_revoke_earning_threshold", "updated_at")
VALUES
    (1, 14, 180, 40000, 60000, 1000000,
     '[{"threshold":"1000000","cumulativePoints":"60000"},{"threshold":"3000000","cumulativePoints":"200000"},{"threshold":"5000000","cumulativePoints":"400000"},{"threshold":"10000000","cumulativePoints":"900000"}]'::jsonb,
     3, 1000000, CURRENT_TIMESTAMP);

-- CreateTable
CREATE TABLE "royal_host_reward_claims" (
    "user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "reward_type" VARCHAR(20) NOT NULL,
    "points_amount" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "royal_host_reward_claims_pkey" PRIMARY KEY ("user_id","week_start","reward_type")
);

-- CreateIndex
CREATE INDEX "royal_host_reward_claims_user_id_week_start_idx" ON "royal_host_reward_claims"("user_id", "week_start" DESC);

-- AddForeignKey
ALTER TABLE "royal_host_reward_claims" ADD CONSTRAINT "royal_host_reward_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royal_host_reward_claims" ADD CONSTRAINT "royal_host_reward_claims_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "point_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "royal_host_weekly_evaluations" (
    "user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "earnings_total" BIGINT NOT NULL DEFAULT 0,
    "target_met" BOOLEAN NOT NULL,
    "consecutive_miss_count_after_this_week" INTEGER NOT NULL DEFAULT 0,
    "tag_revoked_after_this_week" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "royal_host_weekly_evaluations_pkey" PRIMARY KEY ("user_id","week_start")
);

-- CreateIndex
CREATE INDEX "royal_host_weekly_evaluations_week_start_target_met_idx" ON "royal_host_weekly_evaluations"("week_start", "target_met");

-- AddForeignKey
ALTER TABLE "royal_host_weekly_evaluations" ADD CONSTRAINT "royal_host_weekly_evaluations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Speeds up the weekly Royal Host cron's "list users currently tagged 'royal host'" scan.
CREATE INDEX "users_admin_tags_gin_idx" ON "users" USING GIN ("admin_tags");
