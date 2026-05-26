-- 1. New table: one row per stream session
CREATE TABLE host_live_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agency_user_id    UUID        NOT NULL,
  room_id           TEXT        NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  duration_seconds  BIGINT,
  status            TEXT        NOT NULL DEFAULT 'ACTIVE'
                                CHECK (status IN ('ACTIVE','ENDED','INTERRUPTED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_hls_host_status     ON host_live_sessions (host_user_id, status);
CREATE INDEX idx_hls_agency_day      ON host_live_sessions (agency_user_id, started_at);
CREATE INDEX idx_hls_active_started  ON host_live_sessions (started_at) WHERE status = 'ACTIVE';

-- Ensures one ACTIVE session per host at most
CREATE UNIQUE INDEX idx_hls_one_active_per_host
  ON host_live_sessions (host_user_id)
  WHERE status = 'ACTIVE';

COMMENT ON TABLE host_live_sessions IS
  'One row per host live stream session. ACTIVE while streaming, ENDED on clean stop,
   INTERRUPTED by safety-net for sessions with no end event after LIVE_SESSION_TIMEOUT_HOURS.';

COMMENT ON COLUMN host_live_sessions.duration_seconds IS
  'Null while ACTIVE. Set on ENDED/INTERRUPTED. For INTERRUPTED, = floor(ended_at - started_at).';

-- 2. Add live_duration_seconds to agency_daily_earnings
ALTER TABLE agency_daily_earnings
  ADD COLUMN IF NOT EXISTS live_duration_seconds BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN agency_daily_earnings.live_duration_seconds IS
  'Total live streaming seconds for this host on this UTC calendar day under this agency.
   Incremented atomically when a session ends. Never decremented.';
