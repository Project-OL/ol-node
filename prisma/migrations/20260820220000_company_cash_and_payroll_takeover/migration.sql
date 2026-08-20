-- Company cash journal + payroll takeover inventory tx type.

ALTER TYPE "PointTxType" ADD VALUE IF NOT EXISTS 'PAYROLL_TAKEOVER_INVENTORY';

CREATE TYPE "CompanyCashDirection" AS ENUM ('IN', 'OUT');

CREATE TYPE "CompanyCashReason" AS ENUM (
  'AGENCY_TRADING_PURCHASE',
  'EPAY_PAYOUT',
  'PAYROLL_TAKEOVER_PAYOUT'
);

CREATE TABLE "company_cash_entries" (
  "id" UUID NOT NULL,
  "direction" "CompanyCashDirection" NOT NULL,
  "reason" "CompanyCashReason" NOT NULL,
  "amount_usd" DECIMAL(18,4) NOT NULL,
  "units_amount" BIGINT,
  "currency_type" "WalletCurrencyType",
  "counterparty_user_id" UUID,
  "ledger_ref_id" VARCHAR(255),
  "withdrawal_id" UUID,
  "description" TEXT,
  "promotional" BOOLEAN NOT NULL DEFAULT false,
  "admin_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "company_cash_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "company_cash_entries_created_at_idx" ON "company_cash_entries"("created_at" DESC);
CREATE INDEX "company_cash_entries_reason_created_at_idx" ON "company_cash_entries"("reason", "created_at" DESC);
CREATE INDEX "company_cash_entries_withdrawal_id_idx" ON "company_cash_entries"("withdrawal_id");
CREATE INDEX "company_cash_entries_counterparty_user_id_idx" ON "company_cash_entries"("counterparty_user_id");
