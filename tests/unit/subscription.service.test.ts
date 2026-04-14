import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CreatorSubscriptionStatus } from '@prisma/client'

const debitForCreatorSubscription = vi.fn()
vi.mock('../../src/services/coin-wallet.service', () => ({
  coinWalletService: {
    debitForCreatorSubscription: (...a: unknown[]) =>
      debitForCreatorSubscription(...a),
  },
}))

const findByPair = vi.fn()
const findById = vi.fn()
const countActiveByCreatorId = vi.fn()
const isActivePair = vi.fn()
const listActiveCreatorsForSubscriber = vi.fn()
const listActiveSubscribersForCreator = vi.fn()
const upsertActiveInTx = vi.fn()
const updateById = vi.fn()
vi.mock('../../src/repositories/subscription.repository', () => ({
  subscriptionRepository: {
    findByPair: (...a: unknown[]) => findByPair(...a),
    findById: (...a: unknown[]) => findById(...a),
    countActiveByCreatorId: (...a: unknown[]) => countActiveByCreatorId(...a),
    isActivePair: (...a: unknown[]) => isActivePair(...a),
    listActiveCreatorsForSubscriber: (...a: unknown[]) =>
      listActiveCreatorsForSubscriber(...a),
    listActiveSubscribersForCreator: (...a: unknown[]) =>
      listActiveSubscribersForCreator(...a),
    upsertActiveInTx: (...a: unknown[]) => upsertActiveInTx(...a),
    updateById: (...a: unknown[]) => updateById(...a),
  },
}))

const findByIdUser = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...a: unknown[]) => findByIdUser(...a),
    findByPublicId: vi.fn(),
  },
}))

const upsertPairInTx = vi.fn()
const deletePair = vi.fn()
vi.mock('../../src/repositories/userSubscriber.repository', () => ({
  userSubscriberRepository: {
    upsertPairInTx: (...a: unknown[]) => upsertPairInTx(...a),
    deletePair: (...a: unknown[]) => deletePair(...a),
  },
}))

const adjustCoinBalanceCache = vi.fn()
vi.mock('../../src/services/wallet.service', () => ({
  walletService: {
    adjustCoinBalanceCache: (...a: unknown[]) => adjustCoinBalanceCache(...a),
  },
}))

const enqueueSubscriptionRenewal = vi.fn()
const enqueueSubscriptionGrace = vi.fn()
const cancelSubscriptionRenewalJob = vi.fn()
const cancelSubscriptionGraceJob = vi.fn()
vi.mock('../../src/queues/subscription.queue', () => ({
  enqueueSubscriptionRenewal: (...a: unknown[]) =>
    enqueueSubscriptionRenewal(...a),
  enqueueSubscriptionGrace: (...a: unknown[]) => enqueueSubscriptionGrace(...a),
  cancelSubscriptionRenewalJob: (...a: unknown[]) =>
    cancelSubscriptionRenewalJob(...a),
  cancelSubscriptionGraceJob: (...a: unknown[]) =>
    cancelSubscriptionGraceJob(...a),
}))

const redisSet = vi.fn()
const redisDel = vi.fn()
const redisGet = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    set: (...a: unknown[]) => redisSet(...a),
    del: (...a: unknown[]) => redisDel(...a),
    get: (...a: unknown[]) => redisGet(...a),
  },
  getRedisForRead: () => ({
    get: (...a: unknown[]) => redisGet(...a),
  }),
  RedisKeys: {
    subscriptionAccess: (subscriberId: string, creatorId: string) =>
      `sub:access:${subscriberId}:${creatorId}`,
    subscriptionCreatorCount: (creatorId: string) => `sub:count:${creatorId}`,
  },
  SUBSCRIPTION_COUNT_CACHE_TTL: 300,
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    $transaction: async (fn: (tx: Record<string, never>) => Promise<unknown>) =>
      fn({}),
  },
}))

const { subscriptionService } = await import('../../src/services/subscription.service')
const { AppError } = await import('../../src/middlewares/errorHandler')

