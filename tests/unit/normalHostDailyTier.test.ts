import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Normal Host tier window runs from 00:00 UTC N days back to now (2026-09-29). The start
 * only moves at 00:00 UTC, so during a day the tier can rise but never drop; the tier
 * recorded at 00:00 is a floor. Before, the window ended "now" and slid with it, so a host
 * could claim hour 1 at 7K and see hour 2 drop to 3.5K minutes later.
 */

const NOW = new Date('2026-09-29T11:08:00.000Z')
const DAY = new Date('2026-09-29T00:00:00.000Z')
const USER = 'host-1'

const TIERS = [
  { thresholdPoints: 100000n, hourlyRatePoints: 1000n, hourCapHours: 1, windowDays: 30 },
  { thresholdPoints: 300000n, hourlyRatePoints: 2000n, hourCapHours: 2, windowDays: 7 },
  { thresholdPoints: 500000n, hourlyRatePoints: 3500n, hourCapHours: 2, windowDays: 7 },
  { thresholdPoints: 1000000n, hourlyRatePoints: 7000n, hourCapHours: 2, windowDays: 7 },
]

type Row = {
  userId: string
  rewardDate: Date
  thresholdPoints: bigint | null
  hourlyRatePoints: bigint | null
  hourCapHours: number | null
  windowDays: number | null
  earningsByWindow: Record<string, string>
  source: string
}

const state = vi.hoisted(() => ({
  dailyTiers: new Map<string, unknown>(),
  /** receiving keyed by window days, for windows ending at 00:00 UTC */
  atDayStart: new Map<number, bigint>(),
  /** receiving keyed by window days, for windows ending at "now" */
  live: new Map<number, bigint>(),
  grouped: new Map<number, Map<string, bigint>>(),
  credits: [] as Array<{ userId: string; amount: bigint }>,
  claims: [] as Array<{ hourSlot: number; pointsAmount: bigint }>,
}))

const key = (userId: string, d: Date) => `${userId}|${d.toISOString()}`

vi.mock('../../src/config/database', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ normalHostRewardClaim: { findUnique: async () => null } }),
  },
  prismaRead: {
    user: {
      findUnique: async () => ({ adminTags: [], createdAt: new Date('2026-08-01T00:00:00Z') }),
    },
  },
}))

vi.mock('../../src/repositories/normalHostReward.repository', () => ({
  normalHostRewardRepository: {
    getClaimsForDate: async () => state.claims,
    insertClaim: async () => undefined,
    getDailyTier: async (userId: string, d: Date) => state.dailyTiers.get(key(userId, d)) ?? null,
    insertDailyTiers: async (rows: Row[]) => {
      let n = 0
      for (const r of rows) {
        const k = key(r.userId, r.rewardDate)
        if (state.dailyTiers.has(k)) continue
        state.dailyTiers.set(k, r)
        n++
      }
      return n
    },
    // Strict: only answers windows that START at 00:00 UTC `days` before today, so an
    // un-anchored (sliding) window reads as zero and fails the assertions.
    getQualifyingEarningsForRange: async (_u: string, start: Date, end: Date) => {
      const days = (DAY.getTime() - start.getTime()) / 86_400_000
      if (!Number.isInteger(days)) return 0n
      const src = end.getTime() === DAY.getTime() ? state.atDayStart : state.live
      return src.get(days) ?? 0n
    },
    getQualifyingEarningsByUserForRange: async (start: Date, end: Date) => {
      const days = Math.round((end.getTime() - start.getTime()) / 86_400_000)
      return state.grouped.get(days) ?? new Map()
    },
  },
}))

