import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Agency tier window runs from 00:00 UTC `duration` back to now (2026-09-29). The start only
 * moves at 00:00 UTC, so during a day the level (and commission rate) can rise but never
 * drop; it can only fall at the day's first evaluation. Before, every credit re-evaluated
 * it over a window ending "now" that slid with it, so the rate moved up and down all day.
 */

const NOW = new Date('2026-09-29T11:08:00.000Z')
const DAY = new Date('2026-09-29T00:00:00.000Z')
const AGENCY = 'agency-1'

type Row = {
  currentLevel: string
  lastLevelRecomputedAt: Date | null
  tierLockLevel: string | null
  tierLockUntil: Date | null
  tierLockBonusPoints: bigint | null
}

const db = vi.hoisted(() => ({
  row: null as null | Row,
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
import { resolveAgencyCommissionRollingWindowBounds } from '../../src/utils/datetime'
import { higherLevel } from '../../src/utils/agency-tier-lock'

const LEVELS = [
  { level: 'D', minWindowPoints: 0n, liveRateBp: 400, matchChatRateBp: 400 },
  { level: 'C', minWindowPoints: 1_000_000n, liveRateBp: 600, matchChatRateBp: 600 },
  { level: 'B', minWindowPoints: 5_000_000n, liveRateBp: 800, matchChatRateBp: 800 },
]

/** Window to 00:00 UTC → `atDayStart`; window to now → `soFar`. */
function stubWindowTotals(atDayStart: bigint, soFar: bigint) {
  return vi
    .spyOn(agencyCommissionService, 'resolveTierWindowTotal')
    .mockImplementation(async (_id, opts) => {
      const isDayStart = opts?.now?.getTime() === DAY.getTime()
      return { total: isDayStart ? atDayStart : soFar } as never
    })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  db.row = {
    currentLevel: 'D',
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

describe('agency tier window', () => {
  it('starts at 00:00 UTC `duration` back and ends now', () => {
    const w = resolveAgencyCommissionRollingWindowBounds({ days: 7, hours: 0, minutes: 0 }, NOW)
    expect(w.from.toISOString()).toBe('2026-09-22T00:00:00.000Z')
    expect(w.toExclusive).toEqual(NOW)
    const atMidnight = resolveAgencyCommissionRollingWindowBounds(
      { days: 7, hours: 0, minutes: 0 },
      DAY,
    )
    expect(atMidnight.from.toISOString()).toBe('2026-09-22T00:00:00.000Z')
    expect(atMidnight.toExclusive).toEqual(DAY)
    // A duration with an hours part (QA window) stays an exact timestamp window.
    const qa = resolveAgencyCommissionRollingWindowBounds({ days: 0, hours: 2, minutes: 0 }, NOW)
    expect(qa.from.toISOString()).toBe('2026-09-29T09:08:00.000Z')
  })

  it('higherLevel ranks by minWindowPoints, unknown levels lowest', () => {
    expect(higherLevel('C', 'B', LEVELS)).toBe('B')
    expect(higherLevel('B', 'C', LEVELS)).toBe('B')
    expect(higherLevel('X', 'D', LEVELS)).toBe('D')
  })
})

describe('agency level: rises during the day, drops only at 00:00 UTC', () => {
  it('daily evaluation takes the higher of the 00:00 level and the level so far', async () => {
    const spy = stubWindowTotals(1_200_000n, 6_000_000n) // C at 00:00, B so far

    await agencyCommissionService.recomputeAgencyLevel(AGENCY, { skipDailyDedupe: true })

    expect(spy.mock.calls.map((c) => c[1]?.now?.toISOString())).toEqual(
      expect.arrayContaining([DAY.toISOString(), NOW.toISOString()]),
    )
    expect(db.updateMany.mock.calls[0]![0].data).toMatchObject({
      currentLevel: 'B',
      currentWindowTotalPoints: 6_000_000n,
      lastLevelRecomputedAt: NOW,
    })
  })

  it('daily evaluation at 00:00 can lower the level (oldest day left the window)', async () => {
    vi.setSystemTime(DAY)
    db.row!.currentLevel = 'B'
    stubWindowTotals(1_200_000n, 1_200_000n)

    await agencyCommissionService.recomputeAgencyLevel(AGENCY, { skipDailyDedupe: true })

    expect(db.updateMany.mock.calls[0]![0].data.currentLevel).toBe('C')
  })

  it('a credit that reaches a higher tier raises the level immediately', async () => {
    db.row!.currentLevel = 'C'
    db.row!.lastLevelRecomputedAt = new Date('2026-09-29T00:00:03.000Z')
    stubWindowTotals(1_200_000n, 6_000_000n)

    await agencyCommissionService.afterCommissionCreditCommit(AGENCY)

    expect(db.updateMany).toHaveBeenCalledWith({
      where: { userId: AGENCY, currentLevel: 'C' },
      data: { currentLevel: 'B', currentWindowTotalPoints: 6_000_000n },
    })
    expect(db.update).not.toHaveBeenCalled()
    expect(agencyCommissionService.bustAgentCommissionCaches).toHaveBeenCalledWith(AGENCY)
  })

  it('a credit never lowers the level mid-day, only refreshes progress', async () => {
    db.row!.currentLevel = 'B' // e.g. reached earlier today
    db.row!.lastLevelRecomputedAt = new Date('2026-09-29T00:00:03.000Z')
    stubWindowTotals(1_200_000n, 1_300_000n) // would match C

    await agencyCommissionService.afterCommissionCreditCommit(AGENCY)

    expect(db.updateMany).not.toHaveBeenCalled()
    expect(db.update).toHaveBeenCalledWith({
      where: { userId: AGENCY },
      data: { currentWindowTotalPoints: 1_300_000n },
    })
  })

  it('the first credit of a day without an evaluation runs the daily evaluation', async () => {
    db.row!.lastLevelRecomputedAt = new Date('2026-09-28T00:00:03.000Z')
    stubWindowTotals(1_200_000n, 1_200_000n)

    await agencyCommissionService.afterCommissionCreditCommit(AGENCY)

    expect(db.update).not.toHaveBeenCalled()
    expect(db.updateMany.mock.calls[0]![0].data).toMatchObject({
      currentLevel: 'C',
      lastLevelRecomputedAt: NOW,
    })
  })

  it('an admin lock active at 00:00 floors the day even if it expires mid-day', async () => {
    db.row = {
      currentLevel: 'B',
      lastLevelRecomputedAt: new Date('2026-09-28T00:00:03.000Z'),
      tierLockLevel: 'B',
      tierLockUntil: new Date('2026-09-29T10:00:00.000Z'), // expired before NOW
      tierLockBonusPoints: 0n,
    }
    stubWindowTotals(1_200_000n, 1_200_000n)

    await agencyCommissionService.recomputeAgencyLevel(AGENCY, { skipDailyDedupe: true })

    const data = db.updateMany.mock.calls[0]![0].data
    expect(data.currentLevel).toBe('B')
    expect(data.tierLockLevel).toBeUndefined() // not cleared today
  })

  it('skips re-evaluation on the same UTC day unless forced', async () => {
    db.row!.lastLevelRecomputedAt = new Date('2026-09-29T00:00:03.000Z')
    const spy = stubWindowTotals(1_200_000n, 6_000_000n)

    await agencyCommissionService.recomputeAgencyLevel(AGENCY)

    expect(spy).not.toHaveBeenCalled()
    expect(db.updateMany).not.toHaveBeenCalled()
  })
})
