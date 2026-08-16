import type { Job } from 'bullmq'
import { randomUUID } from 'crypto'
import { prismaRead } from '../config/database'
import { pushNotificationService, type PushRecipient } from '../services/pushNotification.service'
import { auditService } from '../services/audit.service'
import { rootLogger } from '../utils/rootLogger'
import { NOTIFY_BROADCAST_STATE_TTL, RedisKeys, redisClient } from '../config/redis'
import { BROADCAST_BATCH_SIZE, BROADCAST_STALE_MS } from '../queues/platform-message.constants'
import {
  enqueuePushBroadcastBatch,
  pushBroadcastBatchJobId,
  pushNotificationQueue,
} from '../queues/push-notification.queue'

const log = rootLogger.child({ module: 'push-notification-job' })

export type PushBroadcastJobData = {
  adminUserId: string
  title: string
  body: string
  data?: Record<string, string>
  userIds?: string[]
  country?: string
  campaignId?: string
}

export type PushBroadcastBatchJobData = {
  campaignId: string
  batchIndex: number
  title: string
  body: string
  data?: Record<string, string>
  adminUserId?: string
  /** Preferred: userId+token pairs for per-user delivery logs. */
  recipients?: PushRecipient[]
  /** Legacy in-flight jobs may still carry tokens only. */
  tokens?: string[]
}

function parsePendingBatch(raw: string): PushRecipient[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || parsed.length === 0) return []
  if (typeof parsed[0] === 'string') {
    // Legacy token-only batches — resolve userIds by token before send/log.
    return (parsed as string[]).map((token) => ({ userId: '', token }))
  }
  return parsed as PushRecipient[]
}

/**
 * Fan-out planner: resolves the recipient token set (explicit userIds, a country
 * segment, or all active non-support users — always filtered to a non-null fcmToken),
 * persists per-batch recipient lists in Redis, and enqueues one short batch job per
 * BROADCAST_BATCH_SIZE recipients. Mirrors `processPlatformNotificationBroadcastJob`.
 */
export async function processPushBroadcastJob(job: Job<PushBroadcastJobData>): Promise<void> {
  const campaignId = job.data.campaignId ?? `push-broadcast-${randomUUID()}`
  const stateKey = RedisKeys.pushBroadcastState(campaignId)
  const pendingKey = RedisKeys.pushBroadcastPending(campaignId)

  if ((await redisClient.exists(stateKey)) === 1) {
    const pending = await redisClient.hgetall(pendingKey)
    for (const [batchIndex, raw] of Object.entries(pending)) {
      await enqueuePushBroadcastBatch({
        campaignId,
        batchIndex: Number(batchIndex),
        title: job.data.title,
        body: job.data.body,
        data: job.data.data,
        adminUserId: job.data.adminUserId,
        recipients: parsePendingBatch(raw),
      })
    }
    log.info({ campaignId, reEnqueued: Object.keys(pending).length }, 'push broadcast plan replayed')
    return
  }

  let recipients: PushRecipient[]
  if (job.data.userIds) {
    const rows = await prismaRead.user.findMany({
      where: { id: { in: job.data.userIds }, fcmToken: { not: null } },
      select: { id: true, fcmToken: true },
    })
    recipients = rows.map((r) => ({ userId: r.id, token: r.fcmToken! }))
  } else {
    const rows = await prismaRead.user.findMany({
      where: {
        status: 'active',
        isSupport: false,
        fcmToken: { not: null },
        ...(job.data.country ? { country: { equals: job.data.country, mode: 'insensitive' } } : {}),
      },
      select: { id: true, fcmToken: true },
      take: 50_000,
    })
    recipients = rows.map((r) => ({ userId: r.id, token: r.fcmToken! }))
  }

  const batches: PushRecipient[][] = []
  for (let i = 0; i < recipients.length; i += BROADCAST_BATCH_SIZE) {
    batches.push(recipients.slice(i, i + BROADCAST_BATCH_SIZE))
  }

  if (batches.length === 0) {
    auditService.logAdmin({
      adminUserId: job.data.adminUserId,
      actionType: 'ADMIN_PUSH_BROADCAST',
      actionStatus: 'success',
      actionDetails: { campaignId, recipientCount: 0, sent: 0 },
    })
    log.info({ campaignId, sent: 0, total: 0 }, 'push broadcast complete')
    return
  }

  const multi = redisClient.multi()
  multi.hset(stateKey, {
    adminUserId: job.data.adminUserId,
    title: job.data.title,
    body: job.data.body,
    // Persist data so sweep re-enqueues keep FCM data payload.
    ...(job.data.data ? { data: JSON.stringify(job.data.data) } : {}),
    total: recipients.length,
    remaining: batches.length,
    sent: 0,
    createdAt: Date.now(),
  })
  multi.expire(stateKey, NOTIFY_BROADCAST_STATE_TTL)
  multi.hset(pendingKey, Object.fromEntries(batches.map((b, i) => [String(i), JSON.stringify(b)])))
  multi.expire(pendingKey, NOTIFY_BROADCAST_STATE_TTL)
  multi.sadd(RedisKeys.pushBroadcastActive(), campaignId)
  await multi.exec()

  for (let i = 0; i < batches.length; i++) {
    await enqueuePushBroadcastBatch({
      campaignId,
      batchIndex: i,
      title: job.data.title,
      body: job.data.body,
      data: job.data.data,
      adminUserId: job.data.adminUserId,
      recipients: batches[i]!,
    })
  }

  log.info(
    { campaignId, total: recipients.length, batches: batches.length },
    'push broadcast batched',
  )
}

