-- CreateEnum
CREATE TYPE "LevelType" AS ENUM ('WEALTH', 'LIVESTREAM');

-- CreateTable
CREATE TABLE "wallet_level_configs" (
    "id" UUID NOT NULL,
    "level_type" "LevelType" NOT NULL,
    "level" INTEGER NOT NULL,
    "threshold" BIGINT NOT NULL,
    "label" VARCHAR(255),
    "icon_key" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_level_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_user_levels" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "level_type" "LevelType" NOT NULL,
    "current_level" INTEGER NOT NULL DEFAULT 1,
    "cumulative_total" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_user_levels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_level_configs_level_type_level_key" ON "wallet_level_configs"("level_type", "level");

-- CreateIndex
CREATE INDEX "wallet_level_configs_level_type_threshold_idx" ON "wallet_level_configs"("level_type", "threshold");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_user_levels_user_id_level_type_key" ON "wallet_user_levels"("user_id", "level_type");

-- CreateIndex
CREATE INDEX "wallet_user_levels_user_id_idx" ON "wallet_user_levels"("user_id");

-- AddForeignKey
ALTER TABLE "wallet_user_levels" ADD CONSTRAINT "wallet_user_levels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
