-- Decouple agency agent onboarding from support tickets: AgencyAgentApplication + application_id on KYC

ALTER TABLE "agency_application_kyc" DROP CONSTRAINT IF EXISTS "agency_application_kyc_ticket_public_id_fkey";
DROP INDEX IF EXISTS "agency_application_kyc_ticket_public_id_idx";

CREATE TYPE "AgencyAgentApplicationStatus" AS ENUM (
  'PENDING',
  'UNDER_REVIEW',
  'MORE_DOCS_REQUIRED',
  'APPROVED',
  'REJECTED'
);

CREATE TABLE "agency_agent_applications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "public_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "status" "AgencyAgentApplicationStatus" NOT NULL DEFAULT 'PENDING',
  "admin_note" TEXT,
  "user_note" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "reviewed_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agency_agent_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agency_agent_applications_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "agency_agent_applications_public_id_key" UNIQUE ("public_id"),
  CONSTRAINT "agency_agent_applications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agency_agent_applications_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "agency_agent_applications_status_created_at_idx"
  ON "agency_agent_applications"("status", "created_at");

ALTER TABLE "agency_application_kyc" ADD COLUMN IF NOT EXISTS "face_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agency_application_kyc" ADD COLUMN IF NOT EXISTS "application_id" UUID;

INSERT INTO "agency_agent_applications" ("id", "public_id", "user_id", "status", "reviewed_at", "created_at", "updated_at")
SELECT gen_random_uuid(),
  'mig_' || replace(gen_random_uuid()::text, '-', ''),
  k."user_id",
  CASE
    WHEN EXISTS (SELECT 1 FROM "agencies" e WHERE e."user_id" = k."user_id") THEN 'APPROVED'::"AgencyAgentApplicationStatus"
    ELSE 'PENDING'::"AgencyAgentApplicationStatus"
  END,
  CASE
    WHEN EXISTS (SELECT 1 FROM "agencies" e WHERE e."user_id" = k."user_id") THEN CURRENT_TIMESTAMP
    ELSE NULL
  END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "agency_application_kyc" k
WHERE NOT EXISTS (SELECT 1 FROM "agency_agent_applications" a WHERE a."user_id" = k."user_id");

UPDATE "agency_application_kyc" k
SET "application_id" = a."id"
FROM "agency_agent_applications" a
WHERE a."user_id" = k."user_id" AND k."application_id" IS NULL;

UPDATE "agency_application_kyc" k
SET "face_verified" = true
FROM "user_face_profiles" f
WHERE f."user_id" = k."user_id" AND f."status" = 'INDEXED';

ALTER TABLE "agency_application_kyc" ALTER COLUMN "application_id" SET NOT NULL;

ALTER TABLE "agency_application_kyc" DROP COLUMN IF EXISTS "ticket_public_id";

ALTER TABLE "agency_application_kyc"
  ADD CONSTRAINT "agency_application_kyc_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "agency_agent_applications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "agency_application_kyc_application_id_key" ON "agency_application_kyc"("application_id");
