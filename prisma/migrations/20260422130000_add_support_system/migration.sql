-- CreateEnum
CREATE TYPE "SupportTicketType" AS ENUM ('CONSULT', 'REPORT_COMPLAINTS', 'FEEDBACK', 'BUSINESS_COOPERATION');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'AWAITING_REPLY', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportMessageSenderType" AS ENUM ('USER', 'SUPPORT');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "is_support" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" BIGSERIAL NOT NULL,
    "public_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "SupportTicketType" NOT NULL,
    "sub_type" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "image_url" TEXT,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'AWAITING_REPLY',
    "rating" INTEGER,
    "rated_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" BIGSERIAL NOT NULL,
    "public_id" TEXT NOT NULL,
    "ticket_id" BIGINT NOT NULL,
    "sender_user_id" UUID,
    "sender_type" "SupportMessageSenderType" NOT NULL,
    "content" TEXT NOT NULL,
    "image_url" TEXT,
    "is_auto_reply" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_public_id_key" ON "support_tickets"("public_id");

-- CreateIndex
CREATE INDEX "support_tickets_user_id_status_updated_at_idx" ON "support_tickets"("user_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_updated_at_idx" ON "support_tickets"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_messages_public_id_key" ON "support_messages"("public_id");

-- CreateIndex
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
