-- Custom gift request coin flows (enum values isolated per Postgres same-tx rule)
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'CUSTOM_GIFT_REQUEST';
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'CUSTOM_GIFT_REFUND';
