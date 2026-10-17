-- BE-20 / lucky gifts: the host cut and the RTP target become admin settings.
-- Defaults are today's hardcoded Live-server values (host 4%, RTP 92%), so nothing changes on deploy.
ALTER TABLE "host_revenue_share_config"
  ADD COLUMN IF NOT EXISTS "lucky_host_share_bp" INTEGER NOT NULL DEFAULT 400,
  ADD COLUMN IF NOT EXISTS "lucky_target_rtp_bp" INTEGER NOT NULL DEFAULT 9200;
