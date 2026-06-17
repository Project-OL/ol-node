import { describe, expect, it } from 'vitest'
import { resolvePlatformFeeRateBp } from '../../src/utils/payroll-fee'
import {
  calculateWithdrawalAmounts,
  type PayrollConfigSnapshot,
} from '../../src/services/withdrawal.service'

const defaultConfig: PayrollConfigSnapshot = {
  id: 1,
  platformFeeRateBp: 500,
  agentRewardRateBp: 6000,
  serviceFeeUsd: 1,
  minWithdrawalUsd: 10,
  maxWithdrawalUsd: 10_000_000,
  slaHours: 2,
  waitingHours: 2,
  maxAssignmentAttempts: 5,
  inrPerUsd: 88,
}

describe('resolvePlatformFeeRateBp', () => {
  it('uses 5% below 2 lakh', () => {
    expect(resolvePlatformFeeRateBp(199_999n)).toBe(500)
    expect(resolvePlatformFeeRateBp(100_000n)).toBe(500)
  })

  it('uses 3% from 2 lakh up to under 10 lakh', () => {
    expect(resolvePlatformFeeRateBp(200_000n)).toBe(300)
    expect(resolvePlatformFeeRateBp(999_999n)).toBe(300)
  })

  it('uses 2% from 10 lakh upward', () => {
    expect(resolvePlatformFeeRateBp(1_000_000n)).toBe(200)
    expect(resolvePlatformFeeRateBp(5_000_000n)).toBe(200)
  })
})

describe('calculateWithdrawalAmounts tiered platform fee + 60% agent share', () => {
  it('100k pts: 5% platform, agent gets 60% of platform fee', () => {
    const r = calculateWithdrawalAmounts(100_000n, defaultConfig)
    expect(r.platformFeeRateBp).toBe(500)
    expect(r.platformFeePoints).toBe(5000n)
    expect(r.agentRewardPoints).toBe(3000n)
    expect(r.hostPayoutPoints).toBe(95_000n)
  })

  it('500k pts: 3% platform, agent gets 60% of platform fee', () => {
    const r = calculateWithdrawalAmounts(500_000n, defaultConfig)
    expect(r.platformFeeRateBp).toBe(300)
    expect(r.platformFeePoints).toBe(15_000n)
    expect(r.agentRewardPoints).toBe(9000n)
    expect(r.hostPayoutPoints).toBe(485_000n)
  })

  it('2M pts: 2% platform, agent gets 60% of platform fee', () => {
    const r = calculateWithdrawalAmounts(2_000_000n, defaultConfig)
    expect(r.platformFeeRateBp).toBe(200)
    expect(r.platformFeePoints).toBe(40_000n)
    expect(r.agentRewardPoints).toBe(24_000n)
    expect(r.hostPayoutPoints).toBe(1_960_000n)
  })

  it('agent reward uses config share of platform fee (not gross)', () => {
    const cfg = { ...defaultConfig, agentRewardRateBp: 6000 }
    const r = calculateWithdrawalAmounts(1_000_001n, cfg)
    const platformFee = (1_000_001n * 200n) / 10000n
    expect(r.platformFeeRateBp).toBe(200)
    expect(r.platformFeePoints).toBe(platformFee)
    expect(r.agentRewardPoints).toBe((platformFee * 6000n) / 10000n)
  })
})