const CLAIM_BATCH_LUA = `
if redis.call('HDEL', KEYS[1], ARGV[1]) == 1 then
  redis.call('HINCRBY', KEYS[2], 'sent', ARGV[2])
  return redis.call('HINCRBY', KEYS[2], 'remaining', -1)
end
return -1`

export async function processPushBroadcastBatchJob(
  job: Job<PushBroadcastBatchJobData>,
): Promise<void> {
  const { campaignId, batchIndex, title, body, data, adminUserId } = job.data
  let recipients = job.data.recipients ?? []
  if (recipients.length === 0 && job.data.tokens?.length) {
    recipients = job.data.tokens.map((token) => ({ userId: '', token }))
  }

  // Resolve userIds for legacy token-only batches so delivery logs can attach user detail.
  if (recipients.some((r) => !r.userId)) {
    const tokens = recipients.map((r) => r.token)
    const rows = await prismaRead.user.findMany({
      where: { fcmToken: { in: tokens } },
      select: { id: true, fcmToken: true },
    })
    const byToken = new Map(rows.map((r) => [r.fcmToken!, r.id]))
    recipients = recipients.map((r) => ({
      userId: r.userId || byToken.get(r.token) || '',
      token: r.token,
    }))
  }

  const stateKey = RedisKeys.pushBroadcastState(campaignId)
  const resolvedAdminId =
    adminUserId ?? (await redisClient.hget(stateKey, 'adminUserId')) ?? undefined

  const result = await pushNotificationService.sendMulticastToRecipients(
    recipients,
    { title, body, data },
    {
      source: 'ADMIN_BROADCAST',
      adminUserId: resolvedAdminId,
      campaignId,
    },
  )

  const pendingKey = RedisKeys.pushBroadcastPending(campaignId)
  const remaining = (await redisClient.eval(
    CLAIM_BATCH_LUA,
    2,
    pendingKey,
    stateKey,
    String(batchIndex),
    String(result.successCount),
  )) as number

  if (remaining === 0) {
    const [totalStr, sentStr] = await redisClient.hmget(stateKey, 'total', 'sent')
    const total = Number(totalStr ?? 0)
    const totalSent = Number(sentStr ?? 0)
    const auditAdminId = resolvedAdminId ?? ''
    if (auditAdminId) {
      auditService.logAdmin({
        adminUserId: auditAdminId,
        actionType: 'ADMIN_PUSH_BROADCAST',
        actionStatus: 'success',
        actionDetails: { campaignId, recipientCount: total, sent: totalSent },
      })
    }
    await redisClient
      .multi()
      .del(stateKey)
      .del(pendingKey)
      .srem(RedisKeys.pushBroadcastActive(), campaignId)
      .exec()
    log.info({ campaignId, sent: totalSent, total }, 'push broadcast complete')
  }
}

/** Safety net (mirrors `sweepStalePlatformBroadcasts`): re-enqueues batches whose job vanished or exhausted retries. */
export async function sweepStalePushBroadcasts(): Promise<void> {
  const campaigns = await redisClient.smembers(RedisKeys.pushBroadcastActive())
  for (const campaignId of campaigns) {
    const stateKey = RedisKeys.pushBroadcastState(campaignId)
    const pendingKey = RedisKeys.pushBroadcastPending(campaignId)
    const state = await redisClient.hgetall(stateKey)
    if (!state.createdAt) {
      await redisClient.multi().del(pendingKey).srem(RedisKeys.pushBroadcastActive(), campaignId).exec()
      continue
    }
    if (Date.now() - Number(state.createdAt) < BROADCAST_STALE_MS) continue

    const pending = await redisClient.hgetall(pendingKey)
    for (const [batchIndex, raw] of Object.entries(pending)) {
      const existing = await pushNotificationQueue.getJob(
        pushBroadcastBatchJobId(campaignId, Number(batchIndex)),
      )
      if (existing) {
        if ((await existing.getState()) === 'failed') {
          await existing.retry()
          log.warn({ campaignId, batchIndex }, 'push broadcast batch retried by sweep')
        }
        continue
      }
      let data: Record<string, string> | undefined
      if (state.data) {
        try {
          data = JSON.parse(state.data) as Record<string, string>
        } catch {
          data = undefined
        }
      }
      await enqueuePushBroadcastBatch({
        campaignId,
        batchIndex: Number(batchIndex),
        title: state.title ?? '',
        body: state.body ?? '',
        data,
        adminUserId: state.adminUserId,
        recipients: parsePendingBatch(raw),
      })
      log.warn({ campaignId, batchIndex }, 'push broadcast batch re-enqueued by sweep')
    }
  }
}
