-- B7: authoritative per-tier mode lives on lucky_tier_mode (not on config version rows).
-- Expand-only: lucky_tier_config.mode is retained and backfilled snapshots remain readable but unused by resolveEngine.
-- Rollback: DROP TABLE lucky_tier_mode; (restore readers to config.mode if rolling back app code).

CREATE TABLE IF NOT EXISTS lucky_tier_mode (
  tier_id    VARCHAR(8) PRIMARY KEY,
  mode       VARCHAR(16) NOT NULL DEFAULT 'off',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(128) NULL,
  CONSTRAINT lucky_tier_mode_mode_chk CHECK (mode IN ('off', 'shadow', 'enforce'))
);

-- Backfill from each tier's latest config version.
INSERT INTO lucky_tier_mode (tier_id, mode, updated_at, updated_by)
SELECT DISTINCT ON (c.tier_id)
  c.tier_id,
  c.mode,
  NOW(),
  'backfill-from-config'
FROM lucky_tier_config c
ORDER BY c.tier_id, c.version DESC
ON CONFLICT (tier_id) DO NOTHING;

-- Ensure every known tier id has a row even if config is missing (defensive).
INSERT INTO lucky_tier_mode (tier_id, mode, updated_by)
VALUES
  ('T100', 'off', 'backfill-default'),
  ('T500', 'off', 'backfill-default'),
  ('T2K', 'off', 'backfill-default'),
  ('T10K', 'off', 'backfill-default'),
  ('T50K', 'off', 'backfill-default')
ON CONFLICT (tier_id) DO NOTHING;
