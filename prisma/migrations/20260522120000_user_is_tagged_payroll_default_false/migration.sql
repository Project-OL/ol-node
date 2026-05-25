-- Host tag flag on users (agency/admin configurable)
ALTER TABLE "users" ADD COLUMN "is_tagged" BOOLEAN NOT NULL DEFAULT false;

-- Revert agency payroll opt-in default to false
UPDATE "agencies" SET "payroll_enabled" = false;

ALTER TABLE "agencies" ALTER COLUMN "payroll_enabled" SET DEFAULT false;
