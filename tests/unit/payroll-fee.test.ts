import { describe, it, expect } from 'vitest'
import { calculateTieredPlatformFee, MIN_PAYROLL_POINTS } from '../../src/utils/payroll-fee'

describe('calculateTieredPlatformFee', () => {
  it('charges 5% for withdrawals under 200,000 points', () => {
    expect(calculateTieredPlatformFee(100_000n)).toBe(5_000n)
    expect(calculateTieredPlatformFee(199_999n)).toBe(9_999n) // floor via BigInt truncation
  })

  it('charges 3% for 200,000–999,999 points', () => {
    expect(calculateTieredPlatformFee(200_000n)).toBe(6_000n)
    expect(calculateTieredPlatformFee(500_000n)).toBe(15_000n)
    expect(calculateTieredPlatformFee(999_999n)).toBe(29_999n)
  })

  it('charges 2% for 1,000,000+ points', () => {
    expect(calculateTieredPlatformFee(1_000_000n)).toBe(20_000n)
    expect(calculateTieredPlatformFee(5_000_000n)).toBe(100_000n)
    expect(calculateTieredPlatformFee(10_000_000n)).toBe(200_000n)
  })

  it('MIN_PAYROLL_POINTS is 100,000', () => {
    expect(MIN_PAYROLL_POINTS).toBe(100_000n)
  })
})
