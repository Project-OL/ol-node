-- Normal Host tier is evaluated once per UTC day (receiving up to 00:00 UTC) and fixed for the day.
CREATE TABLE "normal_host_daily_tiers" (
    "user_id" UUID NOT NULL,
    "reward_date" DATE NOT NULL,
    "threshold_points" BIGINT,
    "hourly_rate_points" BIGINT,
    "hour_cap_hours" INTEGER,
    "window_days" INTEGER,
    "earnings_by_window" JSONB NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "normal_host_daily_tiers_pkey" PRIMARY KEY ("user_id","reward_date")
);

CREATE INDEX "normal_host_daily_tiers_reward_date_idx" ON "normal_host_daily_tiers"("reward_date");

ALTER TABLE "normal_host_daily_tiers" ADD CONSTRAINT "normal_host_daily_tiers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
