-- Face registration with AWS Face Liveness (sessions + audit).

CREATE TYPE "FaceRegistrationSessionStatus" AS ENUM (
  'PENDING',
  'UPLOADED',
  'PROCESSING',
  'LIVENESS_PASSED',
  'LIVENESS_FAILED',
  'INDEX_PENDING',
  'INDEXED',
  'REJECTED',
  'EXPIRED'
);

CREATE TABLE "face_registration_sessions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "status" "FaceRegistrationSessionStatus" NOT NULL DEFAULT 'PENDING',
  "aws_session_id" VARCHAR(128),
  "challenge_sequence" JSONB NOT NULL,
  "challenge_nonce" VARCHAR(64) NOT NULL,
  "supplemental_video_s3_key" TEXT,
  "upload_nonce" VARCHAR(64),
  "risk_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "device_metadata" JSONB,
  "ip_address" VARCHAR(64),
  "failure_reason" TEXT,
  "liveness_confidence" DOUBLE PRECISION,
  "rekognition_raw_status" VARCHAR(32),
  "idempotency_key" UUID,
  "aws_request_id" VARCHAR(128),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "verified_at" TIMESTAMP(3),
  "indexed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "face_registration_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "face_registration_sessions_user_id_status_idx" ON "face_registration_sessions" ("user_id", "status");
CREATE INDEX "face_registration_sessions_user_id_created_at_idx" ON "face_registration_sessions" ("user_id", "created_at" DESC);
CREATE INDEX "face_registration_sessions_expires_at_idx" ON "face_registration_sessions" ("expires_at");

ALTER TABLE "face_registration_sessions"
  ADD CONSTRAINT "face_registration_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "face_registration_audit_logs" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "action" VARCHAR(64) NOT NULL,
  "details" JSONB,
  "ip_address" VARCHAR(64),
  "user_agent" TEXT,
  "latency_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "face_registration_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "face_registration_audit_logs_session_id_created_at_idx"
  ON "face_registration_audit_logs" ("session_id", "created_at" DESC);
CREATE INDEX "face_registration_audit_logs_user_id_created_at_idx"
  ON "face_registration_audit_logs" ("user_id", "created_at" DESC);

ALTER TABLE "face_registration_audit_logs"
  ADD CONSTRAINT "face_registration_audit_logs_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "face_registration_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "face_registration_audit_logs"
  ADD CONSTRAINT "face_registration_audit_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
