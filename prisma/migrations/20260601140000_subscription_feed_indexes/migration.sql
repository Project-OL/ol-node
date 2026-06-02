-- Subscription discovery & feed read-path indexes.
-- CONCURRENTLY omitted: Prisma migrations run in a transaction (see agency_dashboard_indexes).

CREATE INDEX IF NOT EXISTS "creator_subscriptions_subscriber_id_status_idx"
  ON "creator_subscriptions" ("subscriber_id", "status");

CREATE INDEX IF NOT EXISTS "posts_user_id_created_at_id_idx"
  ON "posts" ("user_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "creator_subscriptions_creator_id_active_idx"
  ON "creator_subscriptions" ("creator_id")
  WHERE "status" = 'ACTIVE';
