import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
const setex = vi.fn()
const del = vi.fn()
const getOrCreate = vi.fn()
const update = vi.fn()
const findUser = vi.fn()

vi.mock('../../src/config/redis', () => ({
  redisClient: { get: (...a: unknown[]) => get(...a), setex: (...a: unknown[]) => setex(...a), del: (...a: unknown[]) => del(...a) },
  RedisKeys: { payoutRailConfig: () => 'withdrawal:payout-rail-config' },
  PAYOUT_RAIL_CONFIG_TTL: 300,
}))

vi.mock('../../src/config/database', () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUser(...a) } },
}))

vi.mock('../../src/repositories/withdrawalPayoutRailConfig.repository', () => ({
  withdrawalPayoutRailConfigRepository: {
    getOrCreate: (...a: unknown[]) => getOrCreate(...a),
    update: (...a: unknown[]) => update(...a),
  },
}))

import {
  railEnabledFor,
  withdrawalPayoutRailConfigService,
} from '../../src/services/withdrawalPayoutRailConfig.service'

const baseRow = {
  epayFeeRateBp: 600,
  epayArrivalTime: 'Within 24 hours',
  epayEnabled: true,
  epayUsersEnabled: false,
  bankFeeRateBp: 600,
  bankArrivalTime: '3-5 business days',
  bankEnabled: true,
  bankFieldRules: null,
  updatedAt: new Date('2026-08-09T00:00:00.000Z'),
}

function cachedDto(epay: { enabledForAgents: boolean; enabledForUsers: boolean }, bankEnabled = true) {
  return JSON.stringify({
    epay: {
      feeRateBp: 600,
      feePercent: 6,
      arrivalTime: 'x',
      enabled: epay.enabledForAgents || epay.enabledForUsers,
      ...epay,
    },
    bank: { feeRateBp: 600, feePercent: 6, arrivalTime: 'y', enabled: bankEnabled },
    bankFields: [],
    updatedAt: '2026-08-09T00:00:00.000Z',
  })
}

