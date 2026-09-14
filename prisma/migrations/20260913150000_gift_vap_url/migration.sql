-- Gift catalog: optional pre-built VAP animation file (Tencent Video Animation Player
-- format). Produced outside this system (designer/export tool) and uploaded as-is —
-- the backend never generates or muxes this file, it only stores and serves the URL.
-- Nullable and additive: a gift with `vap_url` set is a VAP gift, one without it keeps
-- rendering `effect_url` (mp4) exactly as before.
ALTER TABLE "gifts" ADD COLUMN "vap_url" TEXT;
