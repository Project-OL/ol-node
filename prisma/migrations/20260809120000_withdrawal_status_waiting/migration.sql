-- Persist WAITING on withdrawals after agency proof upload (host dispute window).
-- Additive enum only — no backfill of existing PENDING + assignment WAITING rows
-- (host history maps those at read time).
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'WAITING';
