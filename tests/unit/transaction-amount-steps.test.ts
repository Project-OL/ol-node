import { describe, it, expect } from 'vitest'
import {
  assertPositiveAmountMultiple,
  assertPositiveIntMultiple,
  POINTS_EXCHANGE_STEP,
  TRADING_COIN_TRANSFER_STEP,
  AGENT_POINT_TRANSFER_STEP,
  VIDEO_CALL_PRICE_STEP,
} from '../../src/utils/transaction-amount-steps'

describe('transaction amount steps', () => {
  it('accepts exact multiples for points exchange', () => {
    expect(() =>
      assertPositiveAmountMultiple(200_000n, POINTS_EXCHANGE_STEP, {
        belowMinCode: 'MIN_POINTS_EXCHANGE',
        unitLabel: 'points',
      }),
    ).not.toThrow()
  })

  it('rejects non-multiple points exchange amounts', () => {
    try {
      assertPositiveAmountMultiple(10_100n, POINTS_EXCHANGE_STEP, {
        belowMinCode: 'MIN_POINTS_EXCHANGE',
        unitLabel: 'points',
      })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toMatchObject({ code: 'INVALID_AMOUNT_STEP' })
    }
  })

  it('rejects trading coin transfer not multiple of 100', () => {
    try {
      assertPositiveAmountMultiple(150n, TRADING_COIN_TRANSFER_STEP, {
        belowMinCode: 'MIN_TRANSFER',
        unitLabel: 'trading coins',
      })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toMatchObject({ code: 'INVALID_AMOUNT_STEP' })
    }
  })

  it('rejects agent point transfer not multiple of 100k', () => {
    try {
      assertPositiveAmountMultiple(150_000n, AGENT_POINT_TRANSFER_STEP, {
        belowMinCode: 'MIN_TRANSFER_VIOLATION',
        unitLabel: 'points',
      })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toMatchObject({ code: 'INVALID_AMOUNT_STEP' })
    }
  })

  it('rejects video call price not multiple of 1800', () => {
    try {
      assertPositiveIntMultiple(1900, VIDEO_CALL_PRICE_STEP, {
        belowMinCode: 'MIN_CALL_PRICE',
        unitLabel: 'price per minute',
      })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toMatchObject({ code: 'INVALID_AMOUNT_STEP' })
    }
  })
})
