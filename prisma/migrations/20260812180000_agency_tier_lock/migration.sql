-- Admin-assigned commission tier lock: floor for one rolling-window duration.
ALTER TABLE "agencies"
  ADD COLUMN "tier_lock_level" VARCHAR(8),
  ADD COLUMN "tier_lock_until" TIMESTAMP(3),
  ADD COLUMN "tier_lock_bonus_points" BIGINT;
