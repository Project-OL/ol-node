-- agent_reward_rate_bp is now a share of platform fee (6000 bp = 60%), not % of gross withdrawal.
UPDATE payroll_config
SET agent_reward_rate_bp = 6000
WHERE id = 1;
