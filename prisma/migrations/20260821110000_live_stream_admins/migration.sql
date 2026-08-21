-- Host-appointed live co-admins (unique host + admin user pair).

CREATE TABLE "live_stream_admins" (
    "id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_stream_admins_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "live_stream_admins_host_user_id_idx" ON "live_stream_admins"("host_user_id");

CREATE INDEX "live_stream_admins_admin_user_id_idx" ON "live_stream_admins"("admin_user_id");

CREATE UNIQUE INDEX "live_stream_admins_host_user_id_admin_user_id_key" ON "live_stream_admins"("host_user_id", "admin_user_id");

ALTER TABLE "live_stream_admins" ADD CONSTRAINT "live_stream_admins_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "live_stream_admins" ADD CONSTRAINT "live_stream_admins_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
