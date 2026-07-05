-- Platform message types (transactional, notification) and structured metadata
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'TRANSACTIONAL';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'NOTIFICATION';

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
