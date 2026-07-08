import type { Job } from 'bullmq'
import { prismaRead } from '../config/database'
import { transactionalMessagingService } from '../services/transactionalMessaging.service'
import { platformMessagingService } from '../services/platformMessaging.service'
import { auditService } from '../services/audit.service'
import { randomUUID } from 'crypto'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'
import { rootLogger } from '../utils/rootLogger'
import { NOTIFY_BROADCAST_STATE_TTL, RedisKeys, redisClient } from '../config/redis'
import { BROADCAST_BATCH_SIZE, BROADCAST_STALE_MS } from '../queues/platform-message.constants'
import {
  broadcastBatchJobId,
  enqueuePlatformNotificationBroadcastBatch,
  platformMessageQueue,
} from '../queues/platform-message.queue'

const log = rootLogger.child({ module: 'platform-message-job' })

export type PlatformLedgerMessageJobData = {
  kind: 'coin' | 'point'
  entryId: string
}

export type PlatformWithdrawalMessageJobData = {
  withdrawalId: string
  event: string
  hostUserId: string
  agentUserId?: string
  reason?: string
}

export type PlatformNotificationBroadcastJobData = {
  adminUserId: string
  message: string
  userIds?: string[]
  campaignId?: string
}

export async function processPlatformLedgerMessageJob(
  job: Job<PlatformLedgerMessageJobData>,
): Promise<void> {
  const { kind, entryId } = job.data
  if (kind === 'coin') {
    await transactionalMessagingService.sendFromCoinLedgerEntry(entryId)
  } else {
    await transactionalMessagingService.sendFromPointLedgerEntry(entryId)
  }
}

export async function processPlatformWithdrawalMessageJob(
  job: Job<PlatformWithdrawalMessageJobData>,
): Promise<void> {
  await transactionalMessagingService.sendWithdrawalEvent(job.data)
}

export type PlatformNotificationBroadcastBatchJobData = {
  campaignId: string
  batchIndex: number
  adminUserId: string
  message: string
  userIds: string[]
}

/**
 * Fan-out planner: resolves the recipient set, persists per-batch payloads in Redis
 * (`notify:broadcast:pending:{campaignId}` — the durable "outbox" the sweep recovers
 * from), and enqueues one short batch job per BROADCAST_BATCH_SIZE recipients instead
 * of sending 50k messages serially in this job.
 */
export async function processPlatformNotificationBroadcastJob(
  job: Job<PlatformNotificationBroadcastJobData>,
): Promise<void> {
  // New enqueues always carry campaignId; the fallback only covers jobs enqueued
  // before batching shipped (their retries pre-dated stable campaignIds anyway).
  const campaignId = job.data.campaignId ?? `broadcast:${randomUUID()}`
  const stateKey = RedisKeys.notifyBroadcastState(campaignId)
  const pendingKey = RedisKeys.notifyBroadcastPending(campaignId)

  if ((await redisClient.exists(stateKey)) === 1) {
    // Retry after a crash mid-enqueue: batches are already planned — (re-)enqueue
    // whatever is still pending; deterministic jobIds dedupe against live jobs.
    const pending = await redisClient.hgetall(pendingKey)
    for (const [batchIndex, ids] of Object.entries(pending)) {
      await enqueuePlatformNotificationBroadcastBatch({
        campaignId,
        batchIndex: Number(batchIndex),
        adminUserId: job.data.adminUserId,
        message: job.data.message,
        userIds: JSON.parse(ids) as string[],
      })
    }
    log.info({ campaignId, reEnqueued: Object.keys(pending).length }, 'broadcast plan replayed')
    return
  }

  const userIds =
    job.data.userIds ??
    (
      await prismaRead.user.findMany({
        where: { status: 'active', isSupport: false },
        select: { id: true },
        take: 50_000,
      })
    ).map((u) => u.id)

  const batches: string[][] = []
  for (let i = 0; i < userIds.length; i += BROADCAST_BATCH_SIZE) {
    batches.push(userIds.slice(i, i + BROADCAST_BATCH_SIZE))
  }

  if (batches.length === 0) {
    auditService.log({
      userId: job.data.adminUserId,
      actionType: 'ADMIN_NOTIFICATION_BROADCAST',
      actionStatus: 'success',
      actionDetails: { campaignId, recipientCount: 0, sent: 0 },
    })
    log.info({ campaignId, sent: 0, total: 0 }, 'notification broadcast complete')
    return
  }

  const multi = redisClient.multi()
  multi.hset(stateKey, {
    adminUserId: job.data.adminUserId,
    message: job.data.message,
    total: userIds.length,
    remaining: batches.length,
    sent: 0,
    createdAt: Date.now(),
  })
  multi.expire(stateKey, NOTIFY_BROADCAST_STATE_TTL)
  multi.hset(pendingKey, Object.fromEntries(batches.map((b, i) => [String(i), JSON.stringify(b)])))
  multi.expire(pendingKey, NOTIFY_BROADCAST_STATE_TTL)
  multi.sadd(RedisKeys.notifyBroadcastActive(), campaignId)
  await multi.exec()

  for (let i = 0; i < batches.length; i++) {
    await enqueuePlatformNotificationBroadcastBatch({
      campaignId,
      batchIndex: i,
      adminUserId: job.data.adminUserId,
      message: job.data.message,
      userIds: batches[i]!,
    })
  }

  log.info(
    { campaignId, total: userIds.length, batches: batches.length },
    'notification broadcast batched',
  )
}

