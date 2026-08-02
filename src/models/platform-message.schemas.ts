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

/** Durable post card for SYSTEM moderation warnings (survives post delete). */
export type PlatformPostRefSnapshot = {
  id: string
  caption: string | null
  /** ISO-8601 */
  createdAt: string
  /** Primary media (image or video). */
  mediaUrl: string
  /** Best-effort preview image (thumbnail for video; often null for images). */
  thumbnailUrl?: string | null
  mediaType?: 'IMAGE' | 'VIDEO'
}

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
  /** When set, client can deep-link to this post (e.g. moderation warning). */
  postId?: string
  /** Optional discriminator for linked entities (`post`, etc.). */
  refType?: 'post'
  /** Snapshot of the warned post for inbox UI (caption, time, image, id). */
  post?: PlatformPostRefSnapshot
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
