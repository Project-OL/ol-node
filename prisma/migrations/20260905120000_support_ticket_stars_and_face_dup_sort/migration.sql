-- Per-admin ticket bookmarks: each CSA stars tickets into their own follow-up list.
CREATE TABLE "support_ticket_stars" (
    "ticket_id" BIGINT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_stars_pkey" PRIMARY KEY ("ticket_id","admin_id")
);

CREATE INDEX "support_ticket_stars_admin_id_created_at_idx"
    ON "support_ticket_stars"("admin_id", "created_at");

ALTER TABLE "support_ticket_stars"
    ADD CONSTRAINT "support_ticket_stars_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "support_ticket_stars"
    ADD CONSTRAINT "support_ticket_stars_admin_id_fkey"
    FOREIGN KEY ("admin_id") REFERENCES "system_admins"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Admin worklist ordering for the pending face-duplicate queue ("send to bottom").
ALTER TABLE "user_face_profiles"
    ADD COLUMN "admin_sort_weight" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "user_face_profiles_status_admin_sort_weight_updated_at_idx"
    ON "user_face_profiles"("status", "admin_sort_weight", "updated_at");
