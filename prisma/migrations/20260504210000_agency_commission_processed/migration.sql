-- Idempotency: one row per host point ledger CREDIT processed for agency commission (covers zero-commission credits).
CREATE TABLE "agency_commission_processed" (
    "host_ledger_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_commission_processed_pkey" PRIMARY KEY ("host_ledger_entry_id")
);
