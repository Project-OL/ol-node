-- Withdrawal UI Phase 3b: payment method name split, branch, withdrawal notes

ALTER TABLE "user_payment_methods"
  ADD COLUMN IF NOT EXISTS "account_holder_first_name" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "account_holder_last_name" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "branch" VARCHAR(150);

ALTER TABLE "withdrawals"
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- Widen registered_phone if previously VARCHAR(20)
ALTER TABLE "user_payment_methods"
  ALTER COLUMN "registered_phone" TYPE VARCHAR(30);
