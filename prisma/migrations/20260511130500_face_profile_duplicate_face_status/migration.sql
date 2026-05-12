-- Add DUPLICATE_FACE lifecycle state and owner linkage for duplicate detection.
ALTER TYPE "FaceProfileStatus" ADD VALUE IF NOT EXISTS 'DUPLICATE_FACE';

ALTER TABLE "user_face_profiles"
ADD COLUMN IF NOT EXISTS "duplicate_of_user_id" UUID;
