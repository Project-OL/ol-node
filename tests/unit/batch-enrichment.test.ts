import { describe, it, expect, vi, beforeEach } from 'vitest'

/** In-memory Redis pipeline stub shared by both services under test. */
const redisStore = new Map<string, string>()
const pipelineOps: Array<{ cmd: string; key: string; value?: string }> = []

function makePipeline() {
  const gets: string[] = []
  const sets: Array<{ key: string; value: string }> = []
  return {
    get(key: string) {
      gets.push(key)
      pipelineOps.push({ cmd: 'get', key })
      return this
    },
    set(key: string, value: string) {
      sets.push({ key, value })
      pipelineOps.push({ cmd: 'set', key, value })
      return this
    },
    async exec() {
      if (gets.length > 0) {
        return gets.map((k) => [null, redisStore.get(k) ?? null])
      }
      for (const s of sets) redisStore.set(s.key, s.value)
      return sets.map(() => [null, 'OK'])
    },
  }
}

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    pipeline: () => makePipeline(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  },
  getRedisForRead: () => ({
    get: vi.fn().mockResolvedValue(null),
    mget: vi.fn().mockResolvedValue([null, null]),
  }),
  RedisKeys: {
    superHostStatus: (id: string) => `superhost:status:${id}`,
    guardianActive: (id: string) => `guardian:active:${id}`,
  },
  SUPER_HOST_STATUS_TTL: 300,
  GUARDIAN_ACTIVE_TTL: 300,
  GUARDIAN_LIST_TTL: 120,
}))

const isActiveBulk = vi.fn()
vi.mock('../../src/repositories/super-host.repository', () => ({
  superHostRepository: {
    isActiveBulk: (...a: unknown[]) => isActiveBulk(...a),
    isActive: vi.fn(),
  },
}))

const findActiveByTargetIds = vi.fn()
vi.mock('../../src/repositories/guardian.repository', () => ({
  guardianRepository: {
    findActiveByTargetIds: (...a: unknown[]) => findActiveByTargetIds(...a),
  },
}))

const findDisplayRowsByIds = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findDisplayRowsByIds: (...a: unknown[]) => findDisplayRowsByIds(...a),
    findById: vi.fn(),
  },
}))

vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}))

// guardian.service pulls in wallet/queue modules; stub the heavy ones.
vi.mock('../../src/config/database', () => ({ prisma: {}, prismaRead: {} }))
vi.mock('../../src/services/coin-wallet.service', () => ({ coinWalletService: {} }))
vi.mock('../../src/services/point-wallet.service', () => ({ pointWalletService: {} }))
vi.mock('../../src/services/wallet.service', () => ({ walletService: {} }))
vi.mock('../../src/queues/guardian.queue', () => ({ enqueueGuardianExpiry: vi.fn() }))
vi.mock('../../src/services/user-level.service', () => ({
  walletLevelService: {},
  syncLevelCacheFromApplyResult: vi.fn(),
}))

const { superHostService } = await import('../../src/services/super-host.service')
const { guardianService } = await import('../../src/services/guardian.service')

describe('superHostService.isSuperHostBulk', () => {
  beforeEach(() => {
    redisStore.clear()
    pipelineOps.length = 0
    isActiveBulk.mockReset()
  })

  it('resolves cached flags without hitting the repository', async () => {
    redisStore.set('superhost:status:u1', '1')
    redisStore.set('superhost:status:u2', '0')
    const map = await superHostService.isSuperHostBulk(['u1', 'u2'])
    expect(map.get('u1')).toBe(true)
    expect(map.get('u2')).toBe(false)
    expect(isActiveBulk).not.toHaveBeenCalled()
  })

  it('fetches misses in one repository call and repopulates the cache', async () => {
    redisStore.set('superhost:status:u1', '1')
    isActiveBulk.mockResolvedValue(new Set(['u3']))
    const map = await superHostService.isSuperHostBulk(['u1', 'u2', 'u3', 'u2'])
    expect(isActiveBulk).toHaveBeenCalledTimes(1)
    expect(isActiveBulk).toHaveBeenCalledWith(['u2', 'u3'])
    expect(map.get('u1')).toBe(true)
    expect(map.get('u2')).toBe(false)
    expect(map.get('u3')).toBe(true)
    expect(redisStore.get('superhost:status:u2')).toBe('0')
    expect(redisStore.get('superhost:status:u3')).toBe('1')
  })

  it('returns empty map for empty input', async () => {
    const map = await superHostService.isSuperHostBulk([])
    expect(map.size).toBe(0)
    expect(isActiveBulk).not.toHaveBeenCalled()
  })
})

