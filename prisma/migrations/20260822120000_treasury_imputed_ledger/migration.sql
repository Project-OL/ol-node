-- Treasury-based imputed master ledger: house account roles, treasury flow
-- classification overrides, and daily unit float snapshots.

CREATE TYPE "LedgerAccountRoleType" AS ENUM ('TREASURY', 'COMPANY_AGENCY');

CREATE TYPE "TreasuryFlowKind" AS ENUM ('COIN_TRADING_TRANSFER', 'AGENT_POINT_TRANSFER');

CREATE TYPE "TreasuryFlowClassificationType" AS ENUM (
  'SALE',
  'PROMO',
  'INTERNAL',
  'WRITE_OFF'
);

CREATE TABLE "ledger_account_roles" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "LedgerAccountRoleType" NOT NULL,
  "label" VARCHAR(120),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_admin_id" UUID,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ledger_account_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ledger_account_roles_user_id_key" ON "ledger_account_roles"("user_id");
CREATE INDEX "ledger_account_roles_role_is_active_idx" ON "ledger_account_roles"("role", "is_active");

ALTER TABLE "ledger_account_roles"
  ADD CONSTRAINT "ledger_account_roles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "treasury_flow_classifications" (
  "id" UUID NOT NULL,
  "flow_kind" "TreasuryFlowKind" NOT NULL,
  "flow_id" UUID NOT NULL,
  "classification" "TreasuryFlowClassificationType" NOT NULL,
  "reason" TEXT,
  "admin_user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "treasury_flow_classifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "treasury_flow_classifications_flow_kind_flow_id_key"
  ON "treasury_flow_classifications"("flow_kind", "flow_id");
CREATE INDEX "treasury_flow_classifications_classification_created_at_idx"
  ON "treasury_flow_classifications"("classification", "created_at" DESC);

CREATE TABLE "ledger_float_snapshots" (
  "id" UUID NOT NULL,
  "snapshot_at" TIMESTAMP(3) NOT NULL,
  "customer_coins" BIGINT NOT NULL DEFAULT 0,
  "customer_trading_coins" BIGINT NOT NULL DEFAULT 0,
  "customer_host_points" BIGINT NOT NULL DEFAULT 0,
  "customer_agency_points" BIGINT NOT NULL DEFAULT 0,
  "customer_total" BIGINT NOT NULL DEFAULT 0,
  "house_coins" BIGINT NOT NULL DEFAULT 0,
  "house_trading_coins" BIGINT NOT NULL DEFAULT 0,
  "house_points" BIGINT NOT NULL DEFAULT 0,
  "house_total" BIGINT NOT NULL DEFAULT 0,
  "ledger_net" BIGINT NOT NULL DEFAULT 0,
  "identity_delta" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ledger_float_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ledger_float_snapshots_snapshot_at_key"
  ON "ledger_float_snapshots"("snapshot_at");
CREATE INDEX "ledger_float_snapshots_snapshot_at_idx"
  ON "ledger_float_snapshots"("snapshot_at" DESC);
