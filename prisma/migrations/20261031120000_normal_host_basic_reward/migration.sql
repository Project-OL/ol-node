-- AlterEnum
ALTER TYPE "PointTxType" ADD VALUE 'NORMAL_HOST_BASIC_REWARD';

-- CreateTable
CREATE TABLE "normal_host_basic_reward_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "required_minutes" INTEGER NOT NULL DEFAULT 60,
    "points_amount" BIGINT NOT NULL DEFAULT 800,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_admin_id" TEXT,

    CONSTRAINT "normal_host_basic_reward_config_pkey" PRIMARY KEY ("id")
);

-- Off until an admin turns it on.
INSERT INTO "normal_host_basic_reward_config" ("id", "updated_at")
VALUES (1, CURRENT_TIMESTAMP);

-- CreateTable
CREATE TABLE "normal_host_basic_reward_claims" (
    "user_id" UUID NOT NULL,
    "reward_date" DATE NOT NULL,
    "points_amount" BIGINT NOT NULL,
    "required_minutes" INTEGER NOT NULL,
    "streamed_seconds" INTEGER NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "normal_host_basic_reward_claims_pkey" PRIMARY KEY ("user_id","reward_date")
);

-- CreateIndex
CREATE INDEX "normal_host_basic_reward_claims_reward_date_idx" ON "normal_host_basic_reward_claims"("reward_date");

-- AddForeignKey
ALTER TABLE "normal_host_basic_reward_claims" ADD CONSTRAINT "normal_host_basic_reward_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normal_host_basic_reward_claims" ADD CONSTRAINT "normal_host_basic_reward_claims_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "point_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
