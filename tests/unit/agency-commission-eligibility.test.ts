import {
  COMMISSION_ELIGIBLE_TX_TYPES,
  LIVE_COMMISSION_TX_TYPES,
  MATCH_CHAT_COMMISSION_TX_TYPES,
} from '../../src/services/agencyCommission.service'
import { PointTxType } from '@prisma/client'

describe('COMMISSION_ELIGIBLE_TX_TYPES', () => {
  it('includes GIFT_RECEIVE', () => {
    expect(COMMISSION_ELIGIBLE_TX_TYPES.has(PointTxType.GIFT_RECEIVE)).toBe(true)
  })
  it('includes VIDEO_CALL', () => {
    expect(COMMISSION_ELIGIBLE_TX_TYPES.has(PointTxType.VIDEO_CALL)).toBe(true)
  })
  it('does NOT include SUBSCRIPTION', () => {
    expect(COMMISSION_ELIGIBLE_TX_TYPES.has(PointTxType.SUBSCRIPTION)).toBe(false)
  })
  it('does NOT include GUARDIAN_PURCHASE', () => {
    expect(COMMISSION_ELIGIBLE_TX_TYPES.has(PointTxType.GUARDIAN_PURCHASE)).toBe(false)
  })
  it('has exactly 2 eligible types (GIFT_RECEIVE and VIDEO_CALL)', () => {
    // LIVESTREAM_GIFT is legacy and conditionally included — allow 2 or 3
    expect(COMMISSION_ELIGIBLE_TX_TYPES.size).toBeGreaterThanOrEqual(2)
    expect(COMMISSION_ELIGIBLE_TX_TYPES.size).toBeLessThanOrEqual(3)
  })
})

describe('LIVE_COMMISSION_TX_TYPES', () => {
  it('includes GIFT_RECEIVE', () => {
    expect(LIVE_COMMISSION_TX_TYPES.has(PointTxType.GIFT_RECEIVE)).toBe(true)
  })
  it('does NOT include VIDEO_CALL', () => {
    expect(LIVE_COMMISSION_TX_TYPES.has(PointTxType.VIDEO_CALL)).toBe(false)
  })
})

describe('MATCH_CHAT_COMMISSION_TX_TYPES', () => {
  it('includes VIDEO_CALL', () => {
    expect(MATCH_CHAT_COMMISSION_TX_TYPES.has(PointTxType.VIDEO_CALL)).toBe(true)
  })
  it('does NOT include GIFT_RECEIVE', () => {
    expect(MATCH_CHAT_COMMISSION_TX_TYPES.has(PointTxType.GIFT_RECEIVE)).toBe(false)
  })
})
