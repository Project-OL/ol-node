import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { refundUnits } from '../../src/services/payment-refund.service'
import { normalizeSuspectValue } from '../../src/services/payment-suspects.service'
import { parseEpayRefundOrder } from '../../src/services/epay-payin.service'
import {
  classifyCoinLedgerOrigin,
  matchesAppIdemPrefix,
} from '../../src/services/ledger-audit/ledger-origin.classifier'

const D = (v: string) => new Prisma.Decimal(v)

describe('refundUnits', () => {
  it('full refund (no amount, equal or larger amount) takes everything', () => {
    expect(refundUnits(64_000n, D('9.99'), null)).toBe(64_000n)
    expect(refundUnits(64_000n, D('9.99'), D('9.99'))).toBe(64_000n)
    expect(refundUnits(64_000n, D('9.99'), D('12'))).toBe(64_000n)
  })
  it('partial refund is proportional, rounded up', () => {
    expect(refundUnits(64_000n, D('9.99'), D('3.33'))).toBe(21_334n)
    expect(refundUnits(100n, D('1'), D('0.001'))).toBe(1n)
  })
  it('zero refund takes nothing', () => {
    expect(refundUnits(64_000n, D('9.99'), D('0'))).toBe(0n)
  })
})

describe('normalizeSuspectValue', () => {
  it('lower-cases emails and strips phone punctuation', () => {
    expect(normalizeSuspectValue('EMAIL', '  A.B@Example.COM ')).toBe('a.b@example.com')
    expect(normalizeSuspectValue('PHONE', '+91 99-1234 (5678)')).toBe('+919912345678')
    expect(normalizeSuspectValue('DEVICE', ' AbC ')).toBe('AbC')
  })
})

describe('parseEpayRefundOrder', () => {
  it('accepts an object or a JSON string; rejects junk', () => {
    expect(parseEpayRefundOrder({ status: '7' })).toEqual({ status: '7' })
    expect(parseEpayRefundOrder('{"status":"7","amount":"2.99"}')).toEqual({
      status: '7',
      amount: '2.99',
    })
    expect(parseEpayRefundOrder('not json')).toBeNull()
    expect(parseEpayRefundOrder('')).toBeNull()
    expect(parseEpayRefundOrder(['x'])).toBeNull()
    expect(parseEpayRefundOrder(undefined)).toBeNull()
  })
})

describe('ledger origin classifier', () => {
  it('treats payment-refund clawbacks as an app (system) path, not an unknown adjustment', () => {
    expect(matchesAppIdemPrefix('payment-refund:abc')).toBe(true)
    expect(
      classifyCoinLedgerOrigin({
        idempotencyKey: 'payment-refund:abc',
        metadata: { source: 'payment_refund' },
        txType: 'ADJUSTMENT',
      }),
    ).toBe('APP')
  })
})
