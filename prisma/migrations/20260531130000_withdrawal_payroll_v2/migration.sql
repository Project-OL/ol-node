-- Withdrawal & payroll v2: unconfirmed-points escrow model
-- 1. New PointTxType enum values (escrow soft-mark, settlement debit, agent host payout)
ALTER TYPE "PointTxType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_ESCROW';
ALTER TYPE "PointTxType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_ESCROW_SETTLED';
ALTER TYPE "PointTxType" ADD VALUE IF NOT EXISTS 'PAYROLL_HOST_PAYOUT';

-- 2. Wallet unconfirmed-points tracking (POINT wallet only; sum of open escrows)
ALTER TABLE "wallets"
  ADD COLUMN "unconfirmed_points" BIGINT NOT NULL DEFAULT 0;

-- Never let in-flight escrow go negative.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_unconfirmed_non_negative" CHECK ("unconfirmed_points" >= 0);

-- 3. Withdrawal version flag: 1 = legacy real-debit, 2 = escrow flow.
ALTER TABLE "withdrawals"
  ADD COLUMN "withdrawal_version" INTEGER NOT NULL DEFAULT 1;
