-- Restore GUARDIAN_PURCHASE on PointTxType.
-- Added in 20260601180000, then dropped when 20260603120000 recreated the enum without it.
ALTER TYPE "PointTxType" ADD VALUE IF NOT EXISTS 'GUARDIAN_PURCHASE';
