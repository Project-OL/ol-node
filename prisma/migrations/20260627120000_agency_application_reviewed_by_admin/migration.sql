-- reviewed_by stores system_admins.id from admin JWT (not users.id).
-- Drop incorrect FK to users; no replacement FK (system_admins.id is TEXT, reviewed_by is UUID).
ALTER TABLE "agency_agent_applications" DROP CONSTRAINT IF EXISTS "agency_agent_applications_reviewed_by_fkey";
