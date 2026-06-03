-- Host earnings from guardian badge purchases (50% of coins paid → points).
ALTER TYPE "PointTxType" ADD VALUE IF NOT EXISTS 'GUARDIAN_PURCHASE';
