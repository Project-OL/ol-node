import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreatorSubscriptionStatus, PointTxType, type Guardian } from '@prisma/client'

const fanUserId = 'user-b'
const creatorUserId = 'user-a'

let fanCoinBalance = 0n
let creatorPointBalance = 0n
const coinDebits: bigint[] = []
const pointCredits: bigint[] = []
const coinDebitKeys: string[] = []
const pointCreditKeys: string[] = []

const debitForCreatorSubscription = vi.fn(
  async (
    userId: string,
    amount: bigint,
    options: { idempotencyKey: string },
  ) => {
    expect(userId).toBe(fanUserId)
    expect(fanCoinBalance).toBeGreaterThanOrEqual(amount)
    fanCoinBalance -= amount
    coinDebits.push(amount)
    coinDebitKeys.push(options.idempotencyKey)
  },
)
const debitForGuardianPurchase = vi.fn(
  async (
    userId: string,
    amount: bigint,
    options: { idempotencyKey: string },
  ) => {
    expect(userId).toBe(fanUserId)
    expect(fanCoinBalance).toBeGreaterThanOrEqual(amount)
    fanCoinBalance -= amount
    coinDebits.push(amount)
    coinDebitKeys.push(options.idempotencyKey)
  },
)
vi.mock('../../src/services/coin-wallet.service', () => ({
  coinWalletService: {
    debitForCreatorSubscription: (...args: Parameters<typeof debitForCreatorSubscription>) =>
      debitForCreatorSubscription(...args),
    debitForGuardianPurchase: (...args: Parameters<typeof debitForGuardianPurchase>) =>
      debitForGuardianPurchase(...args),
  },
}))

const creditInTransaction = vi.fn(
  async (
    userId: string,
    amount: bigint,
    txType: PointTxType,
    _tx: unknown,
    options: { idempotencyKey: string },
  ) => {
    expect(userId).toBe(creatorUserId)
    expect([PointTxType.SUBSCRIPTION, PointTxType.GUARDIAN_PURCHASE]).toContain(txType)
    creatorPointBalance += amount
    pointCredits.push(amount)
    pointCreditKeys.push(options.idempotencyKey)
    return {
      ledgerEntryId: `point-ledger-${pointCredits.length}`,
      balanceAfter: creatorPointBalance,
      bustAgentUserId: null,
    }
  },
)
vi.mock('../../src/services/point-wallet.service', () => ({
  pointWalletService: {
    creditInTransaction: (...args: Parameters<typeof creditInTransaction>) =>
      creditInTransaction(...args),
  },
}))

const subscriptionRows: Array<{
  id: string
  subscriberId: string
  creatorId: string
  status: CreatorSubscriptionStatus
  nextRenewalAt: Date
  graceUntil: null
  createdAt: Date
  updatedAt: Date
}> = []
const findByPair = vi.fn()
const upsertActiveInTx = vi.fn()
vi.mock('../../src/repositories/subscription.repository', () => ({
  subscriptionRepository: {
    findByPair: (...args: unknown[]) => findByPair(...args),
    upsertActiveInTx: (...args: unknown[]) => upsertActiveInTx(...args),
    findById: vi.fn(),
    countActiveByCreatorId: vi.fn(),
    isActivePair: vi.fn(),
    listActiveCreatorsForSubscriber: vi.fn(),
    listActiveSubscribersForCreator: vi.fn(),
    updateById: vi.fn(),
    getActiveSubscriptions: vi.fn(),
    queryTopCreatorsByCountry: vi.fn(),
  },
}))

const guardianRows: Guardian[] = []
const upsertGuardian = vi.fn()
const findActiveGuardiansForTarget = vi.fn()
vi.mock('../../src/repositories/guardian.repository', () => ({
  guardianRepository: {
    upsertGuardian: (...args: unknown[]) => upsertGuardian(...args),
    findActiveGuardiansForTarget: (...args: unknown[]) => findActiveGuardiansForTarget(...args),
    findById: vi.fn(),
    markExpired: vi.fn(),
    findMyGuardians: vi.fn(),
    findGuardiansOfMe: vi.fn(),
    findActiveByTargetIds: vi.fn(),
  },
}))

