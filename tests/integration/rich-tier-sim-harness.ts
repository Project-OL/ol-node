/**
 * In-memory harness for rich-tier live-badge + rollover simulations.
 * Wired to real `richTierService.applyRecharge` / `processMonthlyRolloverForUser`.
 */

import { vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { thresholdForTier } from '../../src/services/rich-tier.service'

export const REAL_MONTH_MS = 5 * 60 * 1000

export type SimRichTierRow = {
  userId: string
  currentTier: number
  carryoverCoins: bigint
  evaluatedFromYear: number
  evaluatedFromMonth: number
  evaluatedRechargeCoins: bigint
  lastRolledOverAt: Date | null
  updatedAt: Date
}

export type SimHistoryRow = {
  userId: string
  year: number
  month: number
  tier: number
  totalProgressCoins: bigint
  carryoverApplied: bigint
  pureRechargeCoins: bigint
}

function aggKey(userId: string, year: number, month: number) {
  return `${userId}:${year}:${month}`
}

function histKey(userId: string, year: number, month: number) {
  return `${userId}:${year}:${month}`
}

const simInternal = vi.hoisted(() => {
  const state = {
    simNow: new Date(Date.UTC(2025, 0, 1, 12, 0, 0)),
    aggregates: new Map<
      string,
      { totalRechargeCoins: bigint; rechargeCount: number; lastRechargeAt: Date }
    >(),
    richTiers: new Map<string, SimRichTierRow>(),
    historyKeys: new Set<string>(),
    historyRows: [] as SimHistoryRow[],
  }

  function reset() {
    state.simNow = new Date(Date.UTC(2025, 0, 1, 12, 0, 0))
    state.aggregates.clear()
    state.richTiers.clear()
    state.historyKeys.clear()
    state.historyRows.length = 0
  }

  function setSimUtc(year: number, month: number, day = 1) {
    state.simNow = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  }

  function advanceSimDays(days: number) {
    state.simNow = new Date(state.simNow.getTime() + days * 24 * 60 * 60 * 1000)
  }

  /** Move clock to the 1st of the next UTC month; returns the month that was closed. */
  function advanceToNextMonth(): { year: number; month: number } {
    const closed = {
      year: state.simNow.getUTCFullYear(),
      month: state.simNow.getUTCMonth() + 1,
    }
    const y = closed.year
    const m = closed.month
    if (m === 12) setSimUtc(y + 1, 1, 1)
    else setSimUtc(y, m + 1, 1)
    return closed
  }

  function getTier(userId: string): number {
    return state.richTiers.get(userId)?.currentTier ?? 0
  }

  function getCarryover(userId: string): bigint {
    return state.richTiers.get(userId)?.carryoverCoins ?? 0n
  }

  function getMonthRecharge(userId: string, year: number, month: number): bigint {
    return state.aggregates.get(aggKey(userId, year, month))?.totalRechargeCoins ?? 0n
  }

  function createTx(): Prisma.TransactionClient {
    return {
      userRichTier: {
        findUnique: async ({
          where: { userId },
          select,
        }: {
          where: { userId: string }
          select?: { currentTier?: boolean; carryoverCoins?: boolean }
        }) => {
          const row = state.richTiers.get(userId)
          if (!row) return null
          if (!select) return row
          return {
            currentTier: row.currentTier,
            carryoverCoins: row.carryoverCoins,
          }
        },
        upsert: async ({
          where: { userId },
          create,
          update,
        }: {
          where: { userId: string }
          create: Record<string, unknown>
          update: Record<string, unknown>
        }) => {
          const existing = state.richTiers.get(userId)
          const now = new Date()
          if (existing) {
            state.richTiers.set(userId, {
              ...existing,
              ...(update as Partial<SimRichTierRow>),
              updatedAt: now,
            })
            return state.richTiers.get(userId)!
          }
          const row: SimRichTierRow = {
            userId,
            currentTier: Number(create.currentTier ?? 0),
            carryoverCoins: BigInt(String(create.carryoverCoins ?? 0)),
            evaluatedFromYear: Number(create.evaluatedFromYear ?? 0),
            evaluatedFromMonth: Number(create.evaluatedFromMonth ?? 0),
            evaluatedRechargeCoins: 0n,
            lastRolledOverAt: null,
            updatedAt: now,
          }
          state.richTiers.set(userId, row)
          return row
        },
      },
      monthlyRechargeAggregate: {
        findUnique: async ({
          where: { userId_year_month },
        }: {
          where: {
            userId_year_month: { userId: string; year: number; month: number }
          }
        }) => {
          const { userId, year, month } = userId_year_month
          const row = state.aggregates.get(aggKey(userId, year, month))
          if (!row) return null
          return {
            userId,
            year,
            month,
            totalRechargeCoins: row.totalRechargeCoins,
            rechargeCount: row.rechargeCount,
            lastRechargeAt: row.lastRechargeAt,
          }
        },
      },
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
    } as unknown as Prisma.TransactionClient
  }

  return {
    state,
    reset,
    setSimUtc,
    advanceSimDays,
    advanceToNextMonth,
    getTier,
    getCarryover,
    getMonthRecharge,
    createTx,
    aggKey,
    histKey,
  }
})

/** Public simulation API (not hoisted — safe to export). */
export const sim = simInternal

vi.mock('../../src/utils/datetime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/datetime')>()
  return {
    ...actual,
    utcNow: () => simInternal.state.simNow,
  }
})

