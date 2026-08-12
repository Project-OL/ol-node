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

/** Mint a short-lived WS ticket for a system admin. The stored value is prefixed `admin:` so the gateway can distinguish admin connections. */
export async function mintAdminWsTicket(adminId: string): Promise<{
  token: string
  expiresInSec: number
}> {
  const token = crypto.randomBytes(32).toString('hex')
  await redisClient.set(RedisKeys.wsTicket(token), `admin:${adminId}`, 'EX', WS_TICKET_TTL_SEC)
  return { token, expiresInSec: WS_TICKET_TTL_SEC }
}

/** Single-use ticket consumed at WS upgrade (GETDEL). */
export async function consumeWsTicket(token: string | undefined): Promise<string | null> {
  if (!token || token.length < 16) return null
  const principal = await redisClient.getdel(RedisKeys.wsTicket(token))
  return principal
}

/** Returns true when the principal stored in the WS ticket is an admin (prefixed `admin:`). */
export function isAdminPrincipal(principal: string): boolean {
  return principal.startsWith('admin:')
}

/** Extracts the raw admin ID from an admin principal string. */
export function adminIdFromPrincipal(principal: string): string {
  return principal.slice('admin:'.length)
}
