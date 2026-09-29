import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Agency level (and so commission rate) is evaluated once per UTC day from the rolling
 * window ending at 00:00 UTC and held for the day (2026-09-29). Before, every commission
 * credit re-evaluated it over a window ending "now", so the rate could move up or down
 * several times a day.
 */

const NOW = new Date('2026-09-29T11:08:00.000Z')
const DAY = new Date('2026-09-29T00:00:00.000Z')
const AGENCY = 'agency-1'

const db = vi.hoisted(() => ({
  row: null as null | {
    lastLevelRecomputedAt: Date | null
    tierLockLevel: string | null
    tierLockUntil: Date | null
    tierLockBonusPoints: bigint | null
  },
  updateMany: vi.fn(),
  update: vi.fn(),
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    agency: {
      findUnique: async () => db.row,
      updateMany: db.updateMany,
      update: db.update,
    },
  },
  prismaRead: {},
}))

import { agencyCommissionService } from '../../src/services/agencyCommission.service'
import { agencyCommissionRepository } from '../../src/repositories/agencyCommission.repository'

const LEVELS = [
  { level: 'D', minWindowPoints: 0n, liveRateBp: 400, matchChatRateBp: 400 },
  { level: 'C', minWindowPoints: 1_000_000n, liveRateBp: 600, matchChatRateBp: 600 },
  { level: 'B', minWindowPoints: 5_000_000n, liveRateBp: 800, matchChatRateBp: 800 },
]

/** Window ending at 00:00 UTC → 1.2M (level C); window ending now → 6M (would be B). */
function stubWindowTotals() {
  return vi
    .spyOn(agencyCommissionService, 'resolveTierWindowTotal')
    .mockImplementation(async (_id, opts) => {
      const atDayStart = opts?.now?.getTime() === DAY.getTime()
      return { total: atDayStart ? 1_200_000n : 6_000_000n } as never
    })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  db.row = {
    lastLevelRecomputedAt: null,
    tierLockLevel: null,
    tierLockUntil: null,
    tierLockBonusPoints: null,
  }
  db.updateMany.mockReset().mockResolvedValue({ count: 1 })
  db.update.mockReset().mockResolvedValue({})
  vi.spyOn(agencyCommissionRepository, 'getLevelConfig').mockResolvedValue(LEVELS as never)
  vi.spyOn(agencyCommissionService, 'bustAgentCommissionCaches').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('agency level daily evaluation (00:00 UTC)', () => {
  it('matches the level on the window ending at 00:00 UTC and stores the live total as progress', async () => {
    const spy = stubWindowTotals()

    await agencyCommissionService.recomputeAgencyLevel(AGENCY, { skipDailyDedupe: true })

    expect(spy.mock.calls.map((c) => c[1]?.now?.toISOString())).toEqual(
      expect.arrayContaining([DAY.toISOString(), NOW.toISOString()]),
    )
    expect(db.updateMany).toHaveBeenCalledTimes(1)
    expect(db.updateMany.mock.calls[0]![0].data).toMatchObject({
      currentLevel: 'C',
      currentWindowTotalPoints: 6_000_000n,
      lastLevelRecomputedAt: NOW,
    })
  })

  it('a commission credit after today’s evaluation only refreshes progress, never the level', async () => {
    stubWindowTotals()
    db.row!.lastLevelRecomputedAt = new Date('2026-09-29T00:00:03.000Z')

    await agencyCommissionService.afterCommissionCreditCommit(AGENCY)

    expect(db.updateMany).not.toHaveBeenCalled()
    expect(db.update).toHaveBeenCalledWith({
      where: { userId: AGENCY },
      data: { currentWindowTotalPoints: 6_000_000n },
    })
    expect(agencyCommissionService.bustAgentCommissionCaches).toHaveBeenCalledWith(AGENCY)
  })

  it('the first credit of a day without an evaluation runs the daily evaluation (catch-up)', async () => {
    stubWindowTotals()
    db.row!.lastLevelRecomputedAt = new Date('2026-09-28T00:00:03.000Z')

    await agencyCommissionService.afterCommissionCreditCommit(AGENCY)

    expect(db.update).not.toHaveBeenCalled()
    expect(db.updateMany).toHaveBeenCalledTimes(1)
    expect(db.updateMany.mock.calls[0]![0].data.currentLevel).toBe('C')
  })

  it('an admin lock active at 00:00 holds for the whole day even if it expires mid-day', async () => {
    stubWindowTotals()
    db.row = {
      lastLevelRecomputedAt: new Date('2026-09-28T00:00:03.000Z'),
      tierLockLevel: 'B',
      tierLockUntil: new Date('2026-09-29T10:00:00.000Z'), // expired before NOW
      tierLockBonusPoints: 0n,
    }

    await agencyCommissionService.recomputeAgencyLevel(AGENCY, { skipDailyDedupe: true })

    const data = db.updateMany.mock.calls[0]![0].data
    expect(data.currentLevel).toBe('B') // floor applied: lock was active at 00:00
    expect(data.tierLockLevel).toBeUndefined() // not cleared today
  })

  it('skips re-evaluation on the same UTC day unless forced', async () => {
    const spy = stubWindowTotals()
    db.row!.lastLevelRecomputedAt = new Date('2026-09-29T00:00:03.000Z')

    await agencyCommissionService.recomputeAgencyLevel(AGENCY)

    expect(spy).not.toHaveBeenCalled()
    expect(db.updateMany).not.toHaveBeenCalled()
  })
})