vi.mock('../../src/services/normalHostRewardConfig.service', () => ({
  normalHostRewardConfigService: { getConfig: async () => ({ tiersBigInt: TIERS }) },
}))
vi.mock('../../src/services/livestreamRewardConfig.service', () => ({
  livestreamRewardConfigService: { getConfig: async () => ({ windowDays: 7 }) },
}))
vi.mock('../../src/services/livestream-reward.service', () => ({
  dayIndexSinceJoin: () => 60,
  effectiveSecondsForSession: async () => 2 * 3600,
}))
vi.mock('../../src/repositories/liveStream.repository', () => ({
  liveStreamRepository: { getSessionsForUserOnDate: async () => [{}] },
}))
vi.mock('../../src/services/point-wallet.service', () => ({
  pointWalletService: {
    creditInTransaction: async (userId: string, amount: bigint) => {
      state.credits.push({ userId, amount })
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
  state.dailyTiers.clear()
  state.atDayStart.clear()
  state.live.clear()
  state.grouped.clear()
  state.credits.length = 0
  state.claims.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Normal Host tier: window from 00:00 UTC N days back to now', () => {
  it('rises during the day as receiving arrives (floor 300K at 00:00 → 1M now)', async () => {
    state.atDayStart.set(7, 324_000n) // 300K at 00:00
    state.live.set(7, 1_102_800n) // Sep 22 00:00 → now, incl. today's gifts

    const s = await normalHostRewardService.getStatus(USER)

    if (!s.eligible || !s.hasTier) throw new Error('expected a tier')
    expect(s.currentTier.thresholdPoints).toBe('1000000')
    expect(s.slots.map((x) => x.pointsAmount)).toEqual(['7000', '7000'])
    expect(s.tierEvaluatedAt).toBe(DAY.toISOString())
    expect(s.nextEvaluationAt).toBe('2026-09-30T00:00:00.000Z')
    expect(s.nextTier).toBeNull() // 1M is the top of this test ladder
    // the 00:00 floor is still recorded for the day
    const row = state.dailyTiers.get(key(USER, DAY)) as Row
    expect(row.thresholdPoints).toBe(300000n)
    expect(row.source).toBe('lazy')
  })

  it('never drops below the 00:00 floor during the day', async () => {
    state.atDayStart.set(7, 1_102_800n)
    await normalHostRewardService.getStatus(USER) // records the 1M floor for today

    state.atDayStart.set(7, 0n) // e.g. an admin ladder edit / data change mid-day
    state.live.set(7, 0n)
    const s = await normalHostRewardService.getStatus(USER)

    if (!s.eligible || !s.hasTier) throw new Error('expected a tier')
    expect(s.currentTier.hourlyRatePoints).toBe('7000')
    expect(s.slots.map((x) => x.pointsAmount)).toEqual(['7000', '7000'])
  })

  it('pays a claim at the tier reached so far today', async () => {
    state.atDayStart.set(7, 324_000n)
    state.live.set(7, 1_102_800n)

    const res = await normalHostRewardService.claimReward(USER, 2)

    expect(res.pointsAmount).toBe('7000')
    expect(state.credits).toEqual([{ userId: USER, amount: 7000n }])
  })

  it('names the remaining receiving when no tier is reached yet', async () => {
    state.atDayStart.set(30, 50_000n)
    state.live.set(30, 60_000n)

    await expect(normalHostRewardService.claimReward(USER, 1)).rejects.toMatchObject({
      message: 'Unlock the 100K receiving target first — receive 40K more within the last 30 days',
      details: { remainingPoints: '40000', earnedPoints: '60000' },
    })
  })

  it('a target reached mid-day applies immediately', async () => {
    state.atDayStart.set(30, 50_000n) // no tier at 00:00
    state.live.set(30, 120_000n) // 100K reached today

    const res = await normalHostRewardService.claimReward(USER, 1)

    expect(res.pointsAmount).toBe('1000')
  })

  it("shows claims made above today's cap (pre-lock claims) instead of hiding them", async () => {
    state.atDayStart.set(30, 150_000n) // 100K tier: 1 slot
    state.claims.push({ hourSlot: 1, pointsAmount: 7000n }, { hourSlot: 2, pointsAmount: 7000n })

    const s = await normalHostRewardService.getStatus(USER)

    if (!s.eligible || !s.hasTier) throw new Error('expected a tier')
    expect(s.slots.map((x) => [x.hourSlot, x.claimed, x.pointsAmount])).toEqual([
      [1, true, '7000'],
      [2, true, '7000'],
    ])
  })

  it('recomputes every user with receiving and never overwrites an existing day', async () => {
    state.grouped.set(
      7,
      new Map([
        ['a', 1_100_000n],
        ['b', 320_000n],
      ]),
    )
    state.grouped.set(
      30,
      new Map([
        ['a', 1_300_000n],
        ['b', 400_000n],
        ['c', 40_000n],
      ]),
    )
    state.dailyTiers.set(key('b', DAY), {
      userId: 'b',
      rewardDate: DAY,
      thresholdPoints: 500000n,
      hourlyRatePoints: 3500n,
      hourCapHours: 2,
      windowDays: 7,
      earningsByWindow: {},
      source: 'lazy',
    })

    const out = await normalHostRewardService.recomputeDailyTiers(new Date('2026-09-29T00:00:05Z'))

    expect(out).toEqual({ rewardDate: '2026-09-29', candidates: 3, withTier: 2, inserted: 2 })
    expect((state.dailyTiers.get(key('a', DAY)) as Row).thresholdPoints).toBe(1000000n)
    expect((state.dailyTiers.get(key('a', DAY)) as Row).earningsByWindow).toEqual({
      '30': '1300000',
      '7': '1100000',
    })
    expect((state.dailyTiers.get(key('b', DAY)) as Row).thresholdPoints).toBe(500000n) // kept
    expect((state.dailyTiers.get(key('c', DAY)) as Row).thresholdPoints).toBeNull()
  })
})
