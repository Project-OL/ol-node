-- Gift catalog: small derived thumbnail served to clients in place of the full-resolution
-- display image. Nullable, so existing rows keep working (payloads fall back to the original)
-- until `npm run backfill:gift-thumbnails` fills them in.
ALTER TABLE "gifts" ADD COLUMN "thumbnail_url" TEXT;

-- Game catalog: our own copy of the provider's preview image, so clients fetch previews
-- from our object store instead of the provider's overseas CDN.
ALTER TABLE "game_catalog_entries" ADD COLUMN "preview_mirror_url" VARCHAR(500);