/**
 * Atomic batch completion: claims the pending field (HDEL) so a stalled-job re-run
 * or sweep re-enqueue can never double-count, then folds this batch into the
 * campaign counters. Returns remaining batch count, or -1 when already claimed.
 */
const CLAIM_BATCH_LUA = `
if redis.call('HDEL', KEYS[1], ARGV[1]) == 1 then
  redis.call('HINCRBY', KEYS[2], 'sent', ARGV[2])
  return redis.call('HINCRBY', KEYS[2], 'remaining', -1)
end
return -1`

export async function processPlatformNotificationBroadcastBatchJob(
  job: Job<PlatformNotificationBroadcastBatchJobData>,
): Promise<void> {
  const { campaignId, batchIndex, adminUserId, message, userIds } = job.data

  let sent = 0
  for (const userId of userIds) {
    const metadata: PlatformMessageMetadata = {
      category: 'notification',
      campaignId,
      adminUserId,
    }
    const result = await platformMessagingService.sendPlatformMessage({
      targetUserId: userId,
      type: 'NOTIFICATION',
      content: message,
      metadata,
      clientMessageId: `notify:${campaignId}:${userId}`,
    })
    if (result.created) sent += 1
  }

  const stateKey = RedisKeys.notifyBroadcastState(campaignId)
  const pendingKey = RedisKeys.notifyBroadcastPending(campaignId)
  const remaining = (await redisClient.eval(
    CLAIM_BATCH_LUA,
    2,
    pendingKey,
    stateKey,
    String(batchIndex),
    String(sent),
  )) as number

  if (remaining === 0) {
    const [totalStr, sentStr] = await redisClient.hmget(stateKey, 'total', 'sent')
    const total = Number(totalStr ?? 0)
    const totalSent = Number(sentStr ?? 0)
    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_NOTIFICATION_BROADCAST',
      actionStatus: 'success',
      actionDetails: { campaignId, recipientCount: total, sent: totalSent },
    })
    await redisClient
      .multi()
      .del(stateKey)
      .del(pendingKey)
      .srem(RedisKeys.notifyBroadcastActive(), campaignId)
      .exec()
    log.info({ campaignId, sent: totalSent, total }, 'notification broadcast complete')
  }
}

/**
 * Safety net (mirrors the message-outbox stale-row sweep): a batch whose BullMQ job
 * vanished or exhausted retries still has its payload in the pending hash — re-enqueue
 * it so a broadcast can't silently drop a batch. Per-recipient clientMessageId dedupe
 * makes re-runs deliver exactly once.
 */
export async function sweepStalePlatformBroadcasts(): Promise<void> {
  const campaigns = await redisClient.smembers(RedisKeys.notifyBroadcastActive())
  for (const campaignId of campaigns) {
    const stateKey = RedisKeys.notifyBroadcastState(campaignId)
    const pendingKey = RedisKeys.notifyBroadcastPending(campaignId)
    const state = await redisClient.hgetall(stateKey)
    if (!state.createdAt) {
      // State expired (24h TTL) or completion cleanup lost the SREM — drop membership.
      await redisClient
        .multi()
        .del(pendingKey)
        .srem(RedisKeys.notifyBroadcastActive(), campaignId)
        .exec()
      continue
    }
    if (Date.now() - Number(state.createdAt) < BROADCAST_STALE_MS) continue

    const pending = await redisClient.hgetall(pendingKey)
    for (const [batchIndex, ids] of Object.entries(pending)) {
      const existing = await platformMessageQueue.getJob(
        broadcastBatchJobId(campaignId, Number(batchIndex)),
      )
      if (existing) {
        if ((await existing.getState()) === 'failed') {
          await existing.retry()
          log.warn({ campaignId, batchIndex }, 'broadcast batch retried by sweep')
        }
        continue
      }
      await enqueuePlatformNotificationBroadcastBatch({
        campaignId,
        batchIndex: Number(batchIndex),
        adminUserId: state.adminUserId ?? '',
        message: state.message ?? '',
        userIds: JSON.parse(ids) as string[],
      })
      log.warn({ campaignId, batchIndex }, 'broadcast batch re-enqueued by sweep')
    }
  }
}
