import { z } from 'zod'

export const platformMessageBodySchema = z.object({
  message: z.string().min(1).max(4000),
})

export const platformNotificationBroadcastBodySchema = z.object({
  message: z.string().min(1).max(4000),
  /** When omitted, sends to all active non-support users (batched via queue). */
  userIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  campaignId: z.string().min(1).max(128).optional(),
})

export type PlatformMessageMetadata = {
  category: 'transactional' | 'system' | 'notification'
  walletCurrency?: 'COIN' | 'POINT' | 'TRADING_COIN'
  direction?: 'CREDIT' | 'DEBIT'
  txType?: string
  txLabel?: string
  amount?: string
  balanceAfter?: string
  ledgerEntryId?: string
  refId?: string
  counterparty?: {
    userId?: string
    displayName?: string
    publicId?: string
    avatarUrl?: string | null
  }
  withdrawalId?: string
  withdrawalEvent?: string
  withdrawalStatus?: string
  agent?: {
    userId: string
    displayName: string
    publicId: string
    avatarUrl?: string | null
  }
  campaignId?: string
  adminUserId?: string
}
