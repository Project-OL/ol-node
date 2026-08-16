-- Persist the flat service fee taken from gross before platform/agent shares.
ALTER TABLE "withdrawals"
  ADD COLUMN IF NOT EXISTS "service_fee_points" BIGINT;

-- Admin-managed country → local currency per USD.
CREATE TABLE IF NOT EXISTS "payroll_country_fx_rates" (
    "id" UUID NOT NULL,
    "country" VARCHAR(80) NOT NULL,
    "country_code" VARCHAR(8),
    "currency_code" VARCHAR(8) NOT NULL,
    "rate_per_usd" DECIMAL(12, 4) NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_country_fx_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_country_fx_rates_country_key"
  ON "payroll_country_fx_rates"("country");

CREATE INDEX IF NOT EXISTS "payroll_country_fx_rates_is_active_sort_order_idx"
  ON "payroll_country_fx_rates"("is_active", "sort_order");

INSERT INTO "payroll_country_fx_rates" (
    "id", "country", "country_code", "currency_code", "rate_per_usd",
    "sort_order", "is_active", "updated_at"
)
SELECT v.id, v.country, v.country_code, v.currency_code, v.rate_per_usd,
       v.sort_order, true, CURRENT_TIMESTAMP
FROM (
    VALUES
        (
            gen_random_uuid(),
            'India',
            'IN',
            'INR',
            COALESCE((SELECT "inr_per_usd" FROM "payroll_config" WHERE "id" = 1), 94.00),
            1
        ),
        (
            gen_random_uuid(),
            'Nepal',
            'NP',
            'NPR',
            COALESCE((SELECT "npr_per_usd" FROM "payroll_config" WHERE "id" = 1), 150.00),
            2
        )
) AS v(id, country, country_code, currency_code, rate_per_usd, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM "payroll_country_fx_rates" WHERE "is_active" = true);
