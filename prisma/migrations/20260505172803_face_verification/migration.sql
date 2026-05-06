-- CreateEnum
CREATE TYPE "FaceProfileStatus" AS ENUM ('PENDING_INDEX', 'INDEXED', 'FAILED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FaceVerificationDecision" AS ENUM ('PASS', 'FAIL', 'ERROR', 'QUALITY_REJECTED', 'RATE_LIMITED');

-- AlterTable
ALTER TABLE "public_id_classification_progress" ALTER COLUMN "id" SET DEFAULT 1;

-- AlterTable
ALTER TABLE "rich_tier_configs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "user_rich_tier" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "user_face_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "collection_id" TEXT NOT NULL,
    "rekognition_face_id" TEXT,
    "s3_key_reference" TEXT NOT NULL,
    "image_quality_score" DOUBLE PRECISION,
    "liveness_confidence" DOUBLE PRECISION,
    "status" "FaceProfileStatus" NOT NULL DEFAULT 'PENDING_INDEX',
    "failure_reason" TEXT,
    "indexed_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_face_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "face_verification_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "s3_key" TEXT NOT NULL,
    "similarity_score" DOUBLE PRECISION,
    "decision" "FaceVerificationDecision" NOT NULL,
    "reason" TEXT,
    "rekognition_request_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "client_request_id" UUID,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_verification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_face_profiles_user_id_key" ON "user_face_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_face_profiles_rekognition_face_id_key" ON "user_face_profiles"("rekognition_face_id");

-- CreateIndex
CREATE INDEX "user_face_profiles_status_idx" ON "user_face_profiles"("status");

-- CreateIndex
CREATE INDEX "face_verification_attempts_user_id_created_at_idx" ON "face_verification_attempts"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "face_verification_attempts_decision_created_at_idx" ON "face_verification_attempts"("decision", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "face_verification_attempts_user_id_client_request_id_key" ON "face_verification_attempts"("user_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "user_face_profiles" ADD CONSTRAINT "user_face_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_verification_attempts" ADD CONSTRAINT "face_verification_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "monthly_recharge_aggregates_year_month_total_desc_idx" RENAME TO "monthly_recharge_aggregates_year_month_total_recharge_coins_idx";

-- RenameIndex
ALTER INDEX "user_questionnaire_attempts_user_id_questionnaire_id_completed_" RENAME TO "user_questionnaire_attempts_user_id_questionnaire_id_comple_idx";

-- RenameIndex
ALTER INDEX "user_questionnaire_attempts_user_id_questionnaire_id_questionna" RENAME TO "user_questionnaire_attempts_user_id_questionnaire_id_questi_idx";

-- RenameIndex
ALTER INDEX "user_rich_tier_tier_evaluated_idx" RENAME TO "user_rich_tier_current_tier_evaluated_from_year_evaluated_f_idx";

