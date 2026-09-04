-- Canned reply templates CSAs can send to open support tickets.
CREATE TABLE "support_reply_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(150) NOT NULL,
    "content" TEXT NOT NULL,
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_reply_templates_pkey" PRIMARY KEY ("id")
);
