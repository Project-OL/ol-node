-- Additive MessageType for in-chat gift sends (coin debit + points/commission via gift send flow).
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'GIFT';
