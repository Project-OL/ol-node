import { describe, expect, it, vi } from 'vitest'
import { CoinTxType } from '@prisma/client'
import {
  assertForceAllowed,
  computeRecovery,
  isReversalLedgerRow,
} from './adminTransactionReversal.service'

// Hoisted above the imports by vitest: keeps the module from opening a DB connection.
vi.mock('../config/database', () => ({ prisma: {}, prismaRead: {} }))

describe('computeRecovery', () => {
  it('full mode always moves the original, and reports whether the receiver can cover it', () => {
    expect(computeRecovery({ original: 100_000n, available: 80_000n, mode: 'full' })).toEqual({
      recovered: 100_000n,
      shortfall: 0n,
      sufficient: false,
    })
    expect(computeRecovery({ original: 100_000n, available: 150_000n, mode: 'full' })).toEqual({
      recovered: 100_000n,
      shortfall: 0n,
      sufficient: true,
    })
  })

  it('force mode recovers what the receiver has and records the rest as shortfall', () => {
    // A sent B 100,000 by mistake; B spent 20,000.
    expect(computeRecovery({ original: 100_000n, available: 80_000n, mode: 'force' })).toEqual({
      recovered: 80_000n,
      shortfall: 20_000n,
      sufficient: false,
    })
  })

  it('force mode never takes more than the original', () => {
    expect(computeRecovery({ original: 100_000n, available: 250_000n, mode: 'force' })).toEqual({
      recovered: 100_000n,
      shortfall: 0n,
      sufficient: true,
    })
  })

  it('treats a negative available balance as zero', () => {
    expect(computeRecovery({ original: 500n, available: -10n, mode: 'force' })).toEqual({
      recovered: 0n,
      shortfall: 500n,
      sufficient: false,
    })
  })
})

describe('isReversalLedgerRow', () => {
  it('flags admin revert legs and trading-transfer reversal legs', () => {
    expect(isReversalLedgerRow({ idempotencyKey: 'admin-revert:point:abc:debit' })).toBe(true)
    expect(isReversalLedgerRow({ idempotencyKey: 'admin-revert:coin:abc:credit' })).toBe(true)
    expect(isReversalLedgerRow({ idempotencyKey: 'admin-revert:point-single:abc:reverse' })).toBe(
      true,
    )
    expect(isReversalLedgerRow({ idempotencyKey: 'trading-reversal:t1:recipient' })).toBe(true)
    expect(isReversalLedgerRow({ txType: CoinTxType.TRADING_TRANSFER_REVERSAL })).toBe(true)
  })

  it('does not flag ordinary transfers or admin wallet adjustments', () => {
    expect(isReversalLedgerRow({ idempotencyKey: 'agent-transfer:k1:debit' })).toBe(false)
    expect(isReversalLedgerRow({ idempotencyKey: 'admin-wallet-debit-trading:a:b' })).toBe(false)
    expect(
      isReversalLedgerRow({ idempotencyKey: null, txType: CoinTxType.TRADING_TRANSFER_OUT }),
    ).toBe(false)
  })
})

describe('assertForceAllowed', () => {
  it('allows full mode for any admin', () => {
    expect(() => assertForceAllowed('full', 'CSA')).not.toThrow()
  })

  it('allows force only for SUPER_ADMIN', () => {
    expect(() => assertForceAllowed('force', 'SUPER_ADMIN')).not.toThrow()
    expect(() => assertForceAllowed('force', 'ADMIN')).toThrow(
      expect.objectContaining({ code: 'FORCE_REVERSE_FORBIDDEN', statusCode: 403 }),
    )
    expect(() => assertForceAllowed('force', undefined)).toThrow(
      expect.objectContaining({ code: 'FORCE_REVERSE_FORBIDDEN' }),
    )
  })
})
