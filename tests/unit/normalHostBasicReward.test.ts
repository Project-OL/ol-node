import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Normal Host basic daily reward (2026-10-31): a flat admin-set amount for streaming the
 * admin-set minutes on a day the host has no Normal Host tier. Once per UTC day; reaching a
 * tier later the same day still opens the tier slots and keeps the basic claim.
 */

const NOW = new Date('2026-10-31T11:00:00.000Z')
const DAY = new Date('2026-10-31T00:00:00.000Z')
const USER = 'host-1'

const TIERS = [
  { thresholdPoints: 100000n, hourlyRatePoints: 1000n, hourCapHours: 1, windowDays: 30 },
  { thresholdPoints: 300000n, hourlyRatePoints: 2000n, hourCapHours: 2, windowDays: 7 },
]

const state = vi.hoisted(() => ({
  adminTags: [] as string[],
  basicConfig: {
    enabled: true,
    requiredMinutes: 60,
    pointsAmount: '800',
    updatedAt: '2026-10-31T00:00:00.000Z',
    pointsAmountBigInt: 800n,
  },
  streamedSeconds: 2 * 3600,
  /** receiving keyed by window days, every window */
  earnings: new Map<number, bigint>(),
  dailyTiers: new Map<string, unknown>(),
  basicClaim: null as null | { pointsAmount: bigint; claimedAt: Date },
  /** what the in-transaction duplicate check sees */
  existingInTx: null as unknown,
  insertError: null as unknown,
  credits: [] as Array<{ userId: string; amount: bigint; txType: string; key: string }>,
  basicInserts: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        normalHostRewardClaim: { findUnique: async () => null },
        normalHostBasicRewardClaim: { findUnique: async () => state.existingInTx },
      }),
  },
  prismaRead: {
    user: {
      findUnique: async () => ({
        adminTags: state.adminTags,
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
    },
  },
}))

vi.mock('../../src/repositories/normalHostReward.repository', () => ({
  normalHostRewardRepository: {
    getClaimsForDate: async () => [],
    insertClaim: async () => undefined,
    getBasicClaimForDate: async () => state.basicClaim,
    insertBasicClaim: async (data: Record<string, unknown>) => {
      if (state.insertError) throw state.insertError
      state.basicInserts.push(data)
      return { ...data, claimedAt: NOW }
    },
    getDailyTier: async (userId: string) => state.dailyTiers.get(userId) ?? null,
    insertDailyTiers: async (rows: Array<{ userId: string }>) => {
      for (const r of rows) if (!state.dailyTiers.has(r.userId)) state.dailyTiers.set(r.userId, r)
      return rows.length
    },
    getQualifyingEarningsForRange: async (_u: string, start: Date) => {
      const days = Math.round((DAY.getTime() - start.getTime()) / 86_400_000)
      return state.earnings.get(days) ?? 0n
    },
    getQualifyingEarningsByUserForRange: async () => new Map(),
  },
}))

vi.mock('../../src/services/normalHostRewardConfig.service', () => ({
  normalHostRewardConfigService: { getConfig: async () => ({ tiersBigInt: TIERS }) },
}))
vi.mock('../../src/services/normalHostBasicRewardConfig.service', () => ({
  normalHostBasicRewardConfigService: { getConfig: async () => state.basicConfig },
}))
vi.mock('../../src/services/livestreamRewardConfig.service', () => ({
  livestreamRewardConfigService: { getConfig: async () => ({ windowDays: 7 }) },
}))
vi.mock('../../src/services/livestream-reward.service', () => ({
  dayIndexSinceJoin: () => 60,
  effectiveSecondsForSession: async () => state.streamedSeconds,
}))
vi.mock('../../src/repositories/liveStream.repository', () => ({
  liveStreamRepository: { getSessionsForUserOnDate: async () => [{}] },
}))
vi.mock('../../src/services/point-wallet.service', () => ({
  pointWalletService: {
    creditInTransaction: async (
      userId: string,
      amount: bigint,
      txType: string,
      _tx: unknown,
      opts: { idempotencyKey: string },
    ) => {
      state.credits.push({ userId, amount, txType, key: opts.idempotencyKey })
      return { ledgerEntryId: 'ledger-1' }
    },
  },
}))
vi.mock('../../src/services/wallet.service', () => ({
  walletService: { adjustPointBalanceCache: async () => undefined },
}))

