ALTER TABLE "support_tickets"
ADD COLUMN "user_last_read_message_id" BIGINT,
ADD COLUMN "cs_last_read_message_id" BIGINT;
