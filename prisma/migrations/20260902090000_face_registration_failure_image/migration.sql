-- Persist the Rekognition liveness reference image on failed/rejected registration
-- attempts (LIVENESS_FAILED/VALIDATION_FAILED), so admin can review why a session failed.
ALTER TABLE "face_registration_sessions" ADD COLUMN "failure_image_s3_key" TEXT;
