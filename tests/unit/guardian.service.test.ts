import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Guardian } from '@prisma/client'

const debitForGuardianPurchase = vi.fn()
vi.mock('../../src/services/coin-wallet.service', () => ({
  coinWalletService: {
    debitForGuardianPurchase: (...a: unknown[]) => debitForGuardianPurchase(...a),
  },
}))

const upsertGuardian = vi.fn()
const findActiveGuardiansForTarget = vi.fn()
const findById = vi.fn()
const markExpired = vi.fn()
const findMyGuardians = vi.fn()
const findGuardiansOfMe = vi.fn()
const findActiveByTargetIds = vi.fn()
vi.mock('../../src/repositories/guardian.repository', () => ({
  guardianRepository: {
    upsertGuardian: (...a: unknown[]) => upsertGuardian(...a),
    findActiveGuardiansForTarget: (...a: unknown[]) =>
      findActiveGuardiansForTarget(...a),
    findById: (...a: unknown[]) => findById(...a),
    markExpired: (...a: unknown[]) => markExpired(...a),
    findMyGuardians: (...a: unknown[]) => findMyGuardians(...a),
    findGuardiansOfMe: (...a: unknown[]) => findGuardiansOfMe(...a),
    findActiveByTargetIds: (...a: unknown[]) => findActiveByTargetIds(...a),
  },
}))

const findByIdUser = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...a: unknown[]) => findByIdUser(...a),
  },
}))

const adjustCoinBalanceCache = vi.fn()
const adjustPointBalanceCache = vi.fn()
vi.mock('../../src/services/wallet.service', () => ({
  walletService: {
    adjustCoinBalanceCache: (...a: unknown[]) => adjustCoinBalanceCache(...a),
    adjustPointBalanceCache: (...a: unknown[]) => adjustPointBalanceCache(...a),
  },
}))

const creditInTransaction = vi.fn()
vi.mock('../../src/services/point-wallet.service', () => ({
  pointWalletService: {
    creditInTransaction: (...a: unknown[]) => creditInTransaction(...a),
  },
}))

const enqueueGuardianExpiry = vi.fn()
vi.mock('../../src/queues/guardian.queue', () => ({
  enqueueGuardianExpiry: (...a: unknown[]) => enqueueGuardianExpiry(...a),
}))

const cacheGet = vi.fn()
const cacheSet = vi.fn()
const cacheDelete = vi.fn()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: (...a: unknown[]) => cacheGet(...a),
    set: (...a: unknown[]) => cacheSet(...a),
    delete: (...a: unknown[]) => cacheDelete(...a),
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    $transaction: async (fn: (tx: Record<string, never>) => Promise<unknown>) =>
      fn({}),
  },
}))

const { guardianService, pickTopGuardian } = await import('../../src/services/guardian.service')

function makeGuardian(partial: Partial<Guardian> & Pick<Guardian, 'id' | 'guardianUserId' | 'targetUserId' | 'tier' | 'expiresAt'>): Guardian {
  const now = new Date()
  return {
    durationMonths: 1,
    coinsPaid: 150000n,
    purchasedAt: now,
    isExpired: false,
    ...partial,
  } as Guardian
}

