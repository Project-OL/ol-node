-- Add media type and optional thumbnail metadata for posts.
CREATE TYPE "PostMediaType" AS ENUM ('IMAGE', 'VIDEO');

ALTER TABLE "posts"
  ADD COLUMN "media_type" "PostMediaType" NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN "thumbnail_key" VARCHAR(500),
  ADD COLUMN "thumbnail_url" VARCHAR(1000);
