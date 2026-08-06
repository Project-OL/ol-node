-- Exact IP allow-list for CSA / optional SUPER_ADMIN login enforcement
CREATE TABLE "admin_ip_whitelist" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_ip_whitelist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_ip_whitelist_admin_id_ip_address_key" ON "admin_ip_whitelist"("admin_id", "ip_address");

CREATE INDEX "admin_ip_whitelist_admin_id_idx" ON "admin_ip_whitelist"("admin_id");

ALTER TABLE "admin_ip_whitelist" ADD CONSTRAINT "admin_ip_whitelist_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "system_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
