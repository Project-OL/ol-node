-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_latitude" DECIMAL(9,6),
ADD COLUMN IF NOT EXISTS "last_longitude" DECIMAL(9,6),
ADD COLUMN IF NOT EXISTS "last_location_accuracy_m" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "last_located_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_location_samples" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracy_m" DOUBLE PRECISION,
    "source" VARCHAR(40) NOT NULL DEFAULT 'app_gps',
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_location_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_location_samples_user_id_recorded_at_idx" ON "user_location_samples"("user_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_location_samples_recorded_at_idx" ON "user_location_samples"("recorded_at" DESC);

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_location_samples_user_id_fkey'
  ) THEN
    ALTER TABLE "user_location_samples"
      ADD CONSTRAINT "user_location_samples_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
