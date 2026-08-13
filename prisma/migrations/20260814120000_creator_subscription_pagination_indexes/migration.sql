-- Composite covering indexes for cursor-paginated creator-subscription lists
-- (ORDER BY updated_at DESC, id DESC). Partial on status = 'ACTIVE' since both
-- list endpoints only ever query active subscriptions.
--
-- Partial indexes cannot be declared in schema.prisma (Prisma's schema DSL has
-- no WHERE-predicate syntax for @@index) — same reason
-- creator_subscriptions_creator_id_active_idx (20260601140000) is raw-SQL-only.
--
-- CONCURRENTLY intentionally avoided: Prisma runs migrations inside a
-- transaction, where CONCURRENTLY cannot execute (same note as
-- 20260531120000_agency_dashboard_indexes and 20260601140000 themselves). Uses
-- IF NOT EXISTS for idempotency. For a large production table, build these
-- out-of-band with CONCURRENTLY in a maintenance window instead of via this
-- migration, then mark it applied.
--
-- Rollback (no down-migration convention exists in this repo — see
-- CHANGELOG-remediation.md Phase 0): DROP INDEX IF EXISTS
-- "creator_subscriptions_creator_id_updated_at_id_idx";
-- DROP INDEX IF EXISTS "creator_subscriptions_subscriber_id_updated_at_id_idx";
-- Safe to run any time — additive-only, no data or column changes.

CREATE INDEX IF NOT EXISTS "creator_subscriptions_creator_id_updated_at_id_idx"
  ON "creator_subscriptions" ("creator_id", "updated_at" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE';

CREATE INDEX IF NOT EXISTS "creator_subscriptions_subscriber_id_updated_at_id_idx"
  ON "creator_subscriptions" ("subscriber_id", "updated_at" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE';
