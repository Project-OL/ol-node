-- Water-level lucky tiers, Phase 2 (EXPAND-ONLY: new tables + one additive boolean column).
-- Design: docs/lucky/WATER_LEVEL_DESIGN.md. No engine reads these tables yet; config v1 is seeded
-- with mode = 'off' and NO pool rows are created (admin seeds pools explicitly).
--
-- ROLLBACK (safe only while nothing writes to these tables, i.e. before Phase 3 is enabled):
--   ALTER TABLE "host_revenue_share_config" DROP COLUMN IF EXISTS "lucky_water_agency_commission";
--   DROP TABLE IF EXISTS "lucky_tier_daily_snapshot";
--   DROP TABLE IF EXISTS "lucky_shadow_cursor";
--   DROP TABLE IF EXISTS "lucky_draw_audit";
--   DROP TABLE IF EXISTS "lucky_tier_seed_log";
--   DROP TABLE IF EXISTS "lucky_tier_pool_shadow";
--   DROP TABLE IF EXISTS "lucky_tier_pool";
--   DROP TABLE IF EXISTS "lucky_tier_config";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024150000_lucky_water_level';

-- ---------------------------------------------------------------------------
-- lucky_tier_config: versioned per-tier config
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "lucky_tier_config" (
  "id"                              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tier_id"                         VARCHAR(8)   NOT NULL,
  "version"                         INTEGER      NOT NULL,
  "mode"                            VARCHAR(16)  NOT NULL DEFAULT 'off',
  "price_min"                       INTEGER      NOT NULL,
  "price_max"                       INTEGER,
  "r_bp"                            INTEGER      NOT NULL DEFAULT 9200,
  "j_bp"                            INTEGER      NOT NULL DEFAULT 0,
  "l0"                              BIGINT       NOT NULL,
  "floor"                           BIGINT       NOT NULL,
  "lambda_critical_max_bp"          INTEGER      NOT NULL DEFAULT 5000,
  "lambda_low_max_bp"               INTEGER      NOT NULL DEFAULT 10000,
  "lambda_normal_max_bp"            INTEGER      NOT NULL DEFAULT 15000,
  "band_weights_json"               JSONB        NOT NULL,
  "weight_table_id"                 VARCHAR(64)  NOT NULL,
  "m_max"                           INTEGER      NOT NULL DEFAULT 10,
  "v_max_bp"                        INTEGER      NOT NULL DEFAULT 10000,
  "safety_margin_bp"                INTEGER      NOT NULL DEFAULT 100,
  "min_gap_bp"                      INTEGER      NOT NULL DEFAULT 50,
  "daily_win_cap_coins"             BIGINT       NOT NULL DEFAULT 0,
  "cool_down_after_big_win_seconds" INTEGER      NOT NULL DEFAULT 0,
  "created_by"                      TEXT,
  "created_at"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lucky_tier_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lucky_tier_config_tier_chk"  CHECK ("tier_id" IN ('T100','T500','T2K','T10K','T50K')),
  CONSTRAINT "lucky_tier_config_mode_chk"  CHECK ("mode" IN ('off','shadow','enforce')),
  CONSTRAINT "lucky_tier_config_version_chk" CHECK ("version" >= 1),
  CONSTRAINT "lucky_tier_config_price_chk" CHECK ("price_min" >= 1 AND ("price_max" IS NULL OR "price_max" >= "price_min")),
  CONSTRAINT "lucky_tier_config_r_chk"     CHECK ("r_bp" BETWEEN 1 AND 10000),
  CONSTRAINT "lucky_tier_config_j_chk"     CHECK ("j_bp" >= 0 AND "j_bp" <= 10000),
  CONSTRAINT "lucky_tier_config_l0_chk"    CHECK ("l0" > 0 AND "floor" >= 0 AND "floor" <= "l0"),
  CONSTRAINT "lucky_tier_config_lambda_chk" CHECK (
    "lambda_critical_max_bp" > 0
    AND "lambda_critical_max_bp" < "lambda_low_max_bp"
    AND "lambda_low_max_bp" < "lambda_normal_max_bp"
  ),
  CONSTRAINT "lucky_tier_config_mmax_chk"  CHECK ("m_max" >= 1),
  CONSTRAINT "lucky_tier_config_vmax_chk"  CHECK ("v_max_bp" > 0),
  CONSTRAINT "lucky_tier_config_margin_chk" CHECK ("safety_margin_bp" >= 0 AND "min_gap_bp" >= 0),
  CONSTRAINT "lucky_tier_config_caps_chk"  CHECK ("daily_win_cap_coins" >= 0 AND "cool_down_after_big_win_seconds" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "lucky_tier_config_tier_id_version_key"
  ON "lucky_tier_config" ("tier_id", "version");

-- ---------------------------------------------------------------------------
-- lucky_tier_pool (live) / lucky_tier_pool_shadow (virtual)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "lucky_tier_pool" (
  "tier_id"        VARCHAR(8)   NOT NULL,
  "balance"        BIGINT       NOT NULL DEFAULT 0,
  "config_version" INTEGER,
  "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lucky_tier_pool_pkey" PRIMARY KEY ("tier_id"),
  CONSTRAINT "lucky_tier_pool_tier_chk" CHECK ("tier_id" IN ('T100','T500','T2K','T10K','T50K')),
  CONSTRAINT "lucky_tier_pool_balance_chk" CHECK ("balance" >= 0)
);

CREATE TABLE IF NOT EXISTS "lucky_tier_pool_shadow" (
  "tier_id"        VARCHAR(8)   NOT NULL,
  "balance"        BIGINT       NOT NULL DEFAULT 0,
  "config_version" INTEGER      NOT NULL,
  "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lucky_tier_pool_shadow_pkey" PRIMARY KEY ("tier_id"),
  CONSTRAINT "lucky_tier_pool_shadow_tier_chk" CHECK ("tier_id" IN ('T100','T500','T2K','T10K','T50K')),
  CONSTRAINT "lucky_tier_pool_shadow_balance_chk" CHECK ("balance" >= 0)
);

-- ---------------------------------------------------------------------------
-- lucky_tier_seed_log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "lucky_tier_seed_log" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tier_id"    VARCHAR(8)   NOT NULL,
  "amount"     BIGINT       NOT NULL,
  "admin_id"   TEXT         NOT NULL,
  "reason"     TEXT,
  "choice"     VARCHAR(24)  NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lucky_tier_seed_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lucky_tier_seed_log_tier_chk" CHECK ("tier_id" IN ('T100','T500','T2K','T10K','T50K')),
  CONSTRAINT "lucky_tier_seed_log_choice_chk" CHECK ("choice" IN ('seed','start_empty','capped_ladder')),
  CONSTRAINT "lucky_tier_seed_log_amount_chk" CHECK ("amount" >= 0)
);

CREATE INDEX IF NOT EXISTS "lucky_tier_seed_log_tier_id_created_at_idx"
  ON "lucky_tier_seed_log" ("tier_id", "created_at");

-- ---------------------------------------------------------------------------
-- lucky_draw_audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "lucky_draw_audit" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "idempotency_key"     TEXT         NOT NULL,
  "payload_fingerprint" TEXT,
  "engine"              VARCHAR(16)  NOT NULL,
  "mode"                VARCHAR(16)  NOT NULL,
  "tier_id"             VARCHAR(8),
  "sender_user_id"      UUID,
  "gift_transaction_id" UUID,
  "drawn_json"          JSONB        NOT NULL,
  "breakdown_array"     JSONB        NOT NULL,
  "category"            VARCHAR(32)  NOT NULL,
  "paid_reward"         BIGINT       NOT NULL DEFAULT 0,
  "sender_balance_after" BIGINT,
  "config_version"      INTEGER,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lucky_draw_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lucky_draw_audit_engine_chk" CHECK ("engine" IN ('legacy','water_v1')),
  CONSTRAINT "lucky_draw_audit_mode_chk" CHECK ("mode" IN ('off','shadow','enforce','legacy_path')),
  CONSTRAINT "lucky_draw_audit_tier_chk" CHECK ("tier_id" IS NULL OR "tier_id" IN ('T100','T500','T2K','T10K','T50K')),
  CONSTRAINT "lucky_draw_audit_paid_chk" CHECK ("paid_reward" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "lucky_draw_audit_idempotency_key_key"
  ON "lucky_draw_audit" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "lucky_draw_audit_tier_id_created_at_idx"
  ON "lucky_draw_audit" ("tier_id", "created_at");
CREATE INDEX IF NOT EXISTS "lucky_draw_audit_sender_user_id_created_at_idx"
  ON "lucky_draw_audit" ("sender_user_id", "created_at");

-- ---------------------------------------------------------------------------
-- lucky_shadow_cursor (single row, id = 'default'; created lazily by the shadow worker)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "lucky_shadow_cursor" (
  "id"              TEXT         NOT NULL DEFAULT 'default',
  "last_created_at" TIMESTAMP(3),
  "last_id"         TEXT,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lucky_shadow_cursor_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- lucky_tier_daily_snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "lucky_tier_daily_snapshot" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tier_id"          VARCHAR(8)   NOT NULL,
  "day_utc"          DATE         NOT NULL,
  "draw_count"       BIGINT       NOT NULL DEFAULT 0,
  "total_spent"      BIGINT       NOT NULL DEFAULT 0,
  "total_paid"       BIGINT       NOT NULL DEFAULT 0,
  "rtp_bp"           INTEGER,
  "pool_balance_end" BIGINT,
  "metrics"          JSONB        NOT NULL DEFAULT '{}',
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lucky_tier_daily_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lucky_tier_daily_snapshot_tier_chk" CHECK ("tier_id" IN ('T100','T500','T2K','T10K','T50K'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "lucky_tier_daily_snapshot_tier_id_day_utc_key"
  ON "lucky_tier_daily_snapshot" ("tier_id", "day_utc");

-- ---------------------------------------------------------------------------
-- host_revenue_share_config: additive flag
-- ---------------------------------------------------------------------------
ALTER TABLE "host_revenue_share_config"
  ADD COLUMN IF NOT EXISTS "lucky_water_agency_commission" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Seed config v1, all tiers mode = 'off'. Weight table wt_v1_2026_10_24 (bp, each band sums 10000):
--   critical {3000,3000,4000,0,0}    EV 5500 bp
--   low      {3400,2800,2400,1400,0} EV 7300 bp
--   normal   {4000,2600,1850,1250,300} EV 9275 bp
--   high     {5200,2100,1400,800,500}  EV 9450 bp
-- Multipliers (x price): miss 0, half 0.5, equal 1, medium 2.5, jackpot 10.
-- F2: EV_high + (h_bp + a_bp)/10000 * v_max = 9450 + 400 = 9850 < 10000 - 100 = 9900.
-- No pool rows are inserted.
-- ---------------------------------------------------------------------------
INSERT INTO "lucky_tier_config"
  ("tier_id", "version", "mode", "price_min", "price_max", "r_bp", "j_bp", "l0", "floor",
   "band_weights_json", "weight_table_id", "created_by")
SELECT
  t.tier_id, 1, 'off', t.price_min, t.price_max, 9200, 0, t.l0, t.floor,
  '{"critical":{"miss":3000,"half":3000,"equal":4000,"medium":0,"jackpot":0},
    "low":{"miss":3400,"half":2800,"equal":2400,"medium":1400,"jackpot":0},
    "normal":{"miss":4000,"half":2600,"equal":1850,"medium":1250,"jackpot":300},
    "high":{"miss":5200,"half":2100,"equal":1400,"medium":800,"jackpot":500}}'::jsonb,
  'wt_v1_2026_10_24', 'migration:20261024150000_lucky_water_level'
FROM (VALUES
  ('T100',      1,   199,    100000::bigint,   20000::bigint),
  ('T500',    200,   999,    250000::bigint,   50000::bigint),
  ('T2K',    1000,  4999,   1000000::bigint,  200000::bigint),
  ('T10K',   5000, 49999,   5000000::bigint, 1000000::bigint),
  ('T50K',  50000,  NULL,  25000000::bigint, 5000000::bigint)
) AS t(tier_id, price_min, price_max, l0, floor)
ON CONFLICT ("tier_id", "version") DO NOTHING;