const findByIdUser = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...args: unknown[]) => findByIdUser(...args),
    findByPublicId: vi.fn(),
  },
}))

const adjustCoinBalanceCache = vi.fn()
const adjustPointBalanceCache = vi.fn()
vi.mock('../../src/services/wallet.service', () => ({
  walletService: {
    adjustCoinBalanceCache: (...args: unknown[]) => adjustCoinBalanceCache(...args),
    adjustPointBalanceCache: (...args: unknown[]) => adjustPointBalanceCache(...args),
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    $transaction: async (fn: (tx: Record<string, never>) => Promise<unknown>) => fn({}),
  },
  prismaRead: {
    creatorSubscription: { count: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}))

const redisSet = vi.fn()
const redisDel = vi.fn()
const redisGet = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    set: (...args: unknown[]) => redisSet(...args),
    del: (...args: unknown[]) => redisDel(...args),
    get: (...args: unknown[]) => redisGet(...args),
  },
  getRedisForRead: () => ({
    get: (...args: unknown[]) => redisGet(...args),
  }),
  RedisKeys: {
    subscriptionAccess: (subscriberId: string, creatorId: string) =>
      `sub:access:${subscriberId}:${creatorId}`,
    subscriptionCreatorCount: (creatorId: string) => `sub:count:${creatorId}`,
    subscriptionTopCreators: (country: string) => `sub:top-creators:${country}`,
    guardianActive: (targetUserId: string) => `guardian:active:${targetUserId}`,
    guardianMeList: (targetUserId: string) => `guardian:me:${targetUserId}`,
    guardianMyList: (guardianUserId: string) => `guardian:my:${guardianUserId}`,
  },
  SUBSCRIPTION_COUNT_CACHE_TTL: 300,
  SUB_TOP_CREATORS_TTL: 300,
  GUARDIAN_ACTIVE_TTL: 300,
  GUARDIAN_LIST_TTL: 300,
}))

vi.mock('../../src/repositories/userSubscriber.repository', () => ({
  userSubscriberRepository: {
    upsertPairInTx: vi.fn(),
    deletePair: vi.fn(),
  },
}))
vi.mock('../../src/repositories/post.repository', () => ({
  postRepository: {
    getSubscriptionFeed: vi.fn(),
    batchExistsLike: vi.fn(),
  },
}))
vi.mock('../../src/queues/subscription.queue', () => ({
  enqueueSubscriptionRenewal: vi.fn(),
  enqueueSubscriptionGrace: vi.fn(),
  cancelSubscriptionRenewalJob: vi.fn(),
  cancelSubscriptionGraceJob: vi.fn(),
}))
vi.mock('../../src/queues/guardian.queue', () => ({
  enqueueGuardianExpiry: vi.fn(),
}))
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}))
vi.mock('../../src/services/user-level.service', () => ({
  walletLevelService: {
    getDisplayLevelsForUsers: vi.fn(),
  },
}))

const { subscriptionService } = await import('../../src/services/subscription.service')
const { guardianService } = await import('../../src/services/guardian.service')

function makeGuardianRow(partial: Partial<Guardian>): Guardian {
  const now = new Date()
  return {
    id: `guardian-${guardianRows.length + 1}`,
    guardianUserId: fanUserId,
    targetUserId: creatorUserId,
    tier: 'SILVER',
    durationMonths: 1,
    coinsPaid: 150_000n,
    purchasedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    isExpired: false,
    ...partial,
  } as Guardian
}

