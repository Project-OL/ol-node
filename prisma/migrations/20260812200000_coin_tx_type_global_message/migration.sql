-- Global broadcast message coin debit (platform-wide messaging feature).
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'GLOBAL_MESSAGE';
