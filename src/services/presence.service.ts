import { PRESENCE_HEARTBEAT_TTL_SEC, redisClient, RedisKeys } from '../config/redis'
import { prismaRead } from '../config/database'
import { touchUserLastActive } from '../middlewares/lastActiveTracker.middleware'
import { privacyService } from './privacy.service'
import { formatLastOnline } from '../utils/last-online'
import type { PublicPresenceDto } from '../models/presence.schemas'
import type { ServerFrame } from '../realtime/types'

const DECR_PRESENCE_CLAMP = `
local v = redis.call('DECR', KEYS[1])
if v < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return v
`

function presenceFrame(userId: string, online: boolean): ServerFrame {
  return { t: 'PRESENCE', userId, online }
}

function publishPresence(userId: string, online: boolean): Promise<number> {
  const frame = presenceFrame(userId, online)
  return redisClient.publish(
    RedisKeys.presenceChannel(userId),
    JSON.stringify(frame, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  )
}

export const presenceService = {
  /**
   * One WebSocket connected for this user. INCR count; on 0→1 set `online` and publish.
   */
  async recordSocketConnected(userId: string): Promise<void> {
    const n = await redisClient.incr(RedisKeys.presenceCount(userId))
    if (n === 1) {
      await redisClient.set(
        RedisKeys.userOnlineStatus(userId),
        '1',
        'EX',
        PRESENCE_HEARTBEAT_TTL_SEC,
      )
      await touchUserLastActive(userId)
      await publishPresence(userId, true)
    }
  },

  /**
   * One WebSocket closed. DECR with floor 0; on →0 clear `online` and publish.
   */
  async recordSocketDisconnected(userId: string): Promise<void> {
    const after = (await redisClient.eval(
      DECR_PRESENCE_CLAMP,
      1,
      RedisKeys.presenceCount(userId),
    )) as number
    if (after === 0) {
      await redisClient.del(RedisKeys.userOnlineStatus(userId))
      await publishPresence(userId, false)
    }
  },

  /** PING / HTTP heartbeat: refresh `online:{userId}` so DM / presence stay warm. */
  async refreshOnlineHeartbeat(userId: string): Promise<void> {
    await redisClient.set(RedisKeys.userOnlineStatus(userId), '1', 'EX', PRESENCE_HEARTBEAT_TTL_SEC)
    await touchUserLastActive(userId)
  },

  /** HTTP or foreground app: mark online + refresh last-active timestamp. */
  async setUserOnline(userId: string): Promise<void> {
    const wasOnline = await redisClient.get(RedisKeys.userOnlineStatus(userId))
    await redisClient.set(
      RedisKeys.userOnlineStatus(userId),
      '1',
      'EX',
      PRESENCE_HEARTBEAT_TTL_SEC,
    )
    await touchUserLastActive(userId)
    if (wasOnline !== '1') {
      await publishPresence(userId, true)
    }
  },

  /** Explicit offline (clears Redis online key; WS may re-heartbeat later). */
  async setUserOffline(userId: string): Promise<void> {
    await redisClient.del(RedisKeys.userOnlineStatus(userId))
    await publishPresence(userId, false)
  },

  async isUserOnline(userId: string): Promise<boolean> {
    const v = await redisClient.get(RedisKeys.userOnlineStatus(userId))
    return v === '1'
  },

  /**
   * Presence for one or more users as seen by `viewerId`.
   * Respects VIP invisible-online privacy on targets.
   */
  async getPublicPresenceForUsers(
    viewerId: string,
    targetUserIds: string[],
  ): Promise<Map<string, PublicPresenceDto>> {
    const unique = [...new Set(targetUserIds.filter(Boolean))]
    const result = new Map<string, PublicPresenceDto>()
    if (unique.length === 0) return result

    const onlineKeys = unique.map((id) => RedisKeys.userOnlineStatus(id))
    const onlineValues = await redisClient.mget(...onlineKeys)
    const privacyFlags = await privacyService.getEffectiveFlagsBulk(unique)

    const offlineNeedingLastActive: string[] = []
    for (let i = 0; i < unique.length; i++) {
      const userId = unique[i]!
      const hidden = privacyFlags.get(userId)?.invisibleOnline ?? false
      const rawOnline = onlineValues[i] === '1'

      if (hidden && viewerId !== userId) {
        const frozenAt = privacyFlags.get(userId)?.invisibleOnlineLastSeenAt ?? null
        const lastOnline = formatLastOnline(frozenAt)
        result.set(userId, {
          userId,
          isOnline: false,
          lastActiveAt: lastOnline.lastActiveAt,
          lastOnlineSeconds: lastOnline.lastOnlineSeconds,
          lastOnlineLabel: lastOnline.lastOnlineLabel,
        })
        continue
      }

      if (rawOnline) {
        result.set(userId, {
          userId,
          isOnline: true,
          lastActiveAt: null,
          lastOnlineSeconds: null,
          lastOnlineLabel: null,
        })
      } else {
        offlineNeedingLastActive.push(userId)
      }
    }

    if (offlineNeedingLastActive.length === 0) return result

    const rows = await prismaRead.user.findMany({
      where: { id: { in: offlineNeedingLastActive } },
      select: { id: true, lastActiveAt: true },
    })
    const lastActiveMap = new Map(rows.map((r) => [r.id, r.lastActiveAt]))

    for (const userId of offlineNeedingLastActive) {
      const lastActive = lastActiveMap.get(userId) ?? null
      const lastOnline = formatLastOnline(lastActive)
      result.set(userId, {
        userId,
        isOnline: false,
        lastActiveAt: lastOnline.lastActiveAt,
        lastOnlineSeconds: lastOnline.lastOnlineSeconds,
        lastOnlineLabel: lastOnline.lastOnlineLabel,
      })
    }

    return result
  },

  async getPublicPresenceForUser(
    viewerId: string,
    targetUserId: string,
  ): Promise<PublicPresenceDto> {
    const map = await presenceService.getPublicPresenceForUsers(viewerId, [targetUserId])
    return (
      map.get(targetUserId) ?? {
        userId: targetUserId,
        isOnline: false,
        lastActiveAt: null,
        lastOnlineSeconds: null,
        lastOnlineLabel: null,
      }
    )
  },
}
