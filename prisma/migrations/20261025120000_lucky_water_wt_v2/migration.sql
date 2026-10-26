-- Closeout C9: ship weight table wt_v2_2026_10_25 (same band EVs as v1) with v_max_bp=10000
-- based on highest paid coins/USD found in seeds/defaults (= 10000 from trading topup).
-- All tiers remain mode='off'. Does not mutate wt_v1 rows.
-- Rollback: DELETE FROM lucky_tier_config WHERE weight_table_id = 'wt_v2_2026_10_25';

INSERT INTO lucky_tier_config (
  id, tier_id, version, mode, price_min, price_max, r_bp, j_bp, l0, floor,
  lambda_critical_max_bp, lambda_low_max_bp, lambda_normal_max_bp,
  band_weights_json, weight_table_id, m_max, v_max_bp, safety_margin_bp, min_gap_bp,
  daily_win_cap_coins, cool_down_after_big_win_seconds, created_by, created_at
)
SELECT
  gen_random_uuid(),
  c.tier_id,
  (SELECT COALESCE(MAX(v.version), 0) + 1 FROM lucky_tier_config v WHERE v.tier_id = c.tier_id),
  'off',
  c.price_min,
  c.price_max,
  c.r_bp,
  c.j_bp,
  c.l0,
  c.floor,
  c.lambda_critical_max_bp,
  c.lambda_low_max_bp,
  c.lambda_normal_max_bp,
  c.band_weights_json,
  'wt_v2_2026_10_25',
  c.m_max,
  10000,
  c.safety_margin_bp,
  c.min_gap_bp,
  c.daily_win_cap_coins,
  c.cool_down_after_big_win_seconds,
  'closeout-c9',
  NOW()
FROM lucky_tier_config c
WHERE c.weight_table_id = 'wt_v1_2026_10_24'
  AND c.version = 1
  AND NOT EXISTS (
    SELECT 1 FROM lucky_tier_config x
    WHERE x.tier_id = c.tier_id AND x.weight_table_id = 'wt_v2_2026_10_25'
  );
