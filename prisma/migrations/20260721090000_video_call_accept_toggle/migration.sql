-- Global per-user video call availability toggle (default: accepting calls).
ALTER TABLE "video_call_settings"
  ADD COLUMN IF NOT EXISTS "accept_video_calls" BOOLEAN NOT NULL DEFAULT true;
