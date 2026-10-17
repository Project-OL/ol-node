-- LIVE-31: lucky-gift reserve pool counters move from Redis (no persistence) into Postgres,
-- incremented inside each lucky gift's transaction. 8 slots so concurrent lucky gifts don't all
-- queue on one row lock; readers sum them. Slot 0's `seeded` flips once, when Live-server adds the
-- historical totals it had in Redis.
CREATE TABLE IF NOT EXISTS "lucky_reserve_pool" (
  "slot"           INTEGER        NOT NULL,
  "total_spent"    BIGINT         NOT NULL DEFAULT 0,
  "total_rewarded" BIGINT         NOT NULL DEFAULT 0,
  "pool_balance"   DECIMAL(24,4)  NOT NULL DEFAULT 0,
  "seeded"         BOOLEAN        NOT NULL DEFAULT false,
  "updated_at"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lucky_reserve_pool_pkey" PRIMARY KEY ("slot")
);

INSERT INTO "lucky_reserve_pool" ("slot")
SELECT s FROM generate_series(0, 7) AS s
ON CONFLICT ("slot") DO NOTHING;
