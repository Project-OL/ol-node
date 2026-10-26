import type { FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { rootLogger } from '../utils/rootLogger'

/**
 * Traffic patterns (TRF-01 / TRF-03): cheap counters on the hot path, history written by jobs.
 *
 * - Presence: `presence:lastping` ZSET (userId -> last connect/PING ms), sampled every minute
 *   into `traffic_minute` by {@link sampleTrafficMinute}.
 * - Requests: per IST hour, a HyperLogLog of users (all + per section) and request / 5xx counts
 *   per section. Keys expire after 3 days; the hourly rollup (TRF-04) copies them to Postgres.
 *
 * Only counts and HyperLogLogs are stored: no IPs, no per-user lists.
 */
const log = rootLogger.child({ module: 'traffic' })

const IST_OFFSET_MS = 5.5 * 3600 * 1000
export const TRAFFIC_KEY_TTL_SEC = 3 * 86_400
/** A user counts as online when their last connect/PING is newer than this. */
export const ONLINE_WINDOW_MS = 60_000
/** Live-server's `traffic:live:now` is used only while fresher than this. */
const LIVE_NOW_MAX_AGE_MS = 3 * 60_000

/** First path segment after `/api/<version>/` -> section name shown on the Traffic page. */
const SECTION_BY_SEGMENT: Record<string, string> = {
  auth: 'Sign-in',
  security: 'Sign-in',
  devices: 'Sign-in',
  account: 'Account',
  users: 'Profile',
  privacy: 'Settings',
  settings: 'Settings',
  social: 'Social',
  posts: 'Social',
  conversations: 'Chat',
  messages: 'Chat',
  blocks: 'Chat',
  reminders: 'Chat',
  upload: 'Uploads',
  reports: 'Support',
  support: 'Support',
  questionnaires: 'Support',
  wallet: 'Wallet',
  'coin-trading': 'Wallet',
  'payment-methods': 'Wallet',
  withdrawal: 'Wallet',
  store: 'Store',
  'vip-membership': 'Store',
  subscriptions: 'Subscriptions',
  games: 'Games',
  call: 'Video call',
  gifts: 'Gifts',
  'gift-gallery': 'Gifts',
  'custom-gifts': 'Gifts',
  'fan-ranking': 'Rankings',
  rankings: 'Rankings',
  'rich-tier': 'Rewards',
  rewards: 'Rewards',
  guardian: 'Guardian',
  agency: 'Agency',
  'face-verification': 'Face check',
  'face-registration': 'Face check',
  'live-photo': 'Live photo',
  banners: 'Home',
  'app-links': 'Home',
}

/** Server-to-server, admin portal and health traffic: never counted as app usage. */
const MACHINE_SEGMENTS = new Set(['admin', 'game-webhooks', 'webhooks', 'internal', 'health'])

/** IST hour bucket `YYYYMMDDHH` for an instant. */
export function istHourKey(at: Date | number): string {
  const ms = typeof at === 'number' ? at : at.getTime()
  const iso = new Date(ms + IST_OFFSET_MS).toISOString()
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13)
}

/**
 * Section for a request path, or null when it is not app traffic (machine, admin, unknown root).
 * `/api/v1/wallet/coins/balance` -> `Wallet`; unknown app segments -> `Other`.
 */
export function sectionForPath(url: string): string | null {
  const path = url.split('?')[0] ?? ''
  const parts = path.split('/').filter(Boolean)
  // `/api/v1/<segment>/...`, or the few unversioned mounts (`/agency`, `/support`, ...).
  const segment = parts[0] === 'api' ? parts[2] : parts[0]
  if (!segment || MACHINE_SEGMENTS.has(segment)) return null
  return SECTION_BY_SEGMENT[segment] ?? 'Other'
}

export const trafficService = {
  /** TRF-01: remember the user's last connect/PING. Best-effort, never throws. */
  async markPresence(userId: string, at = Date.now()): Promise<void> {
    try {
      await redisClient.zadd(RedisKeys.presenceLastPing(), at, userId)
    } catch {
      /* ignore: traffic counters must never affect the request */
    }
  },

  /** TRF-01: the user's last socket closed, so they stop counting as online at once. */
  async clearPresence(userId: string): Promise<void> {
    try {
      await redisClient.zrem(RedisKeys.presenceLastPing(), userId)
    } catch {
      /* ignore: see markPresence */
    }
  },

  /** TRF-03: count one finished app request for its IST hour and section. */
  async recordRequest(
    section: string,
    userId: string | undefined,
    statusCode: number,
    at = Date.now(),
  ) {
    const hour = istHourKey(at)
    const req = RedisKeys.trafficHourRequests(hour)
    const p = redisClient.pipeline().hincrby(req, section, 1).expire(req, TRAFFIC_KEY_TTL_SEC)
    if (statusCode >= 500) {
      const err = RedisKeys.trafficHourErrors(hour)
      p.hincrby(err, section, 1).expire(err, TRAFFIC_KEY_TTL_SEC)
    }
    if (userId) {
      const all = RedisKeys.trafficHourUsers(hour)
      const sec = RedisKeys.trafficHourSectionUsers(hour, section)
      p.pfadd(all, userId).expire(all, TRAFFIC_KEY_TTL_SEC)
      p.pfadd(sec, userId).expire(sec, TRAFFIC_KEY_TTL_SEC)
    }
    await p.exec()
  },

  /**
   * TRF-01: one row per minute in `traffic_minute`. Online users come from the presence ZSET;
   * live and call counts from Live-server's `traffic:live:now` hash (null when stale or missing).
   * Re-running the same minute overwrites it, so a retried job is harmless.
   */
  async sampleMinute(now = Date.now()): Promise<{ minute: Date; online: number }> {
    const key = RedisKeys.presenceLastPing()
    const [online, live] = await Promise.all([
      redisClient.zcount(key, now - ONLINE_WINDOW_MS, '+inf'),
      redisClient.hgetall(RedisKeys.trafficLiveNow()),
    ])
    // Keep the set to the last hour; older scores can never count as online again.
    await redisClient.zremrangebyscore(key, '-inf', now - 3_600_000)

    const fresh = live && Number(live.at) > 0 && now - Number(live.at) <= LIVE_NOW_MAX_AGE_MS
    const num = (v: string | undefined) => (fresh && v != null && v !== '' ? Number(v) : null)
    const minute = new Date(Math.floor(now / 60_000) * 60_000)
    const data = {
      onlineUsers: online,
      hostsLive: num(live?.hostsLive),
      liveViewers: num(live?.viewers),
      callsActive: num(live?.callsActive),
      usersInCalls: num(live?.usersInCalls),
      liveSocketUsers: num(live?.socketUsers),
    }
    await prisma.trafficMinute.upsert({
      where: { minute },
      create: { minute, ...data },
      update: data,
    })
    return { minute, online }
  },
}

/** Fastify onResponse hook (TRF-03). Skips machine, admin, health and unmatched (404) routes. */
export async function trafficOnResponse(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const routeUrl = (request.routeOptions as { url?: string } | undefined)?.url
  if (!routeUrl) return
  const section = sectionForPath(request.url)
  if (!section) return
  try {
    await trafficService.recordRequest(section, request.userId, reply.statusCode)
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'traffic counter write failed')
  }
}