describe('guardianService.getActiveGuardianSummariesBulk', () => {
  const now = Date.now()
  const guardianRow = {
    id: 'g1',
    guardianUserId: 'guardian-user',
    targetUserId: 'u2',
    tier: 'GOLD',
    durationMonths: 1,
    purchasedAt: new Date(now - 1000),
    expiresAt: new Date(now + 86_400_000),
    isExpired: false,
  }
  const guardianUserRow = {
    id: 'guardian-user',
    username: 'guardy',
    firstName: 'Guard',
    lastName: 'Ian',
    publicId: BigInt(555),
    defaultPublicId: BigInt(555),
    currentVipPublicId: null,
    avatarUrl: null,
  }

  beforeEach(() => {
    redisStore.clear()
    pipelineOps.length = 0
    findActiveByTargetIds.mockReset()
    findDisplayRowsByIds.mockReset()
  })

  it('honors cached summaries and the null sentinel without DB calls', async () => {
    redisStore.set('guardian:active:u1', 'null')
    const map = await guardianService.getActiveGuardianSummariesBulk(['u1'])
    expect(map.get('u1')).toBeNull()
    expect(findActiveByTargetIds).not.toHaveBeenCalled()
  })

  it('batch-loads misses: one guardians query, one users query, caches results', async () => {
    redisStore.set('guardian:active:u1', 'null')
    findActiveByTargetIds.mockResolvedValue([guardianRow])
    findDisplayRowsByIds.mockResolvedValue([guardianUserRow])

    const map = await guardianService.getActiveGuardianSummariesBulk(['u1', 'u2', 'u3'])

    expect(findActiveByTargetIds).toHaveBeenCalledTimes(1)
    expect(findActiveByTargetIds).toHaveBeenCalledWith(['u2', 'u3'])
    expect(findDisplayRowsByIds).toHaveBeenCalledTimes(1)
    expect(findDisplayRowsByIds).toHaveBeenCalledWith(['guardian-user'])

    expect(map.get('u1')).toBeNull()
    expect(map.get('u3')).toBeNull()
    const summary = map.get('u2')
    expect(summary).toMatchObject({
      guardianId: 'g1',
      guardianUserId: 'guardian-user',
      guardianPublicId: '555',
      displayPublicId: '555',
      displayName: 'Guard Ian',
      tier: 'GOLD',
    })
    expect(summary?.user).toMatchObject({ userId: 'guardian-user', name: 'Guard Ian' })

    // cache repopulated with same format as the single-target path
    expect(redisStore.get('guardian:active:u3')).toBe('null')
    const cachedU2 = JSON.parse(redisStore.get('guardian:active:u2')!)
    expect(cachedU2.guardianId).toBe('g1')
    expect(typeof cachedU2.purchasedAt).toBe('string')
    expect(typeof cachedU2.expiresAt).toBe('string')
  })

  it('picks the top guardian per target by tier then expiry', async () => {
    const silver = {
      ...guardianRow,
      id: 'g-silver',
      tier: 'SILVER',
      guardianUserId: 'guardian-user',
    }
    const gold = { ...guardianRow, id: 'g-gold', tier: 'GOLD', guardianUserId: 'guardian-user' }
    findActiveByTargetIds.mockResolvedValue([silver, gold])
    findDisplayRowsByIds.mockResolvedValue([guardianUserRow])

    const map = await guardianService.getActiveGuardianSummariesBulk(['u2'])
    expect(map.get('u2')?.guardianId).toBe('g-gold')
  })
})
