import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
const setex = vi.fn()
const del = vi.fn()
const getOrCreate = vi.fn()
const update = vi.fn()

vi.mock('../../src/config/redis', () => ({
  redisClient: { get: (...a: unknown[]) => get(...a), setex: (...a: unknown[]) => setex(...a), del: (...a: unknown[]) => del(...a) },
  RedisKeys: { payoutRailConfig: () => 'withdrawal:payout-rail-config' },
  PAYOUT_RAIL_CONFIG_TTL: 300,
}))

vi.mock('../../src/repositories/withdrawalPayoutRailConfig.repository', () => ({
  withdrawalPayoutRailConfigRepository: {
    getOrCreate: (...a: unknown[]) => getOrCreate(...a),
    update: (...a: unknown[]) => update(...a),
  },
}))

import { withdrawalPayoutRailConfigService } from '../../src/services/withdrawalPayoutRailConfig.service'

describe('withdrawalPayoutRailConfigService', () => {
  beforeEach(() => {
    get.mockReset()
    setex.mockReset()
    del.mockReset()
    getOrCreate.mockReset()
    update.mockReset()
  })

  it('getPublicConfig includes enabled from DB row', async () => {
    get.mockResolvedValue(null)
    getOrCreate.mockResolvedValue({
      epayFeeRateBp: 600,
      epayArrivalTime: 'Within 24 hours',
      epayEnabled: false,
      bankFeeRateBp: 600,
      bankArrivalTime: '3-5 business days',
      bankEnabled: true,
      updatedAt: new Date('2026-08-09T00:00:00.000Z'),
    })

    const dto = await withdrawalPayoutRailConfigService.getPublicConfig()
    expect(dto.epay.enabled).toBe(false)
    expect(dto.bank.enabled).toBe(true)
  })

  it('assertRailEnabled throws PAYMENT_METHOD_DISABLED when off', async () => {
    get.mockResolvedValue(
      JSON.stringify({
        epay: { feeRateBp: 600, feePercent: 6, arrivalTime: 'x', enabled: false },
        bank: { feeRateBp: 600, feePercent: 6, arrivalTime: 'y', enabled: true },
        bankFields: [],
        updatedAt: '2026-08-09T00:00:00.000Z',
      }),
    )

    await expect(withdrawalPayoutRailConfigService.assertRailEnabled('EPAY')).rejects.toMatchObject({
      statusCode: 403,
      code: 'PAYMENT_METHOD_DISABLED',
    })
    await expect(withdrawalPayoutRailConfigService.assertRailEnabled('BANK')).resolves.toBeUndefined()
  })

  it('reloads from DB when the cached DTO predates bankFields', async () => {
    get.mockResolvedValue(
      JSON.stringify({
        epay: { feeRateBp: 600, feePercent: 6, arrivalTime: 'x', enabled: true },
        bank: { feeRateBp: 600, feePercent: 6, arrivalTime: 'y', enabled: true },
        updatedAt: '2026-08-09T00:00:00.000Z',
      }),
    )
    getOrCreate.mockResolvedValue({
      epayFeeRateBp: 600,
      epayArrivalTime: 'x',
      epayEnabled: true,
      bankFeeRateBp: 600,
      bankArrivalTime: 'y',
      bankEnabled: true,
      bankFieldRules: { ifscCode: { required: false, validate: false } },
      updatedAt: new Date('2026-08-09T00:00:00.000Z'),
    })

    const dto = await withdrawalPayoutRailConfigService.getPublicConfig()
    expect(getOrCreate).toHaveBeenCalled()
    expect(dto.bankFields.find((f) => f.field === 'ifscCode')).toMatchObject({
      required: false,
      validate: false,
    })
    const rules = await withdrawalPayoutRailConfigService.getBankFieldRules()
    expect(rules.firstName).toEqual({ required: true, validate: true })
  })

  it('updateConfig merges bankFields toggles over stored rules', async () => {
    const row = {
      epayFeeRateBp: 600,
      epayArrivalTime: 'x',
      epayEnabled: true,
      bankFeeRateBp: 600,
      bankArrivalTime: 'y',
      bankEnabled: true,
      bankFieldRules: { email: { required: true } },
      updatedAt: new Date('2026-08-09T00:00:00.000Z'),
    }
    getOrCreate.mockResolvedValue(row)
    update.mockImplementation(async (data: Record<string, unknown>) => ({ ...row, ...data }))

    const dto = await withdrawalPayoutRailConfigService.updateConfig('admin-1', {
      bankFields: { phone: { required: true }, ifscCode: { validate: false } },
    })
    const saved = update.mock.calls[0][0].bankFieldRules
    expect(saved.email).toEqual({ required: true, validate: true })
    expect(saved.phone).toEqual({ required: true, validate: true })
    expect(saved.ifscCode).toEqual({ required: true, validate: false })
    expect(dto.bankFields).toHaveLength(9)
  })

  it('updateConfig leaves bankFieldRules untouched when not sent', async () => {
    const row = {
      epayFeeRateBp: 600,
      epayArrivalTime: 'x',
      epayEnabled: true,
      bankFeeRateBp: 600,
      bankArrivalTime: 'y',
      bankEnabled: true,
      bankFieldRules: null,
      updatedAt: new Date('2026-08-09T00:00:00.000Z'),
    }
    getOrCreate.mockResolvedValue(row)
    update.mockResolvedValue(row)
    await withdrawalPayoutRailConfigService.updateConfig('admin-1', { bank: { enabled: true } })
    expect(update.mock.calls[0][0]).not.toHaveProperty('bankFieldRules')
  })

  it('updateConfig persists enabled and busts cache', async () => {
    getOrCreate.mockResolvedValue({
      epayFeeRateBp: 600,
      epayArrivalTime: 'Within 24 hours',
      epayEnabled: true,
      bankFeeRateBp: 600,
      bankArrivalTime: '3-5 business days',
      bankEnabled: true,
      updatedAt: new Date('2026-08-09T00:00:00.000Z'),
    })
    update.mockResolvedValue({
      epayFeeRateBp: 600,
      epayArrivalTime: 'Within 24 hours',
      epayEnabled: false,
      bankFeeRateBp: 600,
      bankArrivalTime: '3-5 business days',
      bankEnabled: true,
      updatedAt: new Date('2026-08-09T01:00:00.000Z'),
    })

    const dto = await withdrawalPayoutRailConfigService.updateConfig('admin-1', {
      epay: { enabled: false },
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ epayEnabled: false, updatedByUserId: 'admin-1' }),
    )
    expect(del).toHaveBeenCalled()
    expect(dto.epay.enabled).toBe(false)
  })
})
