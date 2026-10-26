-- TRF-04: one row per (IST day, section); section '*' = all app sections. Users are distinct
-- (HyperLogLog union of the day), so they cannot be summed from traffic_hourly.
-- Additive. Rollback: DROP TABLE traffic_daily;

CREATE TABLE IF NOT EXISTS traffic_daily (
  day        DATE NOT NULL,
  section    VARCHAR(32) NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  users      INTEGER NOT NULL DEFAULT 0,
  errors_5xx INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT traffic_daily_pkey PRIMARY KEY (day, section)
);
