-- Upsert agency commission level ladder (6 tiers: D, C, B, A, S, SS+)
INSERT INTO agency_commission_levels (level, min_window_points, live_rate_bp, match_chat_rate_bp, sort_order)
VALUES
  ('D', 0, 400, 400, 1),
  ('C', 1500000, 800, 800, 2),
  ('B', 7500000, 1200, 1200, 3),
  ('A', 35000000, 1600, 1600, 4),
  ('S', 100000000, 2000, 2000, 5),
  ('SS+', 250000000, 2400, 2400, 6)
ON CONFLICT (level) DO UPDATE SET
  min_window_points = EXCLUDED.min_window_points,
  live_rate_bp = EXCLUDED.live_rate_bp,
  match_chat_rate_bp = EXCLUDED.match_chat_rate_bp,
  sort_order = EXCLUDED.sort_order;
