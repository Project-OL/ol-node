-- CreateTable
CREATE TABLE "user_follows" (
    "id" TEXT NOT NULL,
    "follower_id" UUID NOT NULL,
    "following_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_visitors" (
    "id" TEXT NOT NULL,
    "profile_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "visited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_subscribers" (
    "id" TEXT NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "subscribed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_levels" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "livestream_level" INTEGER NOT NULL DEFAULT 0,
    "wealth_level" INTEGER NOT NULL DEFAULT 0,
    "livestream_xp" BIGINT NOT NULL DEFAULT 0,
    "wealth_xp" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "level_config" (
    "id" TEXT NOT NULL,
    "level_type" VARCHAR(50) NOT NULL,
    "level" INTEGER NOT NULL,
    "min_xp" BIGINT NOT NULL,
    "max_xp" BIGINT NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "icon_url" VARCHAR(500),

    CONSTRAINT "level_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_follows_follower_id_idx" ON "user_follows"("follower_id");

-- CreateIndex
CREATE INDEX "user_follows_following_id_idx" ON "user_follows"("following_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_follows_follower_id_following_id_key" ON "user_follows"("follower_id", "following_id");

-- CreateIndex
CREATE INDEX "profile_visitors_profile_id_visited_at_idx" ON "profile_visitors"("profile_id", "visited_at");

-- CreateIndex
CREATE INDEX "profile_visitors_visitor_id_visited_at_idx" ON "profile_visitors"("visitor_id", "visited_at");

-- CreateIndex
CREATE UNIQUE INDEX "profile_visitors_profile_id_visitor_id_key" ON "profile_visitors"("profile_id", "visitor_id");

-- CreateIndex
CREATE INDEX "user_subscribers_creator_id_idx" ON "user_subscribers"("creator_id");

-- CreateIndex
CREATE INDEX "user_subscribers_subscriber_id_idx" ON "user_subscribers"("subscriber_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_subscribers_subscriber_id_creator_id_key" ON "user_subscribers"("subscriber_id", "creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_levels_user_id_key" ON "user_levels"("user_id");

-- CreateIndex
CREATE INDEX "level_config_level_type_idx" ON "level_config"("level_type");

-- CreateIndex
CREATE UNIQUE INDEX "level_config_level_type_level_key" ON "level_config"("level_type", "level");

-- AddForeignKey
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_visitors" ADD CONSTRAINT "profile_visitors_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_visitors" ADD CONSTRAINT "profile_visitors_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscribers" ADD CONSTRAINT "user_subscribers_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscribers" ADD CONSTRAINT "user_subscribers_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_levels" ADD CONSTRAINT "user_levels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
