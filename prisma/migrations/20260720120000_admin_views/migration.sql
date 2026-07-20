-- Admin panel views: named endpoint groups + per-admin assignments.
-- SUPER_ADMIN bypasses; any other admin with >=1 assignment is restricted to
-- (and granted) exactly the endpoints of their assigned views.
CREATE TABLE "admin_views" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "endpoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_views_name_key" ON "admin_views"("name");

CREATE TABLE "admin_view_assignments" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "view_id" TEXT NOT NULL,
    "assigned_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_view_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_view_assignments_admin_id_view_id_key"
    ON "admin_view_assignments"("admin_id", "view_id");
CREATE INDEX "admin_view_assignments_view_id_idx" ON "admin_view_assignments"("view_id");

ALTER TABLE "admin_view_assignments"
    ADD CONSTRAINT "admin_view_assignments_admin_id_fkey"
    FOREIGN KEY ("admin_id") REFERENCES "system_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "admin_view_assignments"
    ADD CONSTRAINT "admin_view_assignments_view_id_fkey"
    FOREIGN KEY ("view_id") REFERENCES "admin_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;
