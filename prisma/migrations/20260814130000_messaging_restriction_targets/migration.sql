-- Recipients a MESSAGING_DISABLE restriction applies to.
-- No rows on a restriction = legacy global send ban (all recipients).

CREATE TABLE "user_restriction_targets" (
    "id" UUID NOT NULL,
    "restriction_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,

    CONSTRAINT "user_restriction_targets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_restriction_targets_restriction_id_target_user_id_key" ON "user_restriction_targets"("restriction_id", "target_user_id");

CREATE INDEX "user_restriction_targets_target_user_id_idx" ON "user_restriction_targets"("target_user_id");

ALTER TABLE "user_restriction_targets" ADD CONSTRAINT "user_restriction_targets_restriction_id_fkey" FOREIGN KEY ("restriction_id") REFERENCES "user_restrictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_restriction_targets" ADD CONSTRAINT "user_restriction_targets_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
