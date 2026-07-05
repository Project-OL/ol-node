-- Separate inbox threads per platform message category
ALTER TYPE "ConversationType" ADD VALUE IF NOT EXISTS 'SYSTEM';
ALTER TYPE "ConversationType" ADD VALUE IF NOT EXISTS 'NOTIFICATION';
ALTER TYPE "ConversationType" ADD VALUE IF NOT EXISTS 'TRANSACTIONAL';
