-- AlterTable
ALTER TABLE "users" ADD COLUMN "original_public_id" BIGINT;

CREATE UNIQUE INDEX "users_original_public_id_key" ON "users"("original_public_id");

-- AlterTable
ALTER TABLE "vip_public_ids" ADD COLUMN "tier" VARCHAR(50) NOT NULL DEFAULT 'NONE';
ALTER TABLE "vip_public_ids" ADD COLUMN "price_group" VARCHAR(50) NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "vip_public_ids" ADD COLUMN "matched_rules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "vip_public_ids" ADD COLUMN "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "vip_public_ids" ADD COLUMN "assigned_at" TIMESTAMP(3);

ALTER TABLE "vip_public_ids" ALTER COLUMN "rarity_score" SET DEFAULT 0;

CREATE INDEX "vip_public_ids_tier_assigned_at_idx" ON "vip_public_ids"("tier", "assigned_at");
CREATE INDEX "vip_public_ids_assigned_at_idx" ON "vip_public_ids"("assigned_at");

-- CreateTable
CREATE TABLE "user_vip_assignments" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "public_id" BIGINT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_vip_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_vip_assignments_user_id_is_active_idx" ON "user_vip_assignments"("user_id", "is_active");
CREATE INDEX "user_vip_assignments_expires_at_is_active_idx" ON "user_vip_assignments"("expires_at", "is_active");

ALTER TABLE "user_vip_assignments" ADD CONSTRAINT "user_vip_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_vip_assignments" ADD CONSTRAINT "user_vip_assignments_public_id_fkey" FOREIGN KEY ("public_id") REFERENCES "vip_public_ids"("public_id") ON DELETE RESTRICT ON UPDATE CASCADE;
