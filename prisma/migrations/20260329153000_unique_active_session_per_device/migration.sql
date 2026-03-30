-- One non-revoked session per (user_id, device_id): dedupe then partial unique index.
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, device_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
    ) AS rn
  FROM sessions
  WHERE is_revoked = false
)
UPDATE sessions s
SET
  is_active = false,
  is_revoked = true,
  revoked_at = NOW()
FROM ranked r
WHERE s.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX unique_active_session_per_device
ON sessions (user_id, device_id)
WHERE is_revoked = false;
