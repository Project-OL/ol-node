-- AlterEnum
ALTER TYPE "PointTxType" ADD VALUE 'NORMAL_HOST_REWARD';

-- CreateTable
CREATE TABLE "normal_host_reward_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tiers" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_admin_id" TEXT,

    CONSTRAINT "normal_host_reward_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "normal_host_reward_config" ("id", "tiers", "updated_at")
VALUES (
    1,
    '[
        {"thresholdPoints":"100000","hourlyRatePoints":"1000","hourCapHours":1,"windowDays":30},
        {"thresholdPoints":"500000","hourlyRatePoints":"3500","hourCapHours":2,"windowDays":7},
        {"thresholdPoints":"1000000","hourlyRatePoints":"7000","hourCapHours":2,"windowDays":7},
        {"thresholdPoints":"2000000","hourlyRatePoints":"14000","hourCapHours":2,"windowDays":7},
        {"thresholdPoints":"4000000","hourlyRatePoints":"20000","hourCapHours":3,"windowDays":7},
        {"thresholdPoints":"10000000","hourlyRatePoints":"50000","hourCapHours":3,"windowDays":7},
        {"thresholdPoints":"22000000","hourlyRatePoints":"100000","hourCapHours":3,"windowDays":7},
        {"thresholdPoints":"35000000","hourlyRatePoints":"170000","hourCapHours":3,"windowDays":7},
        {"thresholdPoints":"50000000","hourlyRatePoints":"250000","hourCapHours":3,"windowDays":7}
    ]'::jsonb,
    CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "normal_host_reward_claims" (
    "user_id" UUID NOT NULL,
    "reward_date" DATE NOT NULL,
    "hour_slot" INTEGER NOT NULL,
    "points_amount" BIGINT NOT NULL,
    "tier_threshold_points" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "normal_host_reward_claims_pkey" PRIMARY KEY ("user_id","reward_date","hour_slot")
);

-- CreateIndex
CREATE INDEX "normal_host_reward_claims_user_id_reward_date_idx" ON "normal_host_reward_claims"("user_id", "reward_date" DESC);

-- AddForeignKey
ALTER TABLE "normal_host_reward_claims" ADD CONSTRAINT "normal_host_reward_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normal_host_reward_claims" ADD CONSTRAINT "normal_host_reward_claims_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "point_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
