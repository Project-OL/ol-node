-- AlterEnum
ALTER TYPE "CoinTxType" ADD VALUE 'GUARDIAN_PURCHASE';

-- CreateEnum
CREATE TYPE "GuardianTier" AS ENUM ('SILVER', 'GOLD', 'KING');

-- CreateTable
CREATE TABLE "guardians" (
    "id" TEXT NOT NULL,
    "guardian_user_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "tier" "GuardianTier" NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "coins_paid" BIGINT NOT NULL,
    "purchased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_expired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "guardians_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guardians_guardian_user_id_target_user_id_key" ON "guardians"("guardian_user_id", "target_user_id");

-- CreateIndex
CREATE INDEX "guardians_target_user_id_is_expired_expires_at_idx" ON "guardians"("target_user_id", "is_expired", "expires_at");

-- CreateIndex
CREATE INDEX "guardians_guardian_user_id_is_expired_idx" ON "guardians"("guardian_user_id", "is_expired");

-- CreateIndex
CREATE INDEX "guardians_expires_at_is_expired_idx" ON "guardians"("expires_at", "is_expired");

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_guardian_user_id_fkey" FOREIGN KEY ("guardian_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
