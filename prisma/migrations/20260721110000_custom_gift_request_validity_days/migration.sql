-- Optional requested gift validity (days) on custom gift requests.
ALTER TABLE "custom_gift_requests"
  ADD COLUMN IF NOT EXISTS "validity_days" INTEGER;
