-- Crash & reconnect hardening (BE-03 / BE-04). Additive only.
-- live_streams.end_reason: why a stream ended (MANUAL_USER_END, NO_LIVEKIT_HOST, HEARTBEAT_LOST, ...).
--   Written by Live-server's endLiveStreamService; before this it existed only in pm2 logs.
-- live_failure_events: every live / call / socket / app failure event with a severity, kept 90 days
--   (Live-server prunes older rows). Rollback: DROP TABLE live_failure_events; ALTER TABLE live_streams DROP COLUMN end_reason;

ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS end_reason VARCHAR(64) NULL;

CREATE TABLE IF NOT EXISTS live_failure_events (
  id           UUID PRIMARY KEY,
  occurred_at  TIMESTAMPTZ(6) NOT NULL,
  received_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  kind         VARCHAR(32) NOT NULL,
  area         VARCHAR(16) NOT NULL,
  failure_code VARCHAR(64) NOT NULL,
  severity     VARCHAR(2) NOT NULL,
  source       VARCHAR(8) NOT NULL,
  user_id      UUID NULL,
  stream_id    VARCHAR(64) NULL,
  call_id      VARCHAR(64) NULL,
  role         VARCHAR(16) NULL,
  status       INTEGER NULL,
  message      VARCHAR(300) NULL,
  app_version  VARCHAR(40) NULL,
  platform     VARCHAR(16) NULL,
  device_model VARCHAR(64) NULL,
  network      VARCHAR(16) NULL,
  meta         JSONB NULL,
  CONSTRAINT live_failure_events_severity_chk CHECK (severity IN ('S0', 'S1', 'S2', 'S3', 'S4'))
);

CREATE INDEX IF NOT EXISTS live_failure_events_occurred_idx ON live_failure_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS live_failure_events_user_idx ON live_failure_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS live_failure_events_code_idx ON live_failure_events (failure_code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS live_failure_events_severity_idx ON live_failure_events (severity, occurred_at DESC);
