-- Gift catalog categories + admin fields on gifts; gallery section visibility.

CREATE TABLE "gift_categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gift_categories_slug_key" ON "gift_categories"("slug");
CREATE INDEX "gift_categories_is_active_idx" ON "gift_categories"("is_active");
CREATE INDEX "gift_categories_display_order_idx" ON "gift_categories"("display_order");

ALTER TABLE "gifts" ADD COLUMN "code" VARCHAR(64);
ALTER TABLE "gifts" ADD COLUMN "display_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "gifts" ADD COLUMN "vip_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "gifts" ADD COLUMN "category_id" UUID;

UPDATE "gifts"
SET "code" = 'gift_' || REPLACE(SUBSTRING("id"::text, 1, 12), '-', '')
WHERE "code" IS NULL;

ALTER TABLE "gifts" ALTER COLUMN "code" SET NOT NULL;

CREATE UNIQUE INDEX "gifts_code_key" ON "gifts"("code");
CREATE INDEX "gifts_category_id_idx" ON "gifts"("category_id");
CREATE INDEX "gifts_display_order_idx" ON "gifts"("display_order");

ALTER TABLE "gifts"
ADD CONSTRAINT "gifts_category_id_fkey"
FOREIGN KEY ("category_id") REFERENCES "gift_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "gift_gallery_sections" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "gift_gallery_sections" ADD COLUMN "enabled_at" TIMESTAMP(3);
