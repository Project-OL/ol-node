import { describe, it, expect } from 'vitest'
import { grossPointsFromUsd, WITHDRAWAL_POINTS_PER_USD } from '../../src/utils/withdrawal-amount'
import { CreateWithdrawalSchema } from '../../src/models/withdrawal.schemas'

describe('withdrawal amount', () => {
  it('converts USD to gross points at 10_000 points per dollar', () => {
    expect(WITHDRAWAL_POINTS_PER_USD).toBe(10_000)
    expect(grossPointsFromUsd(10)).toBe(100_000n)
    expect(grossPointsFromUsd(1.5)).toBe(15_000n)
  })

  it('CreateWithdrawalSchema accepts amountUsd', () => {
    const parsed = CreateWithdrawalSchema.parse({
      amountUsd: 10,
      paymentMethodId: '550e8400-e29b-41d4-a716-446655440000',
      idempotencyKey: 'idem-key-1',
    })
    expect(parsed.grossPoints).toBe(100_000n)
  })

  it('CreateWithdrawalSchema still accepts grossPoints', () => {
    const parsed = CreateWithdrawalSchema.parse({
      grossPoints: '250000',
      paymentMethodId: '550e8400-e29b-41d4-a716-446655440000',
      idempotencyKey: 'idem-key-2',
    })
    expect(parsed.grossPoints).toBe(250_000n)
  })

  it('CreateWithdrawalSchema prefers amountUsd when both provided', () => {
    const parsed = CreateWithdrawalSchema.parse({
      amountUsd: 10,
      grossPoints: '1',
      paymentMethodId: '550e8400-e29b-41d4-a716-446655440000',
      idempotencyKey: 'idem-key-3',
    })
    expect(parsed.grossPoints).toBe(100_000n)
  })
})
