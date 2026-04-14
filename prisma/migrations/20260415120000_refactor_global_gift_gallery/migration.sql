-- Global gift gallery: one row per (year, month); progress per host × section item.

DELETE FROM "gift_gallery_progress";

DELETE FROM "gift_gallery_section_items";

DELETE FROM "gift_gallery_sections";

DELETE FROM "gift_galleries";

ALTER TABLE "gift_galleries" DROP CONSTRAINT IF EXISTS "gift_galleries_host_user_id_fkey";

DROP INDEX IF EXISTS "gift_galleries_host_user_id_year_month_key";

DROP INDEX IF EXISTS "gift_galleries_host_user_id_idx";

ALTER TABLE "gift_galleries" DROP COLUMN IF EXISTS "host_user_id";

ALTER TABLE "gift_galleries" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "gift_galleries_year_month_key" ON "gift_galleries"("year", "month");

DROP TABLE IF EXISTS "gift_gallery_progress";

CREATE TABLE "gift_gallery_progress" (
    "id" UUID NOT NULL,
    "gallery_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "gift_id" UUID NOT NULL,
    "gift_gallery_section_item_id" UUID NOT NULL,
    "first_gifter_id" UUID NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_gallery_progress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gift_gallery_progress_host_user_id_gift_gallery_section_item_id_key" ON "gift_gallery_progress"("host_user_id", "gift_gallery_section_item_id");

CREATE INDEX "gift_gallery_progress_host_user_id_gallery_id_idx" ON "gift_gallery_progress"("host_user_id", "gallery_id");

CREATE INDEX "gift_gallery_progress_gallery_id_idx" ON "gift_gallery_progress"("gallery_id");

ALTER TABLE "gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_gallery_id_fkey" FOREIGN KEY ("gallery_id") REFERENCES "gift_galleries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_first_gifter_id_fkey" FOREIGN KEY ("first_gifter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "gift_gallery_progress" ADD CONSTRAINT "gift_gallery_progress_gift_gallery_section_item_id_fkey" FOREIGN KEY ("gift_gallery_section_item_id") REFERENCES "gift_gallery_section_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
