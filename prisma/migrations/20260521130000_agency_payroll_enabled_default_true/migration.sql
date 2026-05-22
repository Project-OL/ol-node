-- Enable payroll for all agencies by default (new + existing)

UPDATE "agencies" SET "payroll_enabled" = true WHERE "payroll_enabled" = false;

ALTER TABLE "agencies" ALTER COLUMN "payroll_enabled" SET DEFAULT true;
