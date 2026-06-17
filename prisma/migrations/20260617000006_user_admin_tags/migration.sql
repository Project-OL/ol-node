-- Admin-assigned string tags per user (visible on /users/me and user search).
ALTER TABLE "users" ADD COLUMN "admin_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
