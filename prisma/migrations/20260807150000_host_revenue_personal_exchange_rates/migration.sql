-- Singleton: host revenue share basis points (defaults match prior TS constants).
CREATE TABLE IF NOT EXISTS "host_revenue_share_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "gift_receive_bp" INTEGER NOT NULL DEFAULT 6000,
    "subscription_bp" INTEGER NOT NULL DEFAULT 7500,
    "guardian_purchase_bp" INTEGER NOT NULL DEFAULT 7500,
    "video_call_host_share_bp" INTEGER NOT NULL DEFAULT 6000,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_admin_id" UUID,

    CONSTRAINT "host_revenue_share_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "host_revenue_share_config" (
    "id",
    "gift_receive_bp",
    "subscription_bp",
    "guardian_purchase_bp",
    "video_call_host_share_bp",
    "updated_at"
)
VALUES (1, 6000, 7500, 7500, 6000, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Personal (non-agent) point→coin exchange rate tiers.
CREATE TABLE IF NOT EXISTS "personal_exchange_rates" (
    "id" UUID NOT NULL,
    "min_usd_equiv" DECIMAL(12,2) NOT NULL,
    "max_usd_equiv" DECIMAL(12,2),
    "coins_per_usd" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "personal_exchange_rates_is_active_sort_order_idx"
  ON "personal_exchange_rates"("is_active", "sort_order");

-- Seed default personal tiers when table has no active rows.
INSERT INTO "personal_exchange_rates" (
    "id", "min_usd_equiv", "max_usd_equiv", "coins_per_usd", "sort_order", "is_active", "updated_at"
)
SELECT v.id, v.min_usd_equiv, v.max_usd_equiv, v.coins_per_usd, v.sort_order, true, CURRENT_TIMESTAMP
FROM (
    VALUES
        (gen_random_uuid(), 0::DECIMAL(12,2), 50::DECIMAL(12,2), 9000, 1),
        (gen_random_uuid(), 50::DECIMAL(12,2), 1000::DECIMAL(12,2), 9400, 2),
        (gen_random_uuid(), 1000::DECIMAL(12,2), NULL::DECIMAL(12,2), 9700, 3)
) AS v(id, min_usd_equiv, max_usd_equiv, coins_per_usd, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM "personal_exchange_rates" WHERE "is_active" = true);
