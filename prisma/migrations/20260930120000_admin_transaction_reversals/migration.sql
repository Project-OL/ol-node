-- One row per admin-reverted source (a transfer, or a ledger row with no transfer record).
-- The unique (source_kind, source_id) index is the once-only guarantee: the row is inserted in the
-- same transaction as the reversal debit/credit, so a second revert of the same source fails.
-- No FKs on the user/admin/ledger ids: this is an audit record and must survive account deletion.
CREATE TABLE "admin_transaction_reversals" (
    "id" UUID NOT NULL,
    "source_kind" VARCHAR(32) NOT NULL,
    "source_id" UUID NOT NULL,
    "currency" VARCHAR(20) NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "receiver_user_id" UUID NOT NULL,
    "original_amount" BIGINT NOT NULL,
    "recovered_amount" BIGINT NOT NULL,
    "shortfall_amount" BIGINT NOT NULL,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "debit_ledger_entry_id" UUID,
    "credit_ledger_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_transaction_reversals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_transaction_reversals_source_kind_source_id_key" ON "admin_transaction_reversals"("source_kind", "source_id");

CREATE INDEX "admin_transaction_reversals_receiver_user_id_created_at_idx" ON "admin_transaction_reversals"("receiver_user_id", "created_at" DESC);
