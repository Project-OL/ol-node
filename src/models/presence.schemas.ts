import { z } from 'zod'

export const setPresenceBodySchema = z.object({
  online: z.boolean(),
})

export const bulkPresenceBodySchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(100),
})

export type PublicPresenceDto = {
  userId: string
  isOnline: boolean
  lastActiveAt: string | null
  lastOnlineSeconds: number | null
  lastOnlineLabel: string | null
}
