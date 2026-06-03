-- Payroll WAITING state: challenge window after proof upload

ALTER TABLE withdrawal_payroll_assignments
  ADD COLUMN waiting_expires_at TIMESTAMPTZ;

ALTER TABLE withdrawal_payroll_assignments
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE withdrawal_payroll_assignments
SET updated_at = COALESCE(completed_at, rejected_at, assigned_at, created_at);

ALTER TABLE payroll_config
  ADD COLUMN waiting_hours INT NOT NULL DEFAULT 2;

CREATE INDEX IF NOT EXISTS idx_payroll_assignments_agent_status_updated
  ON withdrawal_payroll_assignments (agency_user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_payroll_assignments_agent_waiting
  ON withdrawal_payroll_assignments (agency_user_id, status)
  WHERE status = 'WAITING';
