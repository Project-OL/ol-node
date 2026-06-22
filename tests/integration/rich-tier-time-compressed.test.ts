/**
 * Rich tier — time-compressed integration simulation
 *
 * Exercises real `richTierService` (live badge on recharge + rollover carryover/downgrade)
 * against an in-memory DB harness. **5 real minutes = 1 simulated UTC month** when live
 * delays are enabled.
 *
 * Fast (CI / default):
 *   npm test -- tests/integration/rich-tier-time-compressed.test.ts
 *
 * Live compressed timeline (~25 min total for all scenarios):
 *   PowerShell: $env:RICH_TIER_SIM_LIVE='1'; npm run test:rich-tier-sim
 *   bash:       RICH_TIER_SIM_LIVE=1 npm run test:rich-tier-sim
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  REAL_MONTH_MS,
  sim,
  simWait,
  simDayDelayMs,
} from './rich-tier-sim-harness'
import {
  applyRetentionRule,
  richTierService,
  thresholdForTier,
} from '../../src/services/rich-tier.service'

const LIVE = process.env.RICH_TIER_SIM_LIVE === '1'

async function recharge(userId: string, coins: bigint) {
  await richTierService.applyRecharge(userId, coins, sim.createTx())
}

async function rollover(userId: string, year: number, month: number) {
  await richTierService.processMonthlyRolloverForUser(userId, year, month)
}

async function simMonthWait(remainingDays = 0) {
  if (remainingDays > 0) await simWait(remainingDays)
  if (LIVE) await new Promise((r) => setTimeout(r, REAL_MONTH_MS))
}

describe(
  'rich tier time-compressed simulation (real service)',
  { timeout: LIVE ? 600_000 : 30_000 },
  () => {
    beforeEach(() => sim.reset())

    it('live upgrade on recharge, then rollover carryover for tier 3', async () => {
      const uid = 'user_live_upgrade'

      await simWait(5)
      await recharge(uid, 4_000_000n)
      expect(sim.getTier(uid)).toBe(1)

      await simWait(5)
      await recharge(uid, 6_000_000n)
      expect(sim.getTier(uid)).toBe(3)

      await simWait(10)
      await recharge(uid, 5_000_000n)
      expect(sim.getTier(uid)).toBe(3)

      await simWait(10)
      const closed = sim.advanceToNextMonth()
      await rollover(uid, closed.year, closed.month)

      expect(sim.getTier(uid)).toBe(3)
      expect(sim.getCarryover(uid)).toBe(applyRetentionRule(3))
      expect(sim.getCarryover(uid)).toBe(thresholdForTier(1) / 2n)
    })

    it('single recharge jumps across multiple tiers immediately', async () => {
      const uid = 'user_big_jump'

      await simWait(3)
      await recharge(uid, 50_000_000n)
      expect(sim.getTier(uid)).toBe(6)

      await simWait(27)
      const closed = sim.advanceToNextMonth()
      await rollover(uid, closed.year, closed.month)

      expect(sim.getTier(uid)).toBe(6)
      expect(sim.getCarryover(uid)).toBe(applyRetentionRule(6))
      expect(sim.getCarryover(uid)).toBe(10_000_000n)
    })

    it('downgrades to tier 0 after a month with zero recharge', async () => {
      const uid = 'user_downgrade_zero'

      await simWait(5)
      await recharge(uid, 20_000_000n)
      expect(sim.getTier(uid)).toBe(4)

      await simWait(25)
      let closed = sim.advanceToNextMonth()
      await rollover(uid, closed.year, closed.month)
      expect(sim.getTier(uid)).toBe(4)
      expect(sim.getCarryover(uid)).toBe(2_500_000n)

      await simMonthWait()
      closed = sim.advanceToNextMonth()
      await rollover(uid, closed.year, closed.month)

      expect(sim.getTier(uid)).toBe(0)
      expect(sim.getCarryover(uid)).toBe(0n)
      expect(sim.state.historyRows).toHaveLength(2)
    })

    it('carryover from tier 7 cushions next-month progress', async () => {
      const uid = 'user_carryover_cushion'

      await simWait(5)
      await recharge(uid, 100_000_000n)
      expect(sim.getTier(uid)).toBe(7)

      await simWait(25)
      let closed = sim.advanceToNextMonth()
      await rollover(uid, closed.year, closed.month)
      expect(sim.getCarryover(uid)).toBe(10_000_000n)

      await simWait(5)
      await recharge(uid, 5_000_000n)
      expect(sim.getTier(uid)).toBe(3)

      await simWait(25)
      closed = sim.advanceToNextMonth()
      await rollover(uid, closed.year, closed.month)
      expect(sim.getTier(uid)).toBe(3)
    })

    it('spend does not change badge (no applyRecharge)', async () => {
      const uid = 'user_spend_no_drop'

      await simWait(5)
      await recharge(uid, 5_000_000n)
      expect(sim.getTier(uid)).toBe(2)

      // Spend is not modeled — aggregate unchanged
      expect(sim.getTier(uid)).toBe(2)
    })

    it('incremental recharges step through tiers live', async () => {
      const uid = 'user_incremental'
      const expectedTierAtTotal: Record<number, number> = {
        2: 0,
        4: 1,
        6: 2,
        8: 2,
        10: 3,
        12: 3,
        14: 3,
        16: 3,
        18: 3,
        20: 4,
      }

      for (let i = 1; i <= 10; i++) {
        await simWait(2)
        await recharge(uid, 2_000_000n)
        const totalM = i * 2
        expect(sim.getTier(uid)).toBe(expectedTierAtTotal[totalM])
      }
    })

    it('documents live timing scale when RICH_TIER_SIM_LIVE=1', () => {
      expect(simDayDelayMs(1)).toBe(Math.round(REAL_MONTH_MS / 30))
      expect(simDayDelayMs(30)).toBe(REAL_MONTH_MS)
      if (LIVE) {
        console.info(
          `[rich-tier-sim] Live mode: 1 sim day ≈ ${simDayDelayMs(1)}ms, 1 sim month ≈ ${REAL_MONTH_MS}ms`,
        )
      }
    })
  },
)
