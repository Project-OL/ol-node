-- Allowed video-call pricePerMin values by host livestream level band.
CREATE TABLE IF NOT EXISTS "video_call_price_caps" (
    "id" UUID NOT NULL,
    "min_level" INTEGER NOT NULL,
    "max_level" INTEGER,
    "price" INTEGER NOT NULL,
    "label" VARCHAR(64),
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_call_price_caps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "video_call_price_caps_is_active_sort_order_idx"
  ON "video_call_price_caps"("is_active", "sort_order");

-- Product defaults matching Call Price UI:
-- ≤Lv4 → 1800; Lv5-9 → 2400; Lv10+ choices → 3000/3600/4800/6000/7200.
INSERT INTO "video_call_price_caps" (
    "id", "min_level", "max_level", "price", "label", "sort_order", "is_active", "updated_at"
)
SELECT v.id, v.min_level, v.max_level, v.price, v.label, v.sort_order, true, CURRENT_TIMESTAMP
FROM (
    VALUES
        (gen_random_uuid(), 1, 4, 1800, '≤Lv4', 1),
        (gen_random_uuid(), 5, 9, 2400, 'Lv5-9', 2),
        (gen_random_uuid(), 10, NULL::INTEGER, 3000, 'Lv10 & Above', 3),
        (gen_random_uuid(), 10, NULL::INTEGER, 3600, 'Lv10 & Above', 4),
        (gen_random_uuid(), 10, NULL::INTEGER, 4800, 'Lv10 & Above', 5),
        (gen_random_uuid(), 10, NULL::INTEGER, 6000, 'Lv10 & Above', 6),
        (gen_random_uuid(), 10, NULL::INTEGER, 7200, 'Lv10 & Above', 7)
) AS v(id, min_level, max_level, price, label, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM "video_call_price_caps" WHERE "is_active" = true);
