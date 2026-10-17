-- LIVE-38: Live-server hot-path aggregates. Additive; tables are small (gift_transactions ~8k rows,
-- video_call_sessions ~80 on 2026-10-17), so a plain CREATE INDEX holds its lock for milliseconds.
-- Fans ranking / end summary / host stats: receiver + time window.
CREATE INDEX IF NOT EXISTS "gift_transactions_receiver_user_id_created_at_idx"
  ON "gift_transactions" ("receiver_user_id", "created_at");
-- Viewer sort (7-day total per sender for one host).
-- (Prisma's 63-char-truncated name, so `migrate diff` stays clean.)
CREATE INDEX IF NOT EXISTS "gift_transactions_receiver_user_id_sender_user_id_created_a_idx"
  ON "gift_transactions" ("receiver_user_id", "sender_user_id", "created_at");
-- The billing / ringing sweeps (status = ACTIVE / RINGING every 5 s).
CREATE INDEX IF NOT EXISTS "video_call_sessions_status_started_at_idx"
  ON "video_call_sessions" ("status", "started_at");
