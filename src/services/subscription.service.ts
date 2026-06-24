import crypto from 'crypto'
import { CreatorSubscriptionStatus, LevelType, PointTxType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import {
  redisClient,
  RedisKeys,
  SUBSCRIPTION_COUNT_CACHE_TTL,
  SUB_TOP_CREATORS_TTL,
} from '../config/redis'
import { cacheRedisService } from './cacheRedis.service'
import { decodeCursor, encodeCursor } from '../utils/cursor'
import { postRepository } from '../repositories/post.repository'
import { assembleUnlockedPostResponse } from './post-response.builder'
import type { PostResponse } from '../types/post.types'
import { AppError } from '../middlewares/errorHandler'
import {
  SUBSCRIPTION_COIN_COST,
  SUBSCRIPTION_GRACE_MS,
  SUBSCRIPTION_PERIOD_MS,
} from '../queues/subscription.constants'
import {
  cancelSubscriptionGraceJob,
  cancelSubscriptionRenewalJob,
  enqueueSubscriptionGrace,
  enqueueSubscriptionRenewal,
} from '../queues/subscription.queue'
import {
  subscriptionRepository,
  type TopCreatorQueryRow,
} from '../repositories/subscription.repository'
import { userRepository } from '../repositories/user.repository'
import { userSubscriberRepository } from '../repositories/userSubscriber.repository'
import { HOST_REVENUE_SHARES, hostPointsFromSubscription } from '../config/host-revenue-shares'
import { ledgerHostPointsKey } from '../utils/ledger-idempotency'
import { coinWalletService } from './coin-wallet.service'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { syncLevelCacheFromApplyResult, type LevelApplyResult } from './user-level.service'
import { assertNotBlockedEitherWay, isBlockedEitherWay } from '../utils/block-relationship'

async function bustAgentCommissionIfNeeded(agentUserId: string | null): Promise<void> {
  if (!agentUserId) return
  const { agencyCommissionService } = await import('./agencyCommission.service')
  await agencyCommissionService.bustAgentCommissionCaches(agentUserId)
}

async function creditCreatorSubscriptionPoints(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  params: {
    creatorId: string
    subscriberId: string
    subscriptionId: string
    coinsPaid: bigint
    idempotencyKey: string
    description: string
  },
): Promise<{
  hostPoints: bigint
  bustAgentUserId: string | null
  livestreamLevelResult: LevelApplyResult | null
}> {
  const hostPoints = hostPointsFromSubscription(params.coinsPaid)
  if (hostPoints <= 0n) {
    return { hostPoints: 0n, bustAgentUserId: null, livestreamLevelResult: null }
  }

  const { bustAgentUserId, livestreamLevelResult } = await pointWalletService.creditInTransaction(
    params.creatorId,
    hostPoints,
    PointTxType.SUBSCRIPTION,
    tx,
    {
      idempotencyKey: params.idempotencyKey,
      refId: params.subscriptionId,
      counterpartyId: params.subscriberId,
      description: params.description,
      metadata: {
        coinsPaid: params.coinsPaid.toString(),
        hostShareBp: HOST_REVENUE_SHARES.SUBSCRIPTION_BP,
      },
      applyLivestreamLevel: true,
    },
  )
  return { hostPoints, bustAgentUserId, livestreamLevelResult }
}

function accessTtlSeconds(nextRenewalAt: Date): number {
  return Math.max(1, Math.floor((nextRenewalAt.getTime() - Date.now()) / 1000))
}

async function setSubscriptionAccess(
  subscriberId: string,
  creatorId: string,
  nextRenewalAt: Date,
): Promise<void> {
  const ttl = accessTtlSeconds(nextRenewalAt)
  await redisClient.set(RedisKeys.subscriptionAccess(subscriberId, creatorId), '1', 'EX', ttl)
}

/**
 * Stop future renewals when users block each other. Paid access remains until `nextRenewalAt`.
 */
async function stopRenewalDueToBlockKeepingAccess(
  subscriberId: string,
  creatorId: string,
): Promise<void> {
  const sub = await subscriptionRepository.findByPair(subscriberId, creatorId)
  if (!sub) return
  if (
    sub.status !== CreatorSubscriptionStatus.ACTIVE &&
    sub.status !== CreatorSubscriptionStatus.GRACE
  ) {
    return
  }

  await subscriptionRepository.updateById(sub.id, {
    status: CreatorSubscriptionStatus.CANCELLED,
    graceUntil: null,
  })
  await cancelSubscriptionRenewalJob(sub.id)
  await cancelSubscriptionGraceJob(sub.id)

  if (sub.nextRenewalAt.getTime() > Date.now()) {
    await setSubscriptionAccess(subscriberId, creatorId, sub.nextRenewalAt)
  } else {
    await redisClient.del(RedisKeys.subscriptionAccess(subscriberId, creatorId))
  }

  await userSubscriberRepository.deletePair(subscriberId, creatorId)
  await invalidateSubscriberCountCache(creatorId)
  await invalidateTopCreatorsCachesForCreator(creatorId)

  console.info('[Subscription] renewal stopped due to block', {
    subscriptionId: sub.id,
    subscriberId,
    creatorId,
    accessUntil: sub.nextRenewalAt.toISOString(),
  })
}

async function invalidateSubscriberCountCache(creatorId: string): Promise<void> {
  try {
    await redisClient.del(RedisKeys.subscriptionCreatorCount(creatorId))
  } catch {
    // ignore
  }
}

/** Top-creators leaderboard is cached 300s; bust after subscribe/cancel so counts refresh. */
async function invalidateTopCreatorsCachesForCreator(creatorId: string): Promise<void> {
  try {
    const creator = await prismaRead.user.findUnique({
      where: { id: creatorId },
      select: { country: true },
    })
    const tasks = [
      cacheRedisService.del(RedisKeys.subscriptionTopCreatorsGlobal()),
      cacheRedisService.del(RedisKeys.subscriptionTopCreatorsByPosts()),
    ]
    if (creator?.country) {
      tasks.push(cacheRedisService.del(RedisKeys.subscriptionTopCreators(creator.country)))
    }
    await Promise.all(tasks)
  } catch {
    // ignore
  }
}

async function readThroughActiveSubscriberCount(creatorId: string): Promise<number> {
  const cacheKey = RedisKeys.subscriptionCreatorCount(creatorId)
  const cached = await redisClient.get(cacheKey)
  if (cached !== null && cached !== '') {
    const n = Number.parseInt(cached, 10)
    if (!Number.isNaN(n)) {
      return n
    }
  }
  const count = await subscriptionRepository.countActiveByCreatorId(creatorId)
  await redisClient.set(cacheKey, String(count), 'EX', SUBSCRIPTION_COUNT_CACHE_TTL)
  return count
}

import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'

export type TopCreatorCard = {
  userId: string
  publicId: string
  displayPublicId: string
  name: string
  displayName: string
  avatarUrl: string | null
  subscriberCount: number
}

function mapTopCreatorRow(row: TopCreatorQueryRow): TopCreatorCard {
  const displayName = buildUserDisplayName(row)
  return {
    userId: row.id,
    publicId: row.publicId.toString(),
    displayPublicId: resolveDisplayPublicId(row),
    name: displayName,
    displayName,
    avatarUrl: row.avatarUrl,
    subscriberCount: row._count.creatorSubsAsHost,
  }
}

function excludeCallerTake3(cards: TopCreatorCard[], userId: string): TopCreatorCard[] {
  return cards.filter((c) => c.userId !== userId).slice(0, 3)
}

async function loadTopCreators(
  cacheKey: string,
  loader: () => Promise<TopCreatorQueryRow[]>,
): Promise<TopCreatorCard[]> {
  const cached = await redisClient.get(cacheKey)
  if (cached) {
    return JSON.parse(cached) as TopCreatorCard[]
  }
  const cards = (await loader()).map(mapTopCreatorRow)
  if (cards.length > 0) {
    await redisClient.set(cacheKey, JSON.stringify(cards), 'EX', SUB_TOP_CREATORS_TTL)
  }
  return cards
}

export const subscriptionService = {
  async getSubscriptionStatus(
    userId: string,
  ): Promise<{ hasActiveSubscriptions: boolean; activeCount: number }> {
    const count = await prismaRead.creatorSubscription.count({
      where: { subscriberId: userId, status: CreatorSubscriptionStatus.ACTIVE },
    })
    return { hasActiveSubscriptions: count > 0, activeCount: count }
  },

  async getTopCreatorsByCountry(
    userId: string,
  ): Promise<{ creators: TopCreatorCard[]; country: string | null }> {
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { country: true },
    })
    const country = user?.country ?? null

    if (country) {
      const countryPool = await loadTopCreators(RedisKeys.subscriptionTopCreators(country), () =>
        subscriptionRepository.queryTopCreatorsByCountry(country, 4),
      )
      const countryCreators = excludeCallerTake3(countryPool, userId)
      if (countryCreators.length > 0) {
        return { creators: countryCreators, country }
      }
    }

    const globalPool = await loadTopCreators(RedisKeys.subscriptionTopCreatorsGlobal(), () =>
      subscriptionRepository.queryTopCreatorsGlobal(4),
    )
    let creators = excludeCallerTake3(globalPool, userId)
    if (creators.length > 0) {
      return { creators, country }
    }

    const postsPool = await loadTopCreators(RedisKeys.subscriptionTopCreatorsByPosts(), () =>
      subscriptionRepository.queryTopCreatorsByPostCount(4),
    )
    creators = excludeCallerTake3(postsPool, userId)
    return { creators, country }
  },

  async getSubscriptionFeed(
    userId: string,
    limit: number,
    rawCursor?: string,
  ): Promise<{
    posts: PostResponse[]
    nextCursor: string | null
    hasSubscriptions: boolean
  }> {
    const subs = await subscriptionRepository.getActiveSubscriptions(userId)
    if (subs.length === 0) {
      return { posts: [], nextCursor: null, hasSubscriptions: false }
    }

    const creatorIds = subs.map((s) => s.creatorId)
    const cursor = rawCursor ? decodeCursor(rawCursor) : undefined
    const rows = await postRepository.getSubscriptionFeed(creatorIds, limit, cursor)

    let nextCursor: string | null = null
    let page = rows
    if (rows.length > limit) {
      page = rows.slice(0, limit)
      const last = page[page.length - 1]!
      nextCursor = encodeCursor(last.createdAt, last.id)
    }

    const likedSet = await postRepository.batchExistsLike(
      page.map((p) => p.id),
      userId,
    )
    const posts = page.map((post) => assembleUnlockedPostResponse(post, likedSet.has(post.id)))

    return { posts, nextCursor, hasSubscriptions: true }
  },

  async createSubscription(subscriberId: string, creatorId: string) {
    if (subscriberId === creatorId) {
      throw new AppError(400, 'Cannot subscribe to yourself', 'INVALID_REQUEST')
    }

    await assertNotBlockedEitherWay(subscriberId, creatorId)

    const creator = await userRepository.findById(creatorId)
    if (!creator) {
      throw new AppError(404, 'Creator not found', 'NOT_FOUND')
    }

    const existing = await subscriptionRepository.findByPair(subscriberId, creatorId)
    if (
      existing &&
      (existing.status === CreatorSubscriptionStatus.ACTIVE ||
        existing.status === CreatorSubscriptionStatus.GRACE)
    ) {
      throw new AppError(409, 'Already subscribed to this creator', 'SUBSCRIPTION_DUPLICATE')
    }

    const nextRenewalAt = new Date(Date.now() + SUBSCRIPTION_PERIOD_MS)
    const idempotencyKey = `sub:create:${subscriberId}:${creatorId}:${crypto.randomUUID()}`

    let bustAgentUserId: string | null = null
    let subscriberWealthResult: LevelApplyResult | null = null
    let creatorLivestreamResult: LevelApplyResult | null = null
    const row = await prisma.$transaction(
      async (tx) => {
        subscriberWealthResult = await coinWalletService.debitForCreatorSubscription(
          subscriberId,
          SUBSCRIPTION_COIN_COST,
          {
            creatorId,
            subscriptionId: `pending:${subscriberId}:${creatorId}`,
            idempotencyKey,
            description: 'Creator subscription (initial)',
            applyWealthXp: true,
          },
          tx,
        )

        const created = await subscriptionRepository.upsertActiveInTx(tx, {
          subscriberId,
          creatorId,
          nextRenewalAt,
        })

        await userSubscriberRepository.upsertPairInTx(tx, subscriberId, creatorId)

        const credited = await creditCreatorSubscriptionPoints(tx, {
          creatorId,
          subscriberId,
          subscriptionId: created.id,
          coinsPaid: SUBSCRIPTION_COIN_COST,
          idempotencyKey: ledgerHostPointsKey(idempotencyKey),
          description: 'Creator subscription revenue (75%)',
        })
        bustAgentUserId = credited.bustAgentUserId
        creatorLivestreamResult = credited.livestreamLevelResult

        return created
      },
      { isolationLevel: 'Serializable' },
    )

    await walletService.adjustCoinBalanceCache(subscriberId, SUBSCRIPTION_COIN_COST)
    await syncLevelCacheFromApplyResult(subscriberId, LevelType.WEALTH, subscriberWealthResult)
    await syncLevelCacheFromApplyResult(creatorId, LevelType.LIVESTREAM, creatorLivestreamResult)
    const creatorPoints = hostPointsFromSubscription(SUBSCRIPTION_COIN_COST)
    if (creatorPoints > 0n) {
      await walletService.adjustPointBalanceCache(creatorId, creatorPoints)
    }
    await bustAgentCommissionIfNeeded(bustAgentUserId)
    await setSubscriptionAccess(subscriberId, creatorId, row.nextRenewalAt)
    await invalidateSubscriberCountCache(creatorId)
    await invalidateTopCreatorsCachesForCreator(creatorId)
    await enqueueSubscriptionRenewal(row.id, row.nextRenewalAt)

    console.info('[Subscription] created', {
      subscriptionId: row.id,
      subscriberId,
      creatorId,
      nextRenewalAt: row.nextRenewalAt.toISOString(),
    })

    return row
  },

  async cancelSubscription(subscriberId: string, creatorId: string): Promise<void> {
    const sub = await subscriptionRepository.findByPair(subscriberId, creatorId)
    if (!sub) {
      throw new AppError(404, 'Subscription not found', 'NOT_FOUND')
    }
    if (
      sub.status !== CreatorSubscriptionStatus.ACTIVE &&
      sub.status !== CreatorSubscriptionStatus.GRACE
    ) {
      throw new AppError(404, 'Subscription not active', 'NOT_FOUND')
    }

    await subscriptionRepository.updateById(sub.id, {
      status: CreatorSubscriptionStatus.CANCELLED,
      graceUntil: null,
    })
    await cancelSubscriptionRenewalJob(sub.id)
    await cancelSubscriptionGraceJob(sub.id)
    await redisClient.del(RedisKeys.subscriptionAccess(subscriberId, creatorId))
    await userSubscriberRepository.deletePair(subscriberId, creatorId)
    await invalidateSubscriberCountCache(creatorId)
    await invalidateTopCreatorsCachesForCreator(creatorId)

    console.info('[Subscription] cancelled', { subscriptionId: sub.id, subscriberId, creatorId })
  },

  /** Cancel renewal/grace for subscriptions in either direction; keep access until period end. */
  async stopRenewalsDueToBlock(userA: string, userB: string): Promise<void> {
    await stopRenewalDueToBlockKeepingAccess(userA, userB)
    await stopRenewalDueToBlockKeepingAccess(userB, userA)
  },

  async checkAccess(subscriberId: string, creatorId: string): Promise<boolean> {
    if (subscriberId === creatorId) {
      return true
    }
    const key = RedisKeys.subscriptionAccess(subscriberId, creatorId)
    const hit = await redisClient.get(key)
    if (hit === '1') {
      return true
    }

    const row = await subscriptionRepository.findByPair(subscriberId, creatorId)
    if (!row || row.status !== CreatorSubscriptionStatus.ACTIVE) {
      return false
    }

    await setSubscriptionAccess(subscriberId, creatorId, row.nextRenewalAt)
    return true
  },

  getActiveSubscriberCountForCreator: readThroughActiveSubscriberCount,

  async isSubscribed(subscriberId: string, creatorId: string): Promise<boolean> {
    if (subscriberId === creatorId) return false
    return subscriptionRepository.isActivePair(subscriberId, creatorId)
  },

  async listMySubscriptions(subscriberId: string): Promise<
    Array<{
      userId: string
      publicId: string
      displayPublicId: string
      name: string
      username: string
      displayName: string
      avatarUrl: string | null
      country: string | null
    }>
  > {
    const rows = await subscriptionRepository.listActiveCreatorsForSubscriber(subscriberId)
    return rows.map((r) => {
      const displayName = buildUserDisplayName(r.creator)
      return {
        userId: r.creator.id,
        publicId: r.creator.publicId.toString(),
        displayPublicId: resolveDisplayPublicId(r.creator),
        name: displayName,
        username: r.creator.username,
        displayName,
        avatarUrl: r.creator.avatarUrl,
        country: r.creator.country,
      }
    })
  },

  async listMySubscribers(creatorId: string): Promise<
    Array<{
      userId: string
      publicId: string
      displayPublicId: string
      name: string
      username: string
      displayName: string
      avatarUrl: string | null
      country: string | null
    }>
  > {
    const rows = await subscriptionRepository.listActiveSubscribersForCreator(creatorId)
    return rows.map((r) => {
      const displayName = buildUserDisplayName(r.subscriber)
      return {
        userId: r.subscriber.id,
        publicId: r.subscriber.publicId.toString(),
        displayPublicId: resolveDisplayPublicId(r.subscriber),
        name: displayName,
        username: r.subscriber.username,
        displayName,
        avatarUrl: r.subscriber.avatarUrl,
        country: r.subscriber.country,
      }
    })
  },

  async getActiveSubscriberCountByPublicId(publicId: number): Promise<number> {
    const creator = await userRepository.findByPublicId(publicId)
    if (!creator) {
      throw new AppError(404, 'User not found', 'NOT_FOUND')
    }
    return readThroughActiveSubscriberCount(creator.id)
  },

  async processRenewalJob(subscriptionId: string): Promise<void> {
    const sub = await subscriptionRepository.findById(subscriptionId)
    if (!sub || sub.status !== CreatorSubscriptionStatus.ACTIVE) {
      return
    }

    if (await isBlockedEitherWay(sub.subscriberId, sub.creatorId)) {
      await stopRenewalDueToBlockKeepingAccess(sub.subscriberId, sub.creatorId)
      return
    }

    const idempotencyKey = `sub-renewal:${subscriptionId}:${sub.nextRenewalAt.toISOString()}`
    const hostPtsIdem = `sub-host-pts:renewal:${subscriptionId}:${sub.nextRenewalAt.toISOString()}`

    try {
      let bustAgentUserId: string | null = null
      let subscriberWealthResult: LevelApplyResult | null = null
      let creatorLivestreamResult: LevelApplyResult | null = null
      await prisma.$transaction(
        async (tx) => {
          subscriberWealthResult = await coinWalletService.debitForCreatorSubscription(
            sub.subscriberId,
            SUBSCRIPTION_COIN_COST,
            {
              creatorId: sub.creatorId,
              subscriptionId: sub.id,
              idempotencyKey,
              description: 'Creator subscription renewal',
              applyWealthXp: true,
            },
            tx,
          )
          const credited = await creditCreatorSubscriptionPoints(tx, {
            creatorId: sub.creatorId,
            subscriberId: sub.subscriberId,
            subscriptionId: sub.id,
            coinsPaid: SUBSCRIPTION_COIN_COST,
            idempotencyKey: hostPtsIdem,
            description: 'Creator subscription renewal revenue (75%)',
          })
          bustAgentUserId = credited.bustAgentUserId
          creatorLivestreamResult = credited.livestreamLevelResult
        },
        { isolationLevel: 'Serializable' },
      )

      await walletService.adjustCoinBalanceCache(sub.subscriberId, SUBSCRIPTION_COIN_COST)
      await syncLevelCacheFromApplyResult(
        sub.subscriberId,
        LevelType.WEALTH,
        subscriberWealthResult,
      )
      await syncLevelCacheFromApplyResult(
        sub.creatorId,
        LevelType.LIVESTREAM,
        creatorLivestreamResult,
      )
      const creatorPoints = hostPointsFromSubscription(SUBSCRIPTION_COIN_COST)
      if (creatorPoints > 0n) {
        await walletService.adjustPointBalanceCache(sub.creatorId, creatorPoints)
      }
      await bustAgentCommissionIfNeeded(bustAgentUserId)

      const nextRenewalAt = new Date(sub.nextRenewalAt.getTime() + SUBSCRIPTION_PERIOD_MS)
      await subscriptionRepository.updateById(sub.id, {
        nextRenewalAt,
        graceUntil: null,
        status: CreatorSubscriptionStatus.ACTIVE,
      })
      await cancelSubscriptionGraceJob(sub.id)
      await setSubscriptionAccess(sub.subscriberId, sub.creatorId, nextRenewalAt)
      await enqueueSubscriptionRenewal(sub.id, nextRenewalAt)

      console.info('[Subscription renewal] success', {
        subscriptionId: sub.id,
        nextRenewalAt: nextRenewalAt.toISOString(),
      })
    } catch (e) {
      if (e instanceof AppError && e.code === 'INSUFFICIENT_COINS') {
        const graceUntil = new Date(Date.now() + SUBSCRIPTION_GRACE_MS)
        await subscriptionRepository.updateById(sub.id, {
          status: CreatorSubscriptionStatus.GRACE,
          graceUntil,
        })
        await redisClient.del(RedisKeys.subscriptionAccess(sub.subscriberId, sub.creatorId))
        await cancelSubscriptionRenewalJob(sub.id)
        await enqueueSubscriptionGrace(sub.id, graceUntil)

        console.info('[Subscription renewal] insufficient coins → grace', {
          subscriptionId: sub.id,
          graceUntil: graceUntil.toISOString(),
        })
        return
      }
      throw e
    }
  },

  async processGraceJob(subscriptionId: string): Promise<void> {
    const sub = await subscriptionRepository.findById(subscriptionId)
    if (!sub || sub.status !== CreatorSubscriptionStatus.GRACE) {
      return
    }
    if (!sub.graceUntil || sub.graceUntil.getTime() > Date.now()) {
      return
    }

    if (await isBlockedEitherWay(sub.subscriberId, sub.creatorId)) {
      await stopRenewalDueToBlockKeepingAccess(sub.subscriberId, sub.creatorId)
      return
    }

    const idempotencyKey = `sub-grace:${subscriptionId}:${sub.graceUntil.toISOString()}`
    const hostPtsIdem = `sub-host-pts:grace:${subscriptionId}:${sub.graceUntil.toISOString()}`

    try {
      let bustAgentUserId: string | null = null
      let subscriberWealthResult: LevelApplyResult | null = null
      let creatorLivestreamResult: LevelApplyResult | null = null
      await prisma.$transaction(
        async (tx) => {
          subscriberWealthResult = await coinWalletService.debitForCreatorSubscription(
            sub.subscriberId,
            SUBSCRIPTION_COIN_COST,
            {
              creatorId: sub.creatorId,
              subscriptionId: sub.id,
              idempotencyKey,
              description: 'Creator subscription (grace recovery)',
              applyWealthXp: true,
            },
            tx,
          )
          const credited = await creditCreatorSubscriptionPoints(tx, {
            creatorId: sub.creatorId,
            subscriberId: sub.subscriberId,
            subscriptionId: sub.id,
            coinsPaid: SUBSCRIPTION_COIN_COST,
            idempotencyKey: hostPtsIdem,
            description: 'Creator subscription grace recovery revenue (75%)',
          })
          bustAgentUserId = credited.bustAgentUserId
          creatorLivestreamResult = credited.livestreamLevelResult
        },
        { isolationLevel: 'Serializable' },
      )

      await walletService.adjustCoinBalanceCache(sub.subscriberId, SUBSCRIPTION_COIN_COST)
      await syncLevelCacheFromApplyResult(
        sub.subscriberId,
        LevelType.WEALTH,
        subscriberWealthResult,
      )
      await syncLevelCacheFromApplyResult(
        sub.creatorId,
        LevelType.LIVESTREAM,
        creatorLivestreamResult,
      )
      const creatorPoints = hostPointsFromSubscription(SUBSCRIPTION_COIN_COST)
      if (creatorPoints > 0n) {
        await walletService.adjustPointBalanceCache(sub.creatorId, creatorPoints)
      }
      await bustAgentCommissionIfNeeded(bustAgentUserId)

      const nextRenewalAt = new Date(Date.now() + SUBSCRIPTION_PERIOD_MS)
      await subscriptionRepository.updateById(sub.id, {
        status: CreatorSubscriptionStatus.ACTIVE,
        nextRenewalAt,
        graceUntil: null,
      })
      await setSubscriptionAccess(sub.subscriberId, sub.creatorId, nextRenewalAt)
      await enqueueSubscriptionRenewal(sub.id, nextRenewalAt)
      await cancelSubscriptionGraceJob(sub.id)

      console.info('[Subscription grace] recovered', {
        subscriptionId: sub.id,
        nextRenewalAt: nextRenewalAt.toISOString(),
      })
    } catch (e) {
      if (e instanceof AppError && e.code === 'INSUFFICIENT_COINS') {
        await subscriptionRepository.updateById(sub.id, {
          status: CreatorSubscriptionStatus.EXPIRED,
          graceUntil: null,
        })
        await redisClient.del(RedisKeys.subscriptionAccess(sub.subscriberId, sub.creatorId))
        await userSubscriberRepository.deletePair(sub.subscriberId, sub.creatorId)
        await invalidateSubscriberCountCache(sub.creatorId)
        await invalidateTopCreatorsCachesForCreator(sub.creatorId)
        await cancelSubscriptionGraceJob(sub.id)

        console.info('[Subscription grace] expired', { subscriptionId: sub.id })
        return
      }
      throw e
    }
  },
}
