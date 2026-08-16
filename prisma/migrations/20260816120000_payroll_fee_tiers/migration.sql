-- Withdrawal amount bands for platform fee + agent reward share.
CREATE TABLE IF NOT EXISTS "payroll_fee_tiers" (
    "id" UUID NOT NULL,
    "min_points" BIGINT NOT NULL,
    "max_points" BIGINT,
    "platform_fee_rate_bp" INTEGER NOT NULL,
    "agent_reward_rate_bp" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_fee_tiers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payroll_fee_tiers_is_active_sort_order_idx"
  ON "payroll_fee_tiers"("is_active", "sort_order");

-- Product defaults matching src/utils/payroll-fee.ts:
-- < 2L pts ($20) → 5% / 60%; 2L–<10L ($20–$100) → 3% / 60%; 10L+ → 2% / 60%.
INSERT INTO "payroll_fee_tiers" (
    "id", "min_points", "max_points", "platform_fee_rate_bp", "agent_reward_rate_bp",
    "sort_order", "is_active", "updated_at"
)
SELECT v.id, v.min_points, v.max_points, v.platform_fee_rate_bp, v.agent_reward_rate_bp,
       v.sort_order, true, CURRENT_TIMESTAMP
FROM (
    VALUES
        (gen_random_uuid(), 0::BIGINT, 200000::BIGINT, 500, 6000, 1),
        (gen_random_uuid(), 200000::BIGINT, 1000000::BIGINT, 300, 6000, 2),
        (gen_random_uuid(), 1000000::BIGINT, NULL::BIGINT, 200, 6000, 3)
) AS v(id, min_points, max_points, platform_fee_rate_bp, agent_reward_rate_bp, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM "payroll_fee_tiers" WHERE "is_active" = true);
