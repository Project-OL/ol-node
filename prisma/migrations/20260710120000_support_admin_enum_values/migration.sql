-- New enum values must land in their own migration: Postgres cannot use a value
-- added by ALTER TYPE ... ADD VALUE inside the same transaction, and Prisma wraps
-- each migration in one. Nothing in this migration (or any column default)
-- references these values — they are only written at runtime.
ALTER TYPE "AdminRole" ADD VALUE IF NOT EXISTS 'CUSTOMER_SUPPORT';
ALTER TYPE "SupportTicketStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "SupportTicketStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW';
