-- Store links + Android APK releases shown on the marketing site (offoolive.com).
-- app_download_config is a singleton (id = 1). APK objects are never deleted from storage,
-- so every upload stays in app_apk_releases and can be made current again.
CREATE TABLE "app_download_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ios_url" TEXT,
    "play_store_url" TEXT,
    "current_apk_release_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_admin_id" UUID,

    CONSTRAINT "app_download_config_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app_apk_releases" (
    "id" UUID NOT NULL,
    "s3_key" TEXT NOT NULL,
    "version_name" VARCHAR(40) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "uploaded_by_admin_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_apk_releases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_apk_releases_s3_key_key" ON "app_apk_releases"("s3_key");

CREATE INDEX "app_apk_releases_created_at_idx" ON "app_apk_releases"("created_at" DESC);

ALTER TABLE "app_download_config" ADD CONSTRAINT "app_download_config_current_apk_release_id_fkey" FOREIGN KEY ("current_apk_release_id") REFERENCES "app_apk_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
