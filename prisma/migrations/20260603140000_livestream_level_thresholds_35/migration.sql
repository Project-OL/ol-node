-- LIVESTREAM wallet levels: 35-tier curve (deactivate former Lv36–50).

UPDATE "wallet_level_configs" AS wlc
SET
  "threshold" = v.threshold,
  "is_active" = true,
  "updated_at" = NOW()
FROM (
  VALUES
    (1, 0::bigint),
    (2, 9500::bigint),
    (3, 66000::bigint),
    (4, 238000::bigint),
    (5, 615000::bigint),
    (6, 1365000::bigint),
    (7, 2920000::bigint),
    (8, 5520000::bigint),
    (9, 9980000::bigint),
    (10, 17620000::bigint),
    (11, 30180000::bigint),
    (12, 50620000::bigint),
    (13, 82850000::bigint),
    (14, 134800000::bigint),
    (15, 210500000::bigint),
    (16, 318000000::bigint),
    (17, 484000000::bigint),
    (18, 730000000::bigint),
    (19, 1085000000::bigint),
    (20, 1658000000::bigint),
    (21, 2485000000::bigint),
    (22, 3580000000::bigint),
    (23, 5060000000::bigint),
    (24, 7220000000::bigint),
    (25, 9980000000::bigint),
    (26, 13880000000::bigint),
    (27, 18850000000::bigint),
    (28, 29600000000::bigint),
    (29, 44300000000::bigint),
    (30, 59200000000::bigint),
    (31, 78800000000::bigint),
    (32, 98600000000::bigint),
    (33, 128800000000::bigint),
    (34, 158500000000::bigint),
    (35, 198000000000::bigint)
) AS v(level, threshold)
WHERE wlc."level_type" = 'LIVESTREAM' AND wlc."level" = v.level;

UPDATE "wallet_level_configs"
SET "is_active" = false, "updated_at" = NOW()
WHERE "level_type" = 'LIVESTREAM' AND "level" > 35;

UPDATE "wallet_user_levels" AS wul
SET
  "current_level" = COALESCE(
    (
      SELECT MAX(wlc."level")
      FROM "wallet_level_configs" wlc
      WHERE wlc."level_type" = 'LIVESTREAM'
        AND wlc."is_active" = true
        AND wlc."threshold" <= wul."cumulative_total"
    ),
    1
  ),
  "updated_at" = NOW()
WHERE wul."level_type" = 'LIVESTREAM';