describe('guardianService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    debitForGuardianPurchase.mockResolvedValue(undefined)
    creditInTransaction.mockResolvedValue({
      ledgerEntryId: 'pt-1',
      balanceAfter: 75000n,
      bustAgentUserId: null,
    })
    findByIdUser.mockResolvedValue({ id: 'target-1', username: 'target' })
    upsertGuardian.mockResolvedValue(
      makeGuardian({
        id: 'g-1',
        guardianUserId: 'guardian-1',
        targetUserId: 'target-1',
        tier: 'SILVER',
        expiresAt: new Date(Date.now() + 86400000),
      }),
    )
    findActiveGuardiansForTarget.mockResolvedValue([])
    enqueueGuardianExpiry.mockResolvedValue(undefined)
    adjustCoinBalanceCache.mockResolvedValue(undefined)
  })

  it('pickTopGuardian ranks KING over SILVER then longer expiresAt', () => {
    const t0 = new Date('2030-01-01')
    const t1 = new Date('2030-06-01')
    const rows = [
      makeGuardian({
        id: 'a',
        guardianUserId: 'u1',
        targetUserId: 't',
        tier: 'SILVER',
        expiresAt: t1,
      }),
      makeGuardian({
        id: 'b',
        guardianUserId: 'u2',
        targetUserId: 't',
        tier: 'KING',
        expiresAt: t0,
      }),
    ]
    expect(pickTopGuardian(rows)?.id).toBe('b')

    const sameTier = [
      makeGuardian({
        id: 'x',
        guardianUserId: 'u1',
        targetUserId: 't',
        tier: 'GOLD',
        expiresAt: t0,
      }),
      makeGuardian({
        id: 'y',
        guardianUserId: 'u2',
        targetUserId: 't',
        tier: 'GOLD',
        expiresAt: t1,
      }),
    ]
    expect(pickTopGuardian(sameTier)?.id).toBe('y')
  })

  it('purchaseGuardian throws CANNOT_GUARDIAN_SELF', async () => {
    await expect(
      guardianService.purchaseGuardian('same', {
        targetUserId: 'same',
        tier: 'SILVER',
        durationMonths: 1,
      }),
    ).rejects.toMatchObject({ code: 'CANNOT_GUARDIAN_SELF', statusCode: 400 })
  })

  it('purchaseGuardian throws USER_NOT_FOUND when target missing', async () => {
    findByIdUser.mockResolvedValueOnce(null)
    await expect(
      guardianService.purchaseGuardian('guardian-1', {
        targetUserId: 'missing',
        tier: 'SILVER',
        durationMonths: 1,
      }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND', statusCode: 404 })
  })

  it('purchaseGuardian debits, upserts, enqueues expiry, busts caches', async () => {
    findActiveGuardiansForTarget.mockResolvedValueOnce([
      makeGuardian({
        id: 'g-1',
        guardianUserId: 'guardian-1',
        targetUserId: 'target-1',
        tier: 'SILVER',
        expiresAt: new Date(),
      }),
    ])

    const result = await guardianService.purchaseGuardian('guardian-1', {
      targetUserId: 'target-1',
      tier: 'SILVER',
      durationMonths: 1,
    })

    expect(debitForGuardianPurchase).toHaveBeenCalled()
    expect(upsertGuardian).toHaveBeenCalled()
    expect(creditInTransaction).toHaveBeenCalled()
    expect(enqueueGuardianExpiry).toHaveBeenCalledWith('g-1', expect.any(Date))
    expect(adjustCoinBalanceCache).toHaveBeenCalledWith('guardian-1', 150000n)
    expect(adjustPointBalanceCache).toHaveBeenCalledWith('target-1', 75000n)
    expect(result.guardianId).toBe('g-1')
    expect(result.coinsPaid).toBe('150000')
    expect(cacheDelete).toHaveBeenCalled()
  })

  it('getGuardianConfig returns expected SILVER 12-month total', () => {
    const cfg = guardianService.getGuardianConfig()
    const silver = cfg.tiers.find((t) => t.tier === 'SILVER')
    const y = silver?.durations.find((d) => d.months === 12)
    expect(y?.totalCoins).toBe(150000 * 12)
  })

  it('processExpiryJob skips when already expired', async () => {
    findById.mockResolvedValueOnce(
      makeGuardian({
        id: 'g-1',
        guardianUserId: 'u1',
        targetUserId: 't1',
        tier: 'SILVER',
        expiresAt: new Date(Date.now() - 1000),
        isExpired: true,
      }),
    )
    await guardianService.processExpiryJob('g-1')
    expect(markExpired).not.toHaveBeenCalled()
  })

  it('processExpiryJob marks expired when past expiresAt', async () => {
    findById.mockResolvedValueOnce(
      makeGuardian({
        id: 'g-1',
        guardianUserId: 'u1',
        targetUserId: 't1',
        tier: 'SILVER',
        expiresAt: new Date(Date.now() - 1000),
        isExpired: false,
      }),
    )
    findActiveGuardiansForTarget.mockResolvedValue([])
    await guardianService.processExpiryJob('g-1')
    expect(markExpired).toHaveBeenCalledWith('g-1')
    expect(cacheDelete).toHaveBeenCalled()
  })
})
