/**
 * B5 — Documents the Live-server payload mapping when the ledger runs water_v1
 * (serviceLuckyGift.js Phase 4). ol-node cannot exercise full socket payloads; this
 * unit file locks the selection contract used by Live and emitDedupe tests.
 */
import { describe, expect, it } from 'vitest'

type LocalDraw = {
  totalReward: bigint
  category: string
  breakdownArray: number[] | undefined
}

type LedgerResult = {
  engine?: 'legacy' | 'water_v1'
  rewardCoins?: bigint | string
  category?: string
  breakdownArray?: number[] | undefined
}

/** Mirrors Live `serviceLuckyGift.js` reward field selection. */
function mapLuckyRewardFields(local: LocalDraw, ledger: LedgerResult) {
  const useWater = ledger.engine === 'water_v1'
  const ledgerReward =
    ledger.rewardCoins != null ? BigInt(ledger.rewardCoins) : undefined
  const totalReward = useWater && ledgerReward != null ? ledgerReward : local.totalReward
  const category = useWater && ledger.category != null ? ledger.category : local.category
  const breakdownArray =
    useWater && ledger.breakdownArray != null ? ledger.breakdownArray : local.breakdownArray
  const luckyWin =
    totalReward > 0n
      ? {
          rewardCoins: Number(totalReward),
          category,
          breakdownArray,
        }
      : null
  return { useWater, totalReward, category, breakdownArray, luckyWin }
}

describe('B5 Live enforce payload contract (water vs local)', () => {
  it('water_v1: local jackpot ignored when ledger reward is 0', () => {
    const local = { totalReward: 1000n, category: 'JACKPOT', breakdownArray: [1000] }
    const ledger = {
      engine: 'water_v1' as const,
      rewardCoins: 0n,
      category: 'MISS',
      breakdownArray: [],
    }
    const m = mapLuckyRewardFields(local, ledger)
    expect(m.useWater).toBe(true)
    expect(m.totalReward).toBe(0n)
    expect(m.category).toBe('MISS')
    expect(m.breakdownArray).toEqual([])
    expect(m.luckyWin).toBeNull()
  })

  it('water_v1: ledger 250 overrides local miss (0)', () => {
    const local = { totalReward: 0n, category: 'MISS', breakdownArray: [] }
    const ledger = {
      engine: 'water_v1' as const,
      rewardCoins: 250n,
      category: 'MEDIUM',
      breakdownArray: [250],
    }
    const m = mapLuckyRewardFields(local, ledger)
    expect(m.totalReward).toBe(250n)
    expect(m.category).toBe('MEDIUM')
    expect(m.luckyWin).toMatchObject({ rewardCoins: 250, category: 'MEDIUM' })
    expect(m.breakdownArray!.reduce((a, b) => a + b, 0)).toBe(Number(m.totalReward))
  })

  it('legacy: combo disagreement keeps local draw', () => {
    const local = {
      totalReward: 600n,
      category: 'WINNER',
      breakdownArray: [200, 200, 200],
    }
    const ledger = {
      engine: 'legacy' as const,
      rewardCoins: 250n,
      category: 'MEDIUM',
      breakdownArray: [250],
    }
    const m = mapLuckyRewardFields(local, ledger)
    expect(m.useWater).toBe(false)
    expect(m.totalReward).toBe(600n)
    expect(m.category).toBe('WINNER')
    expect(m.breakdownArray).toEqual([200, 200, 200])
    expect(m.breakdownArray!.reduce((a, b) => a + b, 0)).toBe(Number(m.totalReward))
    expect(m.luckyWin).not.toBeNull()
  })

  it('missing engine treats as legacy (old ledger)', () => {
    const local = { totalReward: 50n, category: 'SMALL', breakdownArray: [50] }
    const m = mapLuckyRewardFields(local, {})
    expect(m.useWater).toBe(false)
    expect(m.totalReward).toBe(50n)
  })

  it('water combo collapse: sum(breakdown) === totalReward', () => {
    const breakdown = [30, 30, 30, 30, 30, 20, 20, 20, 20, 20]
    const local = { totalReward: 999n, category: 'WINNER', breakdownArray: [999] }
    const ledger = {
      engine: 'water_v1' as const,
      rewardCoins: 250n,
      category: 'MEDIUM',
      breakdownArray: breakdown,
    }
    const m = mapLuckyRewardFields(local, ledger)
    expect(m.totalReward).toBe(250n)
    expect(m.breakdownArray!.reduce((a, b) => a + b, 0)).toBe(250)
  })
})
