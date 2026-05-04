-- CreateTable
CREATE TABLE "public_id_classification_progress" (
    "id" INTEGER NOT NULL,
    "last_classified_id" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_id_classification_progress_pkey" PRIMARY KEY ("id")
);

INSERT INTO "public_id_classification_progress" ("id", "last_classified_id", "updated_at")
VALUES (
    1,
    (SELECT GREATEST(34216663::bigint, COALESCE(MAX("public_id"), 0)) FROM "users"),
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
