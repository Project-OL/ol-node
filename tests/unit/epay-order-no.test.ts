import { describe, it, expect } from 'vitest'
import { epayOrderKindOf, makeEpayMerchantOrderNo } from '../../src/lib/epay/epay-order-no'

describe('Epay merchantOrderNo', () => {
  it('is prefix + yyMMdd (UTC) + 16 hex, 24 chars, and round-trips to its kind', () => {
    const at = new Date('2026-11-20T23:59:00Z')
    for (const kind of ['PERSONAL_TOPUP', 'TRADING_TOPUP', 'WITHDRAWAL_PAYOUT'] as const) {
      const no = makeEpayMerchantOrderNo(kind, at)
      expect(no).toHaveLength(24)
      expect(no.slice(2, 8)).toBe('261120')
      expect(epayOrderKindOf(no)).toBe(kind)
    }
    expect(makeEpayMerchantOrderNo('PERSONAL_TOPUP').startsWith('CP')).toBe(true)
    expect(makeEpayMerchantOrderNo('TRADING_TOPUP').startsWith('CT')).toBe(true)
    expect(makeEpayMerchantOrderNo('WITHDRAWAL_PAYOUT').startsWith('WD')).toBe(true)
  })

  it('is unique across many draws', () => {
    const set = new Set(Array.from({ length: 2000 }, () => makeEpayMerchantOrderNo('PERSONAL_TOPUP')))
    expect(set.size).toBe(2000)
  })

  it('rejects anything we did not mint', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'CP',
      'XX261120ABCDEF0123456789',
      'cp261120ABCDEF0123456789',
      'CP261120abcdef0123456789',
      'CP261120ABCDEF0123456789X',
      "CP261120ABCDEF012345678'",
    ]) {
      expect(epayOrderKindOf(bad)).toBeNull()
    }
  })
})
