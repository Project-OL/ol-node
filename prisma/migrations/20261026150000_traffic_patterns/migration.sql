-- TRF-01..04: traffic patterns for the admin Traffic page. Counts only (no user ids, no IPs).
-- Additive: two new tables, nothing else touched. Rollback: DROP TABLE traffic_minute, traffic_hourly;

CREATE TABLE IF NOT EXISTS traffic_minute (
  minute            TIMESTAMPTZ(6) PRIMARY KEY,
  online_users      INTEGER NOT NULL,
  hosts_live        INTEGER NULL,
  live_viewers      INTEGER NULL,
  calls_active      INTEGER NULL,
  users_in_calls    INTEGER NULL,
  live_socket_users INTEGER NULL,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS traffic_hourly (
  hour       TIMESTAMPTZ(6) NOT NULL,
  section    VARCHAR(32) NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  users      INTEGER NOT NULL DEFAULT 0,
  errors_5xx INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT traffic_hourly_pkey PRIMARY KEY (hour, section)
);
