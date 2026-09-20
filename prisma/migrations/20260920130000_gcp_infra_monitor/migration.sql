-- CreateEnum
CREATE TYPE "GcpResourceType" AS ENUM ('COMPUTE_VM', 'CLOUD_SQL', 'MEMORYSTORE_REDIS', 'LOAD_BALANCER', 'CLOUD_NAT', 'GCS_BUCKET');

-- CreateEnum
CREATE TYPE "GcpFlagSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "GcpFlagStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "gcp_resource_configs" (
    "id" TEXT NOT NULL,
    "resource_key" TEXT NOT NULL,
    "resource_type" "GcpResourceType" NOT NULL,
    "display_name" TEXT NOT NULL,
    "current_tier" TEXT NOT NULL,
    "current_specs_json" JSONB NOT NULL,
    "target_tier_for_2x" TEXT,
    "suggested_next_tier" TEXT,
    "estimated_monthly_cost_usd" DECIMAL(10,2),
    "thresholds_json" JSONB NOT NULL,
    "runbook_markdown" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gcp_resource_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gcp_usage_snapshots" (
    "id" TEXT NOT NULL,
    "resource_key" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "metrics_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gcp_usage_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gcp_infra_flags" (
    "id" TEXT NOT NULL,
    "resource_key" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DECIMAL(12,4) NOT NULL,
    "threshold" DECIMAL(12,4) NOT NULL,
    "severity" "GcpFlagSeverity" NOT NULL,
    "status" "GcpFlagStatus" NOT NULL DEFAULT 'OPEN',
    "message" TEXT NOT NULL,
    "first_detected_at" TIMESTAMP(3) NOT NULL,
    "last_notified_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gcp_infra_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gcp_resource_configs_resource_key_key" ON "gcp_resource_configs"("resource_key");

-- CreateIndex
CREATE INDEX "gcp_usage_snapshots_resource_key_captured_at_idx" ON "gcp_usage_snapshots"("resource_key", "captured_at" DESC);

-- CreateIndex
CREATE INDEX "gcp_infra_flags_resource_key_status_idx" ON "gcp_infra_flags"("resource_key", "status");

-- CreateIndex
CREATE INDEX "gcp_infra_flags_status_last_notified_at_idx" ON "gcp_infra_flags"("status", "last_notified_at");