describe('subscription + guardian wallet flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fanCoinBalance = 500_000n
    creatorPointBalance = 0n
    coinDebits.length = 0
    pointCredits.length = 0
    coinDebitKeys.length = 0
    pointCreditKeys.length = 0
    subscriptionRows.length = 0
    guardianRows.length = 0

    findByIdUser.mockImplementation(async (userId: string) => {
      if (userId === creatorUserId) return { id: creatorUserId, username: 'user-a' }
      if (userId === fanUserId) return { id: fanUserId, username: 'user-b' }
      return null
    })
    // This scenario intentionally permits two successful subscribe actions.
    findByPair.mockResolvedValue(null)
    upsertActiveInTx.mockImplementation(async (_tx, params) => {
      const row = {
        id: 'sub-fixed',
        subscriberId: params.subscriberId,
        creatorId: params.creatorId,
        status: CreatorSubscriptionStatus.ACTIVE,
        nextRenewalAt: params.nextRenewalAt,
        graceUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      if (subscriptionRows.length === 0) subscriptionRows.push(row)
      return row
    })
    upsertGuardian.mockImplementation(async (params) => {
      const row = makeGuardianRow({
        id: 'guardian-fixed',
        guardianUserId: params.guardianUserId,
        targetUserId: params.targetUserId,
        tier: params.tier,
        durationMonths: params.durationMonths,
        coinsPaid: params.coinsPaid,
        expiresAt: params.expiresAt,
      })
      if (guardianRows.length === 0) guardianRows.push(row)
      return row
    })
    findActiveGuardiansForTarget.mockImplementation(async () => guardianRows)
  })

  it('debits user B coins and credits user A 50% points across subscribe, guardian, guardian, subscribe', async () => {
    await subscriptionService.createSubscription(fanUserId, creatorUserId)
    await guardianService.purchaseGuardian(fanUserId, {
      targetUserId: creatorUserId,
      tier: 'SILVER',
      durationMonths: 1,
    })
    await guardianService.purchaseGuardian(fanUserId, {
      targetUserId: creatorUserId,
      tier: 'SILVER',
      durationMonths: 1,
    })
    await subscriptionService.createSubscription(fanUserId, creatorUserId)

    expect(coinDebits).toEqual([5_000n, 150_000n, 150_000n, 5_000n])
    expect(pointCredits).toEqual([2_500n, 75_000n, 75_000n, 2_500n])
    expect(fanCoinBalance).toBe(190_000n)
    expect(creatorPointBalance).toBe(155_000n)

    expect(debitForCreatorSubscription).toHaveBeenCalledTimes(2)
    expect(debitForGuardianPurchase).toHaveBeenCalledTimes(2)
    expect(creditInTransaction).toHaveBeenCalledTimes(4)
    expect(new Set(pointCreditKeys).size).toBe(4)
    for (let i = 0; i < 4; i++) {
      expect(pointCreditKeys[i]).toBe(`${coinDebitKeys[i]}:host-points`)
    }
    expect(pointCreditKeys).not.toContain('sub-host-pts:sub-fixed:initial')
    expect(pointCreditKeys).not.toContain('guardian-host-pts:guardian-fixed')
    expect(adjustCoinBalanceCache).toHaveBeenNthCalledWith(1, fanUserId, 5_000n)
    expect(adjustCoinBalanceCache).toHaveBeenNthCalledWith(2, fanUserId, 150_000n)
    expect(adjustCoinBalanceCache).toHaveBeenNthCalledWith(3, fanUserId, 150_000n)
    expect(adjustCoinBalanceCache).toHaveBeenNthCalledWith(4, fanUserId, 5_000n)
    expect(adjustPointBalanceCache).toHaveBeenNthCalledWith(1, creatorUserId, 2_500n)
    expect(adjustPointBalanceCache).toHaveBeenNthCalledWith(2, creatorUserId, 75_000n)
    expect(adjustPointBalanceCache).toHaveBeenNthCalledWith(3, creatorUserId, 75_000n)
    expect(adjustPointBalanceCache).toHaveBeenNthCalledWith(4, creatorUserId, 2_500n)
  })
})
