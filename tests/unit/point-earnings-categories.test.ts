import { describe, expect, it } from 'vitest'
import { PointTxType } from '@prisma/client'
import {
  POINT_EARNINGS_CATEGORIES,
  resolvePointHistoryTxTypes,
  sumCreditsByCategory,
} from '../../src/config/point-earnings-categories'

describe('point earnings categories', () => {
  it('expands livestream category to gift receive, video call, and adjustment', () => {
    const types = resolvePointHistoryTxTypes(['livestream'])
    expect(types).toEqual(
      expect.arrayContaining([
        PointTxType.GIFT_RECEIVE,
        PointTxType.VIDEO_CALL,
        PointTxType.ADJUSTMENT,
        PointTxType.LIVESTREAM_GIFT,
      ]),
    )
    expect(types).toHaveLength(4)
  })

  it('expands subscription category to subscription and guardian purchase', () => {
    const types = resolvePointHistoryTxTypes(['subscription'])
    expect(types).toEqual(
      expect.arrayContaining([PointTxType.SUBSCRIPTION, PointTxType.GUARDIAN_PURCHASE]),
    )
  })

  it('expands guardian alias to GUARDIAN_PURCHASE only', () => {
    expect(resolvePointHistoryTxTypes(['guardian'])).toEqual([PointTxType.GUARDIAN_PURCHASE])
  })

  it('rolls guardian credits into subscription earnings bucket', () => {
    const earnings = sumCreditsByCategory({
      [PointTxType.GUARDIAN_PURCHASE]: 75_000n,
      [PointTxType.SUBSCRIPTION]: 2500n,
    })
    expect(earnings.subscription).toBe('77500')
  })

  it('expands commission category to agent commission and payroll host payout only', () => {
    const types = resolvePointHistoryTxTypes(['commission'])
    expect(types).toEqual(
      expect.arrayContaining([PointTxType.AGENT_COMMISSION, PointTxType.PAYROLL_HOST_PAYOUT]),
    )
    expect(types).toHaveLength(2)
  })

  it('expands platform_reward category to payroll processing reward, platform reward, and livestream streak reward', () => {
    // Host commission platformRewards (2026-08-10): LIVESTREAM_STREAK_REWARD
    // (first-7-days livestream daily claims) added to this category.
    const types = resolvePointHistoryTxTypes(['platform_reward'])
    expect(types).toEqual(
      expect.arrayContaining([
        PointTxType.PAYROLL_PROCESSING_REWARD,
        PointTxType.PLATFORM_REWARD,
        PointTxType.LIVESTREAM_STREAK_REWARD,
      ]),
    )
    expect(types).toHaveLength(3)
  })

  it('expands transfer category to agent point transfer and transfer out only', () => {
    const types = resolvePointHistoryTxTypes(['transfer'])
    expect(types).toEqual(
      expect.arrayContaining([PointTxType.AGENT_POINT_TRANSFER, PointTxType.TRANSFER_OUT]),
    )
    expect(types).toHaveLength(2)
  })

  it('expands withdraw category to escrow and refund types', () => {
    const types = resolvePointHistoryTxTypes(['withdraw'])
    expect(types).toEqual(
      expect.arrayContaining([
        PointTxType.WITHDRAWAL_ESCROW,
        PointTxType.WITHDRAWAL_ESCROW_SETTLED,
        PointTxType.WITHDRAWAL_REFUND,
      ]),
    )
    expect(types).toHaveLength(3)
  })

  it('merges multiple categories and dedupes raw types', () => {
    const types = resolvePointHistoryTxTypes(['transfer', 'AGENT_POINT_TRANSFER', 'subscription'])
    expect(types).toContain(PointTxType.SUBSCRIPTION)
    expect(types).toContain(PointTxType.TRANSFER_OUT)
    expect(types).toContain(PointTxType.AGENT_POINT_TRANSFER)
    expect(types?.filter((t) => t === PointTxType.AGENT_POINT_TRANSFER)).toHaveLength(1)
  })

  it('rejects unknown filter values', () => {
    expect(() => resolvePointHistoryTxTypes(['mysteryChest'])).toThrow(
      /Invalid point history type filter/,
    )
  })

  it('sums credits into category buckets for summary', () => {
    const earnings = sumCreditsByCategory({
      [PointTxType.GIFT_RECEIVE]: 100n,
      [PointTxType.VIDEO_CALL]: 50n,
      [PointTxType.AGENT_COMMISSION]: 30n,
      [PointTxType.PAYROLL_HOST_PAYOUT]: 20n,
      [PointTxType.AGENT_POINT_TRANSFER]: 5n,
      [PointTxType.SUBSCRIPTION]: 7n,
      [PointTxType.PLATFORM_REWARD]: 3n,
      [PointTxType.PAYROLL_PROCESSING_REWARD]: 2n,
      [PointTxType.WITHDRAWAL_REFUND]: 40n,
    })
    expect(earnings.livestream).toBe('150')
    expect(earnings.commission).toBe('50')
    expect(earnings.subscription).toBe('7')
    expect(earnings.platform_reward).toBe('5')
    expect(earnings.transfer).toBe('5')
    expect(earnings.withdraw).toBe('40')
  })

  it('covers every category with at least one tx type', () => {
    for (const key of Object.keys(POINT_EARNINGS_CATEGORIES)) {
      expect(
        POINT_EARNINGS_CATEGORIES[key as keyof typeof POINT_EARNINGS_CATEGORIES].length,
      ).toBeGreaterThan(0)
    }
  })
})
