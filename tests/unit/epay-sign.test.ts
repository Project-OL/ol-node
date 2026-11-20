import { describe, it, expect } from 'vitest'
import { buildEpaySignString, epaySign, verifyEpaySign } from '../../src/lib/epay/epay-sign'

// Worked example 1 from https://opendocs.epay.com/gateway/cn/before/api_sign.html
const DOC_KEY = '3A4BC4A4000CF1B5FFA9E351E6C1539E'
const DOC_PARAMS = { version: 'v1.0.0', epayAccount: 'api@epay.com', currency: 'USD' }
const DOC_SIGN = '4B0FF54AEF7F9395784F8BA2A35A30C4A74414EDA026E47D862D82ED7306797F'

describe('epaySign', () => {
  it('matches the Epay doc worked example (sorted keys, &key=, SHA-256 uppercase)', () => {
    expect(buildEpaySignString(DOC_PARAMS, DOC_KEY)).toBe(
      `currency=USD&epayAccount=api@epay.com&version=v1.0.0&key=${DOC_KEY}`,
    )
    expect(epaySign(DOC_PARAMS, DOC_KEY)).toBe(DOC_SIGN)
  })

  it('drops empty / null / undefined values and empty nested objects', () => {
    expect(
      buildEpaySignString(
        { b: '', a: '1', c: null, d: undefined, e: { x: '' }, f: 0 },
        'K',
      ),
    ).toBe('a=1&f=0&key=K')
  })

  it('serialises nested objects as k={sorted&pairs}', () => {
    expect(
      buildEpaySignString(
        { receiverInfo: { surName: 'li', country: 'IN', accountNo: '42' }, amount: '10' },
        'K',
      ),
    ).toBe('amount=10&receiverInfo={accountNo=42&country=IN&surName=li}&key=K')
  })

  it('sorts case-sensitively in ASCII order (uppercase before lowercase)', () => {
    expect(buildEpaySignString({ b: '1', B: '2', a: '3' }, 'K')).toBe('B=2&a=3&b=1&key=K')
  })

  it('never signs the top-level sign field', () => {
    expect(epaySign({ ...DOC_PARAMS, sign: 'whatever' }, DOC_KEY)).toBe(DOC_SIGN)
  })

  it('rejects arrays rather than guessing a format', () => {
    expect(() => epaySign({ a: ['x'] as unknown as string }, 'K')).toThrow(/array/)
  })
})

describe('verifyEpaySign', () => {
  it('accepts a correct signature, case-insensitively', () => {
    expect(verifyEpaySign({ ...DOC_PARAMS, sign: DOC_SIGN }, DOC_KEY)).toBe(true)
    expect(verifyEpaySign({ ...DOC_PARAMS, sign: DOC_SIGN.toLowerCase() }, DOC_KEY)).toBe(true)
  })

  it('rejects a tampered field, a wrong key, and malformed signatures', () => {
    expect(verifyEpaySign({ ...DOC_PARAMS, currency: 'EUR', sign: DOC_SIGN }, DOC_KEY)).toBe(false)
    expect(verifyEpaySign({ ...DOC_PARAMS, sign: DOC_SIGN }, 'other-key')).toBe(false)
    expect(verifyEpaySign({ ...DOC_PARAMS, sign: '' }, DOC_KEY)).toBe(false)
    expect(verifyEpaySign({ ...DOC_PARAMS, sign: 'zz' }, DOC_KEY)).toBe(false)
    expect(verifyEpaySign({ ...DOC_PARAMS }, DOC_KEY)).toBe(false)
  })
})
