import crypto from 'crypto'
import { CreatorSubscriptionStatus, PointTxType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import {
  getRedisForRead,
  redisClient,
  RedisKeys,
  SUBSCRIPTION_COUNT_CACHE_TTL,
  SUB_TOP_CREATORS_TTL,
} from '../config/redis'
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
import { subscriptionRepository } from '../repositories/subscription.repository'
import { userRepository } from '../repositories/user.repository'
import { userSubscriberRepository } from '../repositories/userSubscriber.repository'
import { hostRevenuePointsFromCoins } from '../config/host-revenue-shares'
import { coinWalletService } from './coin-wallet.service'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'

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
): Promise<{ hostPoints: bigint; bustAgentUserId: string | null }> {
  const hostPoints = hostRevenuePointsFromCoins(params.coinsPaid)
  if (hostPoints <= 0n) {
    return { hostPoints: 0n, bustAgentUserId: null }
  }

  const { bustAgentUserId } = await pointWalletService.creditInTransaction(
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
        hostShareBp: 5000,
      },
    },
  )
  return { hostPoints, bustAgentUserId }
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
  await redisClient.set(
    RedisKeys.subscriptionAccess(subscriberId, creatorId),
    '1',
    'EX',
    ttl,
  )
}

async function invalidateSubscriberCountCache(creatorId: string): Promise<void> {
  try {
    await redisClient.del(RedisKeys.subscriptionCreatorCount(creatorId))
  } catch {
    // ignore
  }
}

