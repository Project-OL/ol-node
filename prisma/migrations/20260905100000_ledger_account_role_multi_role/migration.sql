-- Allow a single user to hold more than one ledger account role (e.g. an
-- existing TREASURY account can also be registered as GAME_HOUSE) — they
-- settle different wallets (TRADING_COIN vs DIAMOND) and are not mutually
-- exclusive. Previously `user_id` alone was unique, so assigning a second
-- role to an already-registered account would overwrite the first one.

-- DropIndex
DROP INDEX "ledger_account_roles_user_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_roles_user_id_role_key" ON "ledger_account_roles"("user_id", "role");
