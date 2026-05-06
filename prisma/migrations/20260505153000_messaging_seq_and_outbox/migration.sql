-- Messaging Phase 2: per-conversation seq, client idempotency key, transactional outbox

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "last_seq" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "seq" BIGINT;
ALTER TABLE "messages" ADD COLUMN "client_message_id" TEXT;

-- Backfill seq (deterministic order within each conversation)
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY conversation_id
      ORDER BY created_at ASC, id ASC
    )::bigint AS rn
  FROM messages
)
UPDATE messages m
SET seq = ranked.rn
FROM ranked
WHERE m.id = ranked.id;

ALTER TABLE "messages" ALTER COLUMN "seq" SET NOT NULL;

-- Sync conversation counters from messages
UPDATE conversations c
SET last_seq = COALESCE(s.mx, 0)
FROM (
  SELECT conversation_id, MAX(seq) AS mx
  FROM messages
  GROUP BY conversation_id
) s
WHERE c.id = s.conversation_id;

-- CreateTable
CREATE TABLE "message_outbox" (
    "id" BIGSERIAL NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "message_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "message_outbox_published_at_id_idx" ON "message_outbox"("published_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_client_message_id_key" ON "messages"("conversation_id", "client_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "messages_conversation_id_seq_idx" ON "messages"("conversation_id", "seq");
