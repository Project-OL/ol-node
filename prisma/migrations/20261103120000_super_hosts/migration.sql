-- BE-30: super_hosts was read and written with raw SQL (super-host.repository.ts) but no migration
-- ever created it, so every environment logged `relation "super_hosts" does not exist`, reads fell
-- back to "no super hosts", and the admin grant failed. Additive only: new table, no change to
-- existing data. Idempotent in case an environment created it by hand.
--
-- Rollback: DROP TABLE IF EXISTS "super_hosts"; (the repository treats a missing table as empty)

CREATE TABLE IF NOT EXISTS "super_hosts" (
    "user_id" UUID NOT NULL,
    "granted_by_user_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "revoked_by_user_id" UUID,

    CONSTRAINT "super_hosts_pkey" PRIMARY KEY ("user_id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'super_hosts_user_id_fkey') THEN
    ALTER TABLE "super_hosts" ADD CONSTRAINT "super_hosts_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