vi.mock('../../src/config/redis', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/redis')>(
    '../../src/config/redis',
  )
  return {
    ...actual,
    redisClient: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    },
  }
})

vi.mock('../../src/repositories/vip-assignment.repository', () => ({
  vipAssignmentRepository: {
    findMostRecent: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../../src/repositories/richTier.repository', () => ({
  richTierRepository: {
    upsertMonthlyAggregate: async (
      {
        userId,
        year,
        month,
        deltaCoins,
      }: { userId: string; year: number; month: number; deltaCoins: bigint },
      _tx: Prisma.TransactionClient,
    ) => {
      const k = simInternal.aggKey(userId, year, month)
      const prev = simInternal.state.aggregates.get(k)
      const total = (prev?.totalRechargeCoins ?? 0n) + deltaCoins
      simInternal.state.aggregates.set(k, {
        totalRechargeCoins: total,
        rechargeCount: (prev?.rechargeCount ?? 0) + 1,
        lastRechargeAt: new Date(),
      })
    },
    getMonthlyAggregateInTx: async (
      userId: string,
      year: number,
      month: number,
      _tx: Prisma.TransactionClient,
    ) => {
      const row = simInternal.state.aggregates.get(simInternal.aggKey(userId, year, month))
      if (!row) return null
      return {
        totalRechargeCoins: row.totalRechargeCoins,
        rechargeCount: row.rechargeCount,
        lastRechargeAt: row.lastRechargeAt,
      }
    },
    getMonthlyAggregate: async (userId: string, year: number, month: number) => {
      const row = simInternal.state.aggregates.get(simInternal.aggKey(userId, year, month))
      if (!row) return null
      return {
        totalRechargeCoins: row.totalRechargeCoins,
        rechargeCount: row.rechargeCount,
        lastRechargeAt: row.lastRechargeAt,
      }
    },
    getUserRichTier: async (userId: string) => simInternal.state.richTiers.get(userId) ?? null,
    historyExists: async (
      userId: string,
      year: number,
      month: number,
      _tx: Prisma.TransactionClient,
    ) => simInternal.state.historyKeys.has(simInternal.histKey(userId, year, month)),
    upsertUserRichTier: async (
      row: {
        userId: string
        currentTier: number
        evaluatedFromYear: number
        evaluatedFromMonth: number
        evaluatedRechargeCoins: bigint
        carryoverCoins: bigint
        lastRolledOverAt: Date
      },
      _tx: Prisma.TransactionClient,
    ) => {
      const existing = simInternal.state.richTiers.get(row.userId)
      simInternal.state.richTiers.set(row.userId, {
        userId: row.userId,
        currentTier: row.currentTier,
        carryoverCoins: row.carryoverCoins,
        evaluatedFromYear: row.evaluatedFromYear,
        evaluatedFromMonth: row.evaluatedFromMonth,
        evaluatedRechargeCoins: row.evaluatedRechargeCoins,
        lastRolledOverAt: row.lastRolledOverAt,
        updatedAt: new Date(),
      })
      if (!existing) return
    },
    insertHistory: async (
      row: {
        userId: string
        year: number
        month: number
        tier: number
        totalProgressCoins: bigint
        carryoverApplied: bigint
        pureRechargeCoins: bigint
      },
      _tx: Prisma.TransactionClient,
    ) => {
      const k = simInternal.histKey(row.userId, row.year, row.month)
      if (simInternal.state.historyKeys.has(k)) return
      simInternal.state.historyKeys.add(k)
      simInternal.state.historyRows.push({
        userId: row.userId,
        year: row.year,
        month: row.month,
        tier: row.tier,
        totalProgressCoins: row.totalProgressCoins,
        carryoverApplied: row.carryoverApplied,
        pureRechargeCoins: row.pureRechargeCoins,
      })
    },
    getConfig: async () =>
      Array.from({ length: 10 }, (_, i) => ({
        tier: i + 1,
        minRechargeCoins: thresholdForTier(i + 1),
        displayName: `RICH ${i + 1}`,
      })),
    listHistory: async () => [],
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    $transaction: async (fn: (tx: Prisma.TransactionClient) => Promise<void>) => fn(simInternal.createTx()),
  },
  prismaRead: {},
}))

export const simDayDelayMs = (days: number) => Math.round((days / 30) * REAL_MONTH_MS)

export async function simWait(days: number): Promise<void> {
  const live = process.env.RICH_TIER_SIM_LIVE === '1'
  if (!live) return
  await new Promise((r) => setTimeout(r, simDayDelayMs(days)))
}
