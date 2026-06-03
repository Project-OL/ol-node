-- Remove unused MYSTERY_CHEST point ledger type (never credited in application code).

UPDATE "point_ledger_entries"
SET "tx_type" = 'ADJUSTMENT'
WHERE "tx_type" = 'MYSTERY_CHEST';

CREATE TYPE "PointTxType_new" AS ENUM (
  'LIVESTREAM_GIFT',
  'SUBSCRIPTION',
  'COMMISSION',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'PLATFORM_REWARD',
  'WITHDRAWAL',
  'WITHDRAWAL_REFUND',
  'ADJUSTMENT',
  'VIDEO_CALL',
  'GIFT_RECEIVE',
  'AGENCY_FORCE_EXIT_PENALTY',
  'AGENT_COMMISSION',
  'AGENT_POINT_TRANSFER',
  'PAYROLL_PROCESSING_REWARD',
  'WITHDRAWAL_ESCROW',
  'WITHDRAWAL_ESCROW_SETTLED',
  'PAYROLL_HOST_PAYOUT'
);

ALTER TABLE "point_ledger_entries"
  ALTER COLUMN "tx_type" TYPE "PointTxType_new"
  USING ("tx_type"::text::"PointTxType_new");

DROP TYPE "PointTxType";

ALTER TYPE "PointTxType_new" RENAME TO "PointTxType";
