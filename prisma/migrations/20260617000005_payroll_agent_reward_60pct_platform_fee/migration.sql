-- Ensure agent reward is 60% of platform fee (6000 bp), not legacy 600 bp (6% of platform fee).
UPDATE payroll_config
SET agent_reward_rate_bp = 6000
WHERE id = 1 AND agent_reward_rate_bp <> 6000;
