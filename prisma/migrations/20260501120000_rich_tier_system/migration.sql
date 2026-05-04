-- Rich Tier (Elite Tier) monthly recharge aggregates and rollover state

CREATE TABLE "monthly_recharge_aggregates" (
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "total_recharge_coins" BIGINT NOT NULL DEFAULT 0,
    "recharge_count" INTEGER NOT NULL DEFAULT 0,
    "last_recharge_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "monthly_recharge_aggregates_pkey" PRIMARY KEY ("user_id","year","month")
);

CREATE INDEX "monthly_recharge_aggregates_year_month_total_desc_idx"
ON "monthly_recharge_aggregates" ("year", "month", "total_recharge_coins" DESC);

ALTER TABLE "monthly_recharge_aggregates"
ADD CONSTRAINT "monthly_recharge_aggregates_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_rich_tier" (
    "user_id" UUID NOT NULL,
    "current_tier" INTEGER NOT NULL DEFAULT 0,
    "evaluated_from_year" INTEGER NOT NULL DEFAULT 0,
    "evaluated_from_month" INTEGER NOT NULL DEFAULT 0,
    "evaluated_recharge_coins" BIGINT NOT NULL DEFAULT 0,
    "carryover_coins" BIGINT NOT NULL DEFAULT 0,
    "last_rolled_over_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_rich_tier_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX "user_rich_tier_tier_evaluated_idx"
ON "user_rich_tier" ("current_tier", "evaluated_from_year", "evaluated_from_month");

ALTER TABLE "user_rich_tier"
ADD CONSTRAINT "user_rich_tier_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "rich_tier_history" (
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "tier" INTEGER NOT NULL,
    "total_progress_coins" BIGINT NOT NULL,
    "carryover_applied" BIGINT NOT NULL,
    "pure_recharge_coins" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rich_tier_history_pkey" PRIMARY KEY ("user_id","year","month")
);

CREATE INDEX "rich_tier_history_year_month_tier_idx"
ON "rich_tier_history" ("year", "month", "tier");

ALTER TABLE "rich_tier_history"
ADD CONSTRAINT "rich_tier_history_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "rich_tier_configs" (
    "tier" INTEGER NOT NULL,
    "min_recharge_coins" BIGINT NOT NULL,
    "display_name" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rich_tier_configs_pkey" PRIMARY KEY ("tier")
);

INSERT INTO "rich_tier_configs" ("tier", "min_recharge_coins", "display_name") VALUES
(1, 3000000, 'RICH I'),
(2, 5000000, 'RICH II'),
(3, 10000000, 'RICH III'),
(4, 20000000, 'RICH IV'),
(5, 30000000, 'RICH V'),
(6, 50000000, 'RICH VI'),
(7, 100000000, 'RICH VII'),
(8, 200000000, 'RICH VIII'),
(9, 500000000, 'RICH IX'),
(10, 1000000000, 'RICH X')
ON CONFLICT ("tier") DO NOTHING;
