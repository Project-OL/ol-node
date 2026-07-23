import type { Job } from 'bullmq'
import { randomUUID } from 'crypto'
import { prismaRead } from '../config/database'
import { pushNotificationService } from '../services/pushNotification.service'
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
  tokens: string[]
}

/**
 * Fan-out planner: resolves the recipient token set (explicit userIds, a country
 * segment, or all active non-support users — always filtered to a non-null fcmToken),
 * persists per-batch token lists in Redis, and enqueues one short batch job per
 * BROADCAST_BATCH_SIZE recipients. Mirrors `processPlatformNotificationBroadcastJob`.
 */
export async function processPushBroadcastJob(job: Job<PushBroadcastJobData>): Promise<void> {
  const campaignId = job.data.campaignId ?? `push-broadcast:${randomUUID()}`
  const stateKey = RedisKeys.pushBroadcastState(campaignId)
  const pendingKey = RedisKeys.pushBroadcastPending(campaignId)

  if ((await redisClient.exists(stateKey)) === 1) {
    const pending = await redisClient.hgetall(pendingKey)
    for (const [batchIndex, tokens] of Object.entries(pending)) {
      await enqueuePushBroadcastBatch({
        campaignId,
        batchIndex: Number(batchIndex),
        title: job.data.title,
        body: job.data.body,
        data: job.data.data,
        tokens: JSON.parse(tokens) as string[],
      })
    }
    log.info({ campaignId, reEnqueued: Object.keys(pending).length }, 'push broadcast plan replayed')
    return
  }

  let tokens: string[]
  if (job.data.userIds) {
    const rows = await prismaRead.user.findMany({
      where: { id: { in: job.data.userIds }, fcmToken: { not: null } },
      select: { fcmToken: true },
    })
    tokens = rows.map((r) => r.fcmToken!)
  } else {
    const rows = await prismaRead.user.findMany({
      where: {
        status: 'active',
        isSupport: false,
        fcmToken: { not: null },
        ...(job.data.country ? { country: { equals: job.data.country, mode: 'insensitive' } } : {}),
      },
      select: { fcmToken: true },
      take: 50_000,
    })
    tokens = rows.map((r) => r.fcmToken!)
  }

  const batches: string[][] = []
  for (let i = 0; i < tokens.length; i += BROADCAST_BATCH_SIZE) {
    batches.push(tokens.slice(i, i + BROADCAST_BATCH_SIZE))
  }

  if (batches.length === 0) {
    auditService.log({
      userId: job.data.adminUserId,
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
    total: tokens.length,
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
      tokens: batches[i]!,
    })
  }

  log.info({ campaignId, total: tokens.length, batches: batches.length }, 'push broadcast batched')
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
  const { campaignId, batchIndex, title, body, data, tokens } = job.data

  const result = await pushNotificationService.sendMulticast(tokens, { title, body, data })

  const stateKey = RedisKeys.pushBroadcastState(campaignId)
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
    const adminUserId = (await redisClient.hget(stateKey, 'adminUserId')) ?? ''
    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_PUSH_BROADCAST',
      actionStatus: 'success',
      actionDetails: { campaignId, recipientCount: total, sent: totalSent },
    })
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
    for (const [batchIndex, tokens] of Object.entries(pending)) {
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
      await enqueuePushBroadcastBatch({
        campaignId,
        batchIndex: Number(batchIndex),
        title: state.title ?? '',
        body: state.body ?? '',
        tokens: JSON.parse(tokens) as string[],
      })
      log.warn({ campaignId, batchIndex }, 'push broadcast batch re-enqueued by sweep')
    }
  }
}
