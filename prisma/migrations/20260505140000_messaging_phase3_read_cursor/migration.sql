-- Phase 3: read receipts (WebSocket coalesced flush persists cursor)
ALTER TABLE "conversation_members" ADD COLUMN "last_read_message_id" TEXT;
