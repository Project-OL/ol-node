import crypto from 'crypto'
import { redisClient } from '../config/redis'
import { RedisKeys, WS_TICKET_TTL_SEC } from '../config/redis'

export async function mintWsTicket(userId: string): Promise<{
  token: string
  expiresInSec: number
}> {
  const token = crypto.randomBytes(32).toString('hex')
  await redisClient.set(RedisKeys.wsTicket(token), userId, 'EX', WS_TICKET_TTL_SEC)
  return { token, expiresInSec: WS_TICKET_TTL_SEC }
}

/** Single-use ticket consumed at WS upgrade (GETDEL). */
export async function consumeWsTicket(token: string | undefined): Promise<string | null> {
  if (!token || token.length < 16) return null
  const userId = await redisClient.getdel(RedisKeys.wsTicket(token))
  return userId
}