describe('subscriptionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    debitForCreatorSubscription.mockResolvedValue(undefined)
    findByIdUser.mockResolvedValue({ id: 'creator-1' })
    upsertActiveInTx.mockResolvedValue({
      id: 'sub-1',
      subscriberId: 'fan-1',
      creatorId: 'creator-1',
      status: CreatorSubscriptionStatus.ACTIVE,
      nextRenewalAt: new Date('2026-05-12T00:00:00Z'),
      graceUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  it('createSubscription happy path: debit, tx upsert, redis set, renewal enqueue', async () => {
    findByPair.mockResolvedValue(null)

    await subscriptionService.createSubscription('fan-1', 'creator-1')

    expect(debitForCreatorSubscription).toHaveBeenCalled()
    expect(upsertActiveInTx).toHaveBeenCalled()
    expect(upsertPairInTx).toHaveBeenCalled()
    expect(adjustCoinBalanceCache).toHaveBeenCalledWith('fan-1', 5000n)
    expect(redisSet).toHaveBeenCalled()
    expect(enqueueSubscriptionRenewal).toHaveBeenCalledWith(
      'sub-1',
      expect.any(Date),
    )
  })

  it('createSubscription duplicate throws 409', async () => {
    findByPair.mockResolvedValue({
      id: 'sub-1',
      status: CreatorSubscriptionStatus.ACTIVE,
    })

    await expect(
      subscriptionService.createSubscription('fan-1', 'creator-1'),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SUBSCRIPTION_DUPLICATE' })
    expect(debitForCreatorSubscription).not.toHaveBeenCalled()
  })

  it('cancelSubscription sets CANCELLED and clears jobs and access', async () => {
    findByPair.mockResolvedValue({
      id: 'sub-1',
      subscriberId: 'fan-1',
      creatorId: 'creator-1',
      status: CreatorSubscriptionStatus.ACTIVE,
      nextRenewalAt: new Date(),
      graceUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    updateById.mockResolvedValue({})

    await subscriptionService.cancelSubscription('fan-1', 'creator-1')

    expect(updateById).toHaveBeenCalledWith(
      'sub-1',
      expect.objectContaining({ status: CreatorSubscriptionStatus.CANCELLED }),
    )
    expect(cancelSubscriptionRenewalJob).toHaveBeenCalledWith('sub-1')
    expect(cancelSubscriptionGraceJob).toHaveBeenCalledWith('sub-1')
    expect(redisDel).toHaveBeenCalledWith('sub:access:fan-1:creator-1')
    expect(deletePair).toHaveBeenCalledWith('fan-1', 'creator-1')
  })

  it('checkAccess Redis hit skips DB', async () => {
    redisGet.mockResolvedValueOnce('1')

    const ok = await subscriptionService.checkAccess('fan-1', 'creator-1')

    expect(ok).toBe(true)
    expect(findByPair).not.toHaveBeenCalled()
  })

  it('checkAccess Redis miss uses DB and warms cache', async () => {
    redisGet.mockResolvedValueOnce(null)
    findByPair.mockResolvedValue({
      id: 'sub-1',
      subscriberId: 'fan-1',
      creatorId: 'creator-1',
      status: CreatorSubscriptionStatus.ACTIVE,
      nextRenewalAt: new Date('2026-06-01T00:00:00Z'),
      graceUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const ok = await subscriptionService.checkAccess('fan-1', 'creator-1')

    expect(ok).toBe(true)
    expect(findByPair).toHaveBeenCalled()
    expect(redisSet).toHaveBeenCalled()
  })

  it('isSubscribed returns repository active pair result', async () => {
    isActivePair.mockResolvedValueOnce(true)
    const ok = await subscriptionService.isSubscribed('fan-1', 'creator-1')
    expect(ok).toBe(true)
    expect(isActivePair).toHaveBeenCalledWith('fan-1', 'creator-1')
  })

  it('listMySubscriptions maps creator list payload', async () => {
    listActiveCreatorsForSubscriber.mockResolvedValueOnce([
      {
        creator: {
          id: 'creator-1',
          publicId: 34216590n,
          username: 'creator',
          firstName: 'Jane',
          lastName: 'Doe',
          avatarUrl: 'https://cdn/a.png',
          country: 'NP',
        },
      },
    ])
    const items = await subscriptionService.listMySubscriptions('fan-1')
    expect(items[0]).toMatchObject({
      userId: 'creator-1',
      publicId: '34216590',
      username: 'creator',
      displayName: 'Jane Doe',
      avatarUrl: 'https://cdn/a.png',
      country: 'NP',
    })
  })

  it('listMySubscribers maps subscriber list payload', async () => {
    listActiveSubscribersForCreator.mockResolvedValueOnce([
      {
        subscriber: {
          id: 'fan-1',
          publicId: 34216599n,
          username: 'fan',
          firstName: null,
          lastName: null,
          avatarUrl: null,
          country: null,
        },
      },
    ])
    const items = await subscriptionService.listMySubscribers('creator-1')
    expect(items[0]).toMatchObject({
      userId: 'fan-1',
      publicId: '34216599',
      username: 'fan',
      displayName: 'fan',
      avatarUrl: null,
      country: null,
    })
  })

  it('renewalJob success advances nextRenewalAt and schedules next renewal', async () => {
    const next0 = new Date('2026-04-01T00:00:00Z')
    findById.mockResolvedValue({
      id: 'sub-1',
      subscriberId: 'fan-1',
      creatorId: 'creator-1',
      status: CreatorSubscriptionStatus.ACTIVE,
      nextRenewalAt: next0,
      graceUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    updateById.mockResolvedValue({})

    await subscriptionService.processRenewalJob('sub-1')

    expect(debitForCreatorSubscription).toHaveBeenCalled()
    expect(updateById).toHaveBeenCalledWith(
      'sub-1',
      expect.objectContaining({
        status: CreatorSubscriptionStatus.ACTIVE,
        graceUntil: null,
      }),
    )
    expect(enqueueSubscriptionRenewal).toHaveBeenCalled()
    expect(cancelSubscriptionGraceJob).toHaveBeenCalledWith('sub-1')
  })

  it('renewalJob failure moves to GRACE and enqueues grace job', async () => {
    findById.mockResolvedValue({
      id: 'sub-1',
      subscriberId: 'fan-1',
      creatorId: 'creator-1',
      status: CreatorSubscriptionStatus.ACTIVE,
      nextRenewalAt: new Date('2026-04-01T00:00:00Z'),
      graceUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    debitForCreatorSubscription.mockRejectedValue(
      new AppError(402, 'Insufficient coins', 'INSUFFICIENT_COINS', {}),
    )
    updateById.mockResolvedValue({})

    await subscriptionService.processRenewalJob('sub-1')

    expect(updateById).toHaveBeenCalledWith(
      'sub-1',
      expect.objectContaining({ status: CreatorSubscriptionStatus.GRACE }),
    )
    expect(redisDel).toHaveBeenCalledWith('sub:access:fan-1:creator-1')
    expect(cancelSubscriptionRenewalJob).toHaveBeenCalledWith('sub-1')
    expect(enqueueSubscriptionGrace).toHaveBeenCalled()
  })

  it('graceJob failure expires and deletes access', async () => {
    const past = new Date(Date.now() - 60_000)
    findById.mockResolvedValue({
      id: 'sub-1',
      subscriberId: 'fan-1',
      creatorId: 'creator-1',
      status: CreatorSubscriptionStatus.GRACE,
      nextRenewalAt: new Date(),
      graceUntil: past,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    debitForCreatorSubscription.mockRejectedValue(
      new AppError(402, 'Insufficient coins', 'INSUFFICIENT_COINS', {}),
    )
    updateById.mockResolvedValue({})

    await subscriptionService.processGraceJob('sub-1')

    expect(updateById).toHaveBeenCalledWith(
      'sub-1',
      expect.objectContaining({ status: CreatorSubscriptionStatus.EXPIRED }),
    )
    expect(redisDel).toHaveBeenCalledWith('sub:access:fan-1:creator-1')
    expect(deletePair).toHaveBeenCalledWith('fan-1', 'creator-1')
    expect(cancelSubscriptionGraceJob).toHaveBeenCalledWith('sub-1')
  })
})
