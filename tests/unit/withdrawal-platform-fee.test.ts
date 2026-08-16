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

describe('calculateWithdrawalAmounts service fee first, then platform + agent share', () => {
  it('100k pts ($10): $1 service fee then 5% of remaining', () => {
    const r = calculateWithdrawalAmounts(100_000n, defaultConfig)
    expect(r.serviceFeePoints).toBe(10_000n)
    expect(r.platformFeeRateBp).toBe(500)
    expect(r.platformFeePoints).toBe(4_500n)
    expect(r.agentRewardPoints).toBe(2_700n)
    expect(r.hostPayoutPoints).toBe(85_500n)
    expect(r.hostNetUsd).toBe(8.55)
  })

  it('500k pts: $1 service fee then 3% of remaining', () => {
    const r = calculateWithdrawalAmounts(500_000n, defaultConfig)
    expect(r.serviceFeePoints).toBe(10_000n)
    expect(r.platformFeeRateBp).toBe(300)
    expect(r.platformFeePoints).toBe(14_700n)
    expect(r.agentRewardPoints).toBe(8_820n)
    expect(r.hostPayoutPoints).toBe(475_300n)
  })

  it('2M pts: $1 service fee then 2% of remaining', () => {
    const r = calculateWithdrawalAmounts(2_000_000n, defaultConfig)
    expect(r.serviceFeePoints).toBe(10_000n)
    expect(r.platformFeeRateBp).toBe(200)
    expect(r.platformFeePoints).toBe(39_800n)
    expect(r.agentRewardPoints).toBe(23_880n)
    expect(r.hostPayoutPoints).toBe(1_950_200n)
  })

  it('agent reward uses config share of platform fee (not remaining points)', () => {
    const cfg = { ...defaultConfig, agentRewardRateBp: 6000 }
    const r = calculateWithdrawalAmounts(1_000_001n, cfg)
    const feeBase = 1_000_001n - 10_000n
    const platformFee = (feeBase * 200n) / 10000n
    expect(r.platformFeeRateBp).toBe(200)
    expect(r.platformFeePoints).toBe(platformFee)
    expect(r.agentRewardPoints).toBe((platformFee * 6000n) / 10000n)
  })

  it('rejects when service fee covers the whole request', () => {
    expect(() =>
      calculateWithdrawalAmounts(10_000n, { ...defaultConfig, minWithdrawalUsd: 0 }),
    ).toThrow(/Service fee/)
  })
})
