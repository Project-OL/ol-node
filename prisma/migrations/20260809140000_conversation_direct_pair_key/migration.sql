-- Unique DIRECT pair key (nullable for GROUP / platform / unkeyed duplicate leftovers)

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "direct_pair_key" TEXT;

-- Backfill: for each unordered pair with a 2-member DIRECT thread, set key on the
-- oldest conversation only (duplicates keep NULL — report via scripts/report-duplicate-direct-conversations.ts).
WITH ranked AS (
  SELECT
    c.id AS conversation_id,
    (LEAST(m1.user_id::text, m2.user_id::text) || ':' || GREATEST(m1.user_id::text, m2.user_id::text)) AS pair_key,
    ROW_NUMBER() OVER (
      PARTITION BY LEAST(m1.user_id::text, m2.user_id::text), GREATEST(m1.user_id::text, m2.user_id::text)
      ORDER BY c.created_at ASC, c.id ASC
    ) AS rn
  FROM conversations c
  INNER JOIN conversation_members m1 ON m1.conversation_id = c.id
  INNER JOIN conversation_members m2
    ON m2.conversation_id = c.id AND m2.user_id::text > m1.user_id::text
  WHERE c.type = 'DIRECT'
    AND (
      SELECT COUNT(*)::int FROM conversation_members cm WHERE cm.conversation_id = c.id
    ) = 2
)
UPDATE conversations c
SET direct_pair_key = ranked.pair_key
FROM ranked
WHERE c.id = ranked.conversation_id
  AND ranked.rn = 1
  AND c.direct_pair_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_direct_pair_key_key"
  ON "conversations"("direct_pair_key");