import { normalHostRewardService } from '../../src/services/normal-host-reward.service'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  state.adminTags = []
  state.basicConfig = { ...state.basicConfig, enabled: true, requiredMinutes: 60 }
  state.streamedSeconds = 2 * 3600
  state.earnings.clear()
  state.dailyTiers.clear()
  state.basicClaim = null
  state.existingInTx = null
  state.insertError = null
  state.credits.length = 0
  state.basicInserts.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Normal Host basic reward: status', () => {
  it('is null while switched off', async () => {
    state.basicConfig = { ...state.basicConfig, enabled: false }

    const s = await normalHostRewardService.getStatus(USER)

    if (!s.eligible) throw new Error('expected eligible')
    expect(s.basicReward).toBeNull()
  })

  it('unlocks for a host with no tier once the minutes are streamed', async () => {
    const s = await normalHostRewardService.getStatus(USER)

    if (!s.eligible || s.hasTier) throw new Error('expected no tier')
    expect(s.basicReward).toEqual({
      requiredMinutes: 60,
      completedMinutes: 60,
      pointsAmount: '800',
      available: true,
      unlocked: true,
      claimed: false,
      claimedAt: null,
    })
  })

  it('shows progress before the minutes are reached', async () => {
    state.streamedSeconds = 35 * 60

    const s = await normalHostRewardService.getStatus(USER)

    if (!s.eligible) throw new Error('expected eligible')
    expect(s.basicReward).toMatchObject({ completedMinutes: 35, unlocked: false })
  })

  it('is unavailable when the host has a tier', async () => {
    state.earnings.set(30, 150_000n)

    const s = await normalHostRewardService.getStatus(USER)

    if (!s.eligible || !s.hasTier) throw new Error('expected a tier')
    expect(s.basicReward).toMatchObject({ available: false, unlocked: false, claimed: false })
  })

  it('keeps showing a claim made before a tier was reached', async () => {
    state.basicClaim = { pointsAmount: 800n, claimedAt: NOW }
    state.earnings.set(30, 150_000n)

    const s = await normalHostRewardService.getStatus(USER)

    if (!s.eligible || !s.hasTier) throw new Error('expected a tier')
    expect(s.basicReward).toMatchObject({
      available: false,
      claimed: true,
      pointsAmount: '800',
      claimedAt: NOW.toISOString(),
    })
  })
})

describe('Normal Host basic reward: claim', () => {
  it('credits the admin amount once, under its own tx type and day key', async () => {
    const res = await normalHostRewardService.claimBasicReward(USER)

    expect(res).toEqual({ pointsAmount: '800', claimedAt: NOW.toISOString() })
    expect(state.credits).toEqual([
      {
        userId: USER,
        amount: 800n,
        txType: 'NORMAL_HOST_BASIC_REWARD',
        key: `normal-host-basic-reward:${USER}:2026-10-31`,
      },
    ])
    expect(state.basicInserts[0]).toMatchObject({
      rewardDate: DAY,
      pointsAmount: 800n,
      requiredMinutes: 60,
      streamedSeconds: 7200,
      ledgerEntryId: 'ledger-1',
    })
  })

  it('rejects a Royal Host', async () => {
    state.adminTags = ['royal host']

    await expect(normalHostRewardService.claimBasicReward(USER)).rejects.toMatchObject({
      code: 'NORMAL_HOST_NOT_ELIGIBLE',
    })
  })

  it('rejects while switched off', async () => {
    state.basicConfig = { ...state.basicConfig, enabled: false }

    await expect(normalHostRewardService.claimBasicReward(USER)).rejects.toMatchObject({
      statusCode: 403,
      code: 'NORMAL_HOST_BASIC_DISABLED',
    })
  })

  it('rejects a host who has a tier today', async () => {
    state.earnings.set(30, 150_000n)

    await expect(normalHostRewardService.claimBasicReward(USER)).rejects.toMatchObject({
      code: 'NORMAL_HOST_BASIC_HAS_TIER',
    })
    expect(state.credits).toHaveLength(0)
  })

  it('names the missing live time', async () => {
    state.basicConfig = { ...state.basicConfig, requiredMinutes: 180 }

    await expect(normalHostRewardService.claimBasicReward(USER)).rejects.toMatchObject({
      code: 'NORMAL_HOST_BASIC_HOURS_NOT_MET',
      message: 'Go live for 3 hours today to claim this reward',
      details: { requiredMinutes: 180, completedMinutes: 120 },
    })
  })

  it('409s when already claimed today', async () => {
    state.existingInTx = { userId: USER }

    await expect(normalHostRewardService.claimBasicReward(USER)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ALREADY_CLAIMED',
    })
    expect(state.credits).toHaveLength(0)
  })

  it('409s when a parallel claim wins the insert', async () => {
    state.insertError = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    })

    await expect(normalHostRewardService.claimBasicReward(USER)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ALREADY_CLAIMED',
    })
  })

  it('leaves the tier slots open after a basic claim', async () => {
    await normalHostRewardService.claimBasicReward(USER)
    state.earnings.set(30, 150_000n) // 100K reached later the same day

    const res = await normalHostRewardService.claimReward(USER, 1)

    expect(res.pointsAmount).toBe('1000')
    expect(state.credits.map((c) => c.txType)).toEqual([
      'NORMAL_HOST_BASIC_REWARD',
      'NORMAL_HOST_REWARD',
    ])
  })
})
