import { PRESENCE_HEARTBEAT_TTL_SEC, redisClient, RedisKeys } from '../config/redis'
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

  /** PING: refresh `online:{userId}` so DM / presence stay warm. */
  async refreshOnlineHeartbeat(userId: string): Promise<void> {
    await redisClient.set(RedisKeys.userOnlineStatus(userId), '1', 'EX', PRESENCE_HEARTBEAT_TTL_SEC)
  },
}