async function readThroughActiveSubscriberCount(creatorId: string): Promise<number> {
  const cacheKey = RedisKeys.subscriptionCreatorCount(creatorId)
  const cached = await getRedisForRead().get(cacheKey)
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

export type TopCreatorCard = {
  userId: string
  publicId: string
  displayName: string
  avatarUrl: string | null
  subscriberCount: number
}

function buildDisplayName(user: {
  username: string
  firstName: string | null
  lastName: string | null
}): string {
  const fullName =
    user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName ?? user.lastName
  const trimmed = fullName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : user.username
}

function mapTopCreatorRow(
  row: Awaited<ReturnType<typeof subscriptionRepository.queryTopCreatorsByCountry>>[number],
): TopCreatorCard {
  return {
    userId: row.id,
    publicId: row.publicId.toString(),
    displayName: buildDisplayName(row),
    avatarUrl: row.avatarUrl,
    subscriberCount: row._count.creatorSubsAsHost,
  }
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
  ): Promise<{ creators: TopCreatorCard[]; country: string }> {
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { country: true },
    })
    if (!user?.country) {
      throw new AppError(
        400,
        'Please set your country in your profile to see top creators',
        'COUNTRY_NOT_SET',
      )
    }

    const country = user.country
    const cacheKey = RedisKeys.subscriptionTopCreators(country)
    const cached = await getRedisForRead().get(cacheKey)

    let top4: TopCreatorCard[]
    if (cached) {
      top4 = JSON.parse(cached) as TopCreatorCard[]
    } else {
      const rows = await subscriptionRepository.queryTopCreatorsByCountry(country, 4)
      top4 = rows.map(mapTopCreatorRow)
      await redisClient.set(cacheKey, JSON.stringify(top4), 'EX', SUB_TOP_CREATORS_TTL)
    }

    const creators = top4.filter((c) => c.userId !== userId).slice(0, 3)
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
    const posts = page.map((post) =>
      assembleUnlockedPostResponse(post, likedSet.has(post.id)),
    )

    return { posts, nextCursor, hasSubscriptions: true }
  },

  async createSubscription(subscriberId: string, creatorId: string) {
    if (subscriberId === creatorId) {
      throw new AppError(400, 'Cannot subscribe to yourself', 'INVALID_REQUEST')
    }

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
    const row = await prisma.$transaction(
      async (tx) => {
        await coinWalletService.debitForCreatorSubscription(
          subscriberId,
          SUBSCRIPTION_COIN_COST,
          {
            creatorId,
            subscriptionId: `pending:${subscriberId}:${creatorId}`,
            idempotencyKey,
            description: 'Creator subscription (initial)',
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
          idempotencyKey: `sub-host-pts:${created.id}:initial`,
          description: 'Creator subscription revenue (50%)',
        })
        bustAgentUserId = credited.bustAgentUserId

        return created
      },
      { isolationLevel: 'Serializable' },
    )

    await walletService.adjustCoinBalanceCache(subscriberId, SUBSCRIPTION_COIN_COST)
    const creatorPoints = hostRevenuePointsFromCoins(SUBSCRIPTION_COIN_COST)
    if (creatorPoints > 0n) {
      await walletService.adjustPointBalanceCache(creatorId, creatorPoints)
    }
    await bustAgentCommissionIfNeeded(bustAgentUserId)
    await setSubscriptionAccess(subscriberId, creatorId, row.nextRenewalAt)
    await invalidateSubscriberCountCache(creatorId)
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

    console.info('[Subscription] cancelled', { subscriptionId: sub.id, subscriberId, creatorId })
  },

  async checkAccess(subscriberId: string, creatorId: string): Promise<boolean> {
    if (subscriberId === creatorId) {
      return true
    }
    const key = RedisKeys.subscriptionAccess(subscriberId, creatorId)
    const hit = await getRedisForRead().get(key)
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
      username: string
      displayName: string
      avatarUrl: string | null
      country: string | null
    }>
  > {
    const rows = await subscriptionRepository.listActiveCreatorsForSubscriber(subscriberId)
    return rows.map((r) => ({
      userId: r.creator.id,
      publicId: r.creator.publicId.toString(),
      username: r.creator.username,
      displayName: buildDisplayName(r.creator),
      avatarUrl: r.creator.avatarUrl,
      country: r.creator.country,
    }))
  },

  async listMySubscribers(creatorId: string): Promise<
    Array<{
      userId: string
      publicId: string
      username: string
      displayName: string
      avatarUrl: string | null
      country: string | null
    }>
  > {
    const rows = await subscriptionRepository.listActiveSubscribersForCreator(creatorId)
    return rows.map((r) => ({
      userId: r.subscriber.id,
      publicId: r.subscriber.publicId.toString(),
      username: r.subscriber.username,
      displayName: buildDisplayName(r.subscriber),
      avatarUrl: r.subscriber.avatarUrl,
      country: r.subscriber.country,
    }))
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

    const idempotencyKey = `sub-renewal:${subscriptionId}:${sub.nextRenewalAt.toISOString()}`
    const hostPtsIdem = `sub-host-pts:renewal:${subscriptionId}:${sub.nextRenewalAt.toISOString()}`

    try {
      let bustAgentUserId: string | null = null
      await prisma.$transaction(
        async (tx) => {
          await coinWalletService.debitForCreatorSubscription(
            sub.subscriberId,
            SUBSCRIPTION_COIN_COST,
            {
              creatorId: sub.creatorId,
              subscriptionId: sub.id,
              idempotencyKey,
              description: 'Creator subscription renewal',
            },
            tx,
          )
          const credited = await creditCreatorSubscriptionPoints(tx, {
            creatorId: sub.creatorId,
            subscriberId: sub.subscriberId,
            subscriptionId: sub.id,
            coinsPaid: SUBSCRIPTION_COIN_COST,
            idempotencyKey: hostPtsIdem,
            description: 'Creator subscription renewal revenue (50%)',
          })
          bustAgentUserId = credited.bustAgentUserId
        },
        { isolationLevel: 'Serializable' },
      )

      await walletService.adjustCoinBalanceCache(
        sub.subscriberId,
        SUBSCRIPTION_COIN_COST,
      )
      const creatorPoints = hostRevenuePointsFromCoins(SUBSCRIPTION_COIN_COST)
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
        await redisClient.del(
          RedisKeys.subscriptionAccess(sub.subscriberId, sub.creatorId),
        )
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

    const idempotencyKey = `sub-grace:${subscriptionId}:${sub.graceUntil.toISOString()}`
    const hostPtsIdem = `sub-host-pts:grace:${subscriptionId}:${sub.graceUntil.toISOString()}`

    try {
      let bustAgentUserId: string | null = null
      await prisma.$transaction(
        async (tx) => {
          await coinWalletService.debitForCreatorSubscription(
            sub.subscriberId,
            SUBSCRIPTION_COIN_COST,
            {
              creatorId: sub.creatorId,
              subscriptionId: sub.id,
              idempotencyKey,
              description: 'Creator subscription (grace recovery)',
            },
            tx,
          )
          const credited = await creditCreatorSubscriptionPoints(tx, {
            creatorId: sub.creatorId,
            subscriberId: sub.subscriberId,
            subscriptionId: sub.id,
            coinsPaid: SUBSCRIPTION_COIN_COST,
            idempotencyKey: hostPtsIdem,
            description: 'Creator subscription grace recovery revenue (50%)',
          })
          bustAgentUserId = credited.bustAgentUserId
        },
        { isolationLevel: 'Serializable' },
      )

      await walletService.adjustCoinBalanceCache(
        sub.subscriberId,
        SUBSCRIPTION_COIN_COST,
      )
      const creatorPoints = hostRevenuePointsFromCoins(SUBSCRIPTION_COIN_COST)
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
        await redisClient.del(
          RedisKeys.subscriptionAccess(sub.subscriberId, sub.creatorId),
        )
        await userSubscriberRepository.deletePair(sub.subscriberId, sub.creatorId)
        await invalidateSubscriberCountCache(sub.creatorId)
        await cancelSubscriptionGraceJob(sub.id)

        console.info('[Subscription grace] expired', { subscriptionId: sub.id })
        return
      }
      throw e
    }
  },
}
