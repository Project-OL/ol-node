-- INF-23: separate "ops password" for capacity changes from the admin page. Set only by the
-- CLI (dist/cli/set-ops-password.js) on the VM, never through the API. Additive table.
CREATE TABLE IF NOT EXISTS "admin_ops_credentials" (
    "admin_id" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admin_ops_credentials_pkey" PRIMARY KEY ("admin_id")
);
