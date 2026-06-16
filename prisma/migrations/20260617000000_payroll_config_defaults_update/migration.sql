-- Add nprPerUsd column to payroll_config
ALTER TABLE payroll_config
ADD COLUMN npr_per_usd DECIMAL(10,4) NOT NULL DEFAULT 150.00;

-- Update singleton row with all correct default values
UPDATE payroll_config
SET
  platform_fee_rate_bp = 500,
  agent_reward_rate_bp = 600,
  service_fee_usd = 1.00,
  min_withdrawal_usd = 10.00,
  max_withdrawal_usd = 10000000.00,
  sla_hours = 2,
  waiting_hours = 2,
  max_assignment_attempts = 5,
  inr_per_usd = 94.00,
  npr_per_usd = 150.00
WHERE id = 1;
