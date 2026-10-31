import { z } from 'zod'

export const setPresenceBodySchema = z.object({
  online: z.boolean(),
})

export const bulkPresenceBodySchema = z.object({
  userIds: z.array(z.string().guid()).min(1).max(100),
})

export type PublicPresenceDto = {
  userId: string
  isOnline: boolean
  lastActiveAt: string | null
  lastOnlineSeconds: number | null
  lastOnlineLabel: string | null
  /** Hosting a live right now. Not hidden by invisible-online: a live is public on the feed. */
  isLive: boolean
  /** Room to join when `isLive`; null otherwise. */
  liveStreamId: string | null
}
