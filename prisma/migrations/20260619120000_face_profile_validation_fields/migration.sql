-- AlterEnum
ALTER TYPE "FaceRegistrationSessionStatus" ADD VALUE 'VALIDATION_FAILED';

-- AlterTable
ALTER TABLE "user_face_profiles" ADD COLUMN "quality_checks_passed" JSONB,
ADD COLUMN "detected_gender" VARCHAR(50),
ADD COLUMN "gender_updated_at" TIMESTAMP(3),
ADD COLUMN "moderation_labels" JSONB,
ADD COLUMN "face_match_similarity" DOUBLE PRECISION,
ADD COLUMN "matched_user_id" UUID;

-- AlterTable
ALTER TABLE "face_registration_audit_logs" ADD COLUMN "quality_check_failures" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "detected_gender" VARCHAR(50),
ADD COLUMN "gender_auto_updated" BOOLEAN,
ADD COLUMN "duplicate_match_user_id" UUID,
ADD COLUMN "content_policy_violation" BOOLEAN;

-- CreateTable
CREATE TABLE "face_profile_revocations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "face_profile_id" UUID,
    "revoked_by_user_id" UUID,
    "revoke_reason" TEXT,
    "rekognition_face_id" VARCHAR(128),
    "revoked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_profile_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_face_profiles_matched_user_id_idx" ON "user_face_profiles"("matched_user_id");

-- CreateIndex
CREATE INDEX "face_profile_revocations_user_id_idx" ON "face_profile_revocations"("user_id");

-- CreateIndex
CREATE INDEX "face_profile_revocations_revoked_at_idx" ON "face_profile_revocations"("revoked_at" DESC);

-- AddForeignKey
ALTER TABLE "user_face_profiles" ADD CONSTRAINT "user_face_profiles_matched_user_id_fkey" FOREIGN KEY ("matched_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_profile_revocations" ADD CONSTRAINT "face_profile_revocations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_profile_revocations" ADD CONSTRAINT "face_profile_revocations_face_profile_id_fkey" FOREIGN KEY ("face_profile_id") REFERENCES "user_face_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_profile_revocations" ADD CONSTRAINT "face_profile_revocations_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
