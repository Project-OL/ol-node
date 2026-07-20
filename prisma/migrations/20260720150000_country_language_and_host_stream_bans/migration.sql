-- Country → default language mapping (i18n / livestream shared DB).
-- Host stream ban history (escalating ban durations per stream).

CREATE TABLE IF NOT EXISTS "country_language_mappings" (
    "id" UUID NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "language" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "country_language_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "country_language_mappings_country_key"
    ON "country_language_mappings"("country");

CREATE TABLE IF NOT EXISTS "host_stream_bans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stream_id" UUID NOT NULL,
    "ban_number" INTEGER NOT NULL,
    "ban_duration_hours" INTEGER NOT NULL,
    "suspended_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_stream_bans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "host_stream_bans_user_id_idx" ON "host_stream_bans"("user_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'host_stream_bans_user_id_fkey'
    ) THEN
        ALTER TABLE "host_stream_bans"
            ADD CONSTRAINT "host_stream_bans_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
