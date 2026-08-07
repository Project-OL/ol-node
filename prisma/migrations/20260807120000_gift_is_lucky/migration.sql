-- AlterTable (idempotent: column may already exist on some envs)
ALTER TABLE "gifts" ADD COLUMN IF NOT EXISTS "is_lucky" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "gifts_is_lucky_idx" ON "gifts"("is_lucky");