describe('withdrawalPayoutRailConfigService', () => {
  beforeEach(() => {
    get.mockReset()
    setex.mockReset()
    del.mockReset()
    getOrCreate.mockReset()
    update.mockReset()
    findUser.mockReset()
  })

  it('getPublicConfig exposes the per-audience EPAY switch from the DB row', async () => {
    get.mockResolvedValue(null)
    getOrCreate.mockResolvedValue({ ...baseRow, epayEnabled: true, epayUsersEnabled: false })

    const dto = await withdrawalPayoutRailConfigService.getPublicConfig()
    expect(dto.epay).toMatchObject({ enabledForAgents: true, enabledForUsers: false, enabled: true })
    expect(dto.bank.enabled).toBe(true)
  })

  it('epay.enabled is false only when both audiences are off', async () => {
    get.mockResolvedValue(null)
    getOrCreate.mockResolvedValue({ ...baseRow, epayEnabled: false, epayUsersEnabled: false })
    const dto = await withdrawalPayoutRailConfigService.getPublicConfig()
    expect(dto.epay.enabled).toBe(false)
  })

  it('reloads from DB when the cached DTO predates the per-audience switch', async () => {
    get.mockResolvedValue(
      JSON.stringify({
        epay: { feeRateBp: 600, feePercent: 6, arrivalTime: 'x', enabled: true },
        bank: { feeRateBp: 600, feePercent: 6, arrivalTime: 'y', enabled: true },
        bankFields: [],
        updatedAt: '2026-08-09T00:00:00.000Z',
      }),
    )
    getOrCreate.mockResolvedValue(baseRow)

    const dto = await withdrawalPayoutRailConfigService.getPublicConfig()
    expect(getOrCreate).toHaveBeenCalled()
    expect(dto.epay.enabledForUsers).toBe(false)
  })

  it('railEnabledFor picks the EPAY switch by audience; BANK ignores it', () => {
    const dto = JSON.parse(cachedDto({ enabledForAgents: true, enabledForUsers: false }))
    expect(railEnabledFor(dto, 'EPAY', true)).toBe(true)
    expect(railEnabledFor(dto, 'EPAY', false)).toBe(false)
    expect(railEnabledFor(dto, 'BANK', false)).toBe(true)
    expect(railEnabledFor(dto, 'BANK', true)).toBe(true)
  })

  it('assertRailEnabled blocks EPAY for a non-agent and allows it for an agent', async () => {
    get.mockResolvedValue(cachedDto({ enabledForAgents: true, enabledForUsers: false }))

    findUser.mockResolvedValue({ isAgent: false })
    await expect(
      withdrawalPayoutRailConfigService.assertRailEnabled('EPAY', 'user-1'),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PAYMENT_METHOD_DISABLED' })

    findUser.mockResolvedValue({ isAgent: true })
    await expect(
      withdrawalPayoutRailConfigService.assertRailEnabled('EPAY', 'agent-1'),
    ).resolves.toBeUndefined()
  })

  it('assertRailEnabled treats a missing user as a non-agent', async () => {
    get.mockResolvedValue(cachedDto({ enabledForAgents: true, enabledForUsers: false }))
    findUser.mockResolvedValue(null)
    await expect(
      withdrawalPayoutRailConfigService.assertRailEnabled('EPAY', 'ghost'),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_DISABLED' })
  })

  it('assertRailEnabled blocks EPAY for agents when the agents switch is off', async () => {
    get.mockResolvedValue(cachedDto({ enabledForAgents: false, enabledForUsers: false }))
    findUser.mockResolvedValue({ isAgent: true })
    await expect(
      withdrawalPayoutRailConfigService.assertRailEnabled('EPAY', 'agent-1'),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_DISABLED' })
  })

  it('assertRailEnabled for BANK skips the user lookup', async () => {
    get.mockResolvedValue(cachedDto({ enabledForAgents: false, enabledForUsers: false }, false))
    await expect(
      withdrawalPayoutRailConfigService.assertRailEnabled('BANK', 'user-1'),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_DISABLED' })
    expect(findUser).not.toHaveBeenCalled()
  })

  it('reloads from DB when the cached DTO predates bankFields', async () => {
    get.mockResolvedValue(
      JSON.stringify({
        epay: { feeRateBp: 600, feePercent: 6, arrivalTime: 'x', enabled: true, enabledForAgents: true, enabledForUsers: false },
        bank: { feeRateBp: 600, feePercent: 6, arrivalTime: 'y', enabled: true },
        updatedAt: '2026-08-09T00:00:00.000Z',
      }),
    )
    getOrCreate.mockResolvedValue({
      ...baseRow,
      bankFieldRules: { ifscCode: { required: false, validate: false } },
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
    const row = { ...baseRow, bankFieldRules: { email: { required: true } } }
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
    getOrCreate.mockResolvedValue(baseRow)
    update.mockResolvedValue(baseRow)
    await withdrawalPayoutRailConfigService.updateConfig('admin-1', { bank: { enabled: true } })
    expect(update.mock.calls[0][0]).not.toHaveProperty('bankFieldRules')
  })

  it('updateConfig persists the two EPAY switches independently and busts cache', async () => {
    getOrCreate.mockResolvedValue(baseRow)
    update.mockImplementation(async (data: Record<string, unknown>) => ({ ...baseRow, ...data }))

    const dto = await withdrawalPayoutRailConfigService.updateConfig('admin-1', {
      epay: { enabledForAgents: false, enabledForUsers: true },
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        epayEnabled: false,
        epayUsersEnabled: true,
        updatedByUserId: 'admin-1',
      }),
    )
    expect(del).toHaveBeenCalled()
    expect(dto.epay).toMatchObject({ enabledForAgents: false, enabledForUsers: true })
  })

  it('legacy epay.enabled maps to the agents switch only, never to users', async () => {
    getOrCreate.mockResolvedValue(baseRow)
    update.mockImplementation(async (data: Record<string, unknown>) => ({ ...baseRow, ...data }))

    await withdrawalPayoutRailConfigService.updateConfig('admin-1', { epay: { enabled: true } })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ epayEnabled: true, epayUsersEnabled: false }),
    )

    update.mockClear()
    await withdrawalPayoutRailConfigService.updateConfig('admin-1', { epay: { enabled: false } })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ epayEnabled: false, epayUsersEnabled: false }),
    )
  })
})
