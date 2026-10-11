import { describe, it, expect, vi, beforeEach } from 'vitest'

const assertRailEnabled = vi.fn()
const verifyCurrentPassword = vi.fn()
const upsert = vi.fn()
const upsertBank = vi.fn()
const findById = vi.fn()

vi.mock('../../src/config/redis', () => ({
  redisClient: { get: vi.fn(), setex: vi.fn(), del: vi.fn() },
  RedisKeys: { userPaymentMethods: (id: string) => `pmethods:${id}` },
  WALLET_BALANCE_TTL: 60,
}))

const getPublicConfig = vi.fn()
const getBankFieldRules = vi.fn()

vi.mock('../../src/services/withdrawalPayoutRailConfig.service', () => ({
  withdrawalPayoutRailConfigService: {
    assertRailEnabled: (...a: unknown[]) => assertRailEnabled(...a),
    getPublicConfig: (...a: unknown[]) => getPublicConfig(...a),
    getBankFieldRules: (...a: unknown[]) => getBankFieldRules(...a),
  },
}))

vi.mock('../../src/services/security-password.service', () => ({
  securityPasswordService: {
    verifyCurrentPassword: (...a: unknown[]) => verifyCurrentPassword(...a),
  },
}))

vi.mock('../../src/repositories/userPaymentMethod.repository', () => ({
  userPaymentMethodRepository: {
    upsert: (...a: unknown[]) => upsert(...a),
    upsertBank: (...a: unknown[]) => upsertBank(...a),
    findById: (...a: unknown[]) => findById(...a),
    findAllForUser: vi.fn(),
    deleteByUserAndType: vi.fn(),
    touchLastUsed: vi.fn(),
  },
}))

vi.mock('../../src/repositories/withdrawal.repository', () => ({
  withdrawalRepository: { hasPendingWithdrawalUsingMethod: vi.fn() },
}))

vi.mock('../../src/utils/payment-method-mask', () => ({
  maskPaymentMethodForDisplay: vi.fn(),
  maskAccountNumber: vi.fn(),
  maskEmail: vi.fn(),
  mapPaymentMethodFull: vi.fn(),
}))

vi.mock('../../src/utils/txRetry', () => ({
  isUniqueViolation: () => false,
}))

import { AppError } from '../../src/middlewares/errorHandler'
import { userPaymentMethodRepository } from '../../src/repositories/userPaymentMethod.repository'
import { mapPaymentMethodFull } from '../../src/utils/payment-method-mask'
import { userPaymentMethodService } from '../../src/services/userPaymentMethod.service'
import { defaultBankFieldRules } from '../../src/utils/bank-field-rules'

describe('userPaymentMethodService bind rail gate', () => {
  beforeEach(() => {
    assertRailEnabled.mockReset()
    verifyCurrentPassword.mockReset().mockResolvedValue(undefined)
    upsert.mockReset().mockResolvedValue({})
    upsertBank.mockReset().mockResolvedValue({})
    getPublicConfig.mockReset()
    getBankFieldRules.mockReset().mockResolvedValue(defaultBankFieldRules())
    vi.mocked(userPaymentMethodRepository.findAllForUser).mockReset()
  })

  it('bindBank rejects invalid fields with 400 before checking the PIN', async () => {
    await expect(
      userPaymentMethodService.bindBank(
        'u1',
        { firstName: 'A', lastName: 'B', bankName: 'PNB', ifscCode: '!!!!', accountNumber: '1701500001180' },
        'pin',
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' })
    expect(verifyCurrentPassword).not.toHaveBeenCalled()
    expect(upsertBank).not.toHaveBeenCalled()
  })

  it('bindBank stores normalised values when the form is valid', async () => {
    await userPaymentMethodService.bindBank(
      'u1',
      { firstName: 'A', lastName: 'B', bankName: 'PNB', ifscCode: 'punb0178400', accountNumber: '1701500001180' },
      'pin',
    )
    expect(verifyCurrentPassword).toHaveBeenCalledWith('u1', 'pin')
    expect(upsertBank).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ ifscCode: 'PUNB0178400', accountNumber: '1701500001180' }),
    )
  })

  it('bindEpay rejects when rail disabled', async () => {
    assertRailEnabled.mockRejectedValue(
      new AppError(403, 'EPAY payment method is currently disabled', 'PAYMENT_METHOD_DISABLED'),
    )
    await expect(
      userPaymentMethodService.bindEpay('u1', { epayEmail: 'a@b.com' }, 'pin'),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_DISABLED', statusCode: 403 })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('bindBank rejects when rail disabled', async () => {
    assertRailEnabled.mockRejectedValue(
      new AppError(403, 'BANK payment method is currently disabled', 'PAYMENT_METHOD_DISABLED'),
    )
    await expect(
      userPaymentMethodService.bindBank(
        'u1',
        {
          firstName: 'A',
          lastName: 'B',
          bankName: 'X',
          ifscCode: 'ABCD0123456',
          accountNumber: '123',
        } as never,
        'pin',
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_DISABLED' })
    expect(upsertBank).not.toHaveBeenCalled()
  })
})

describe('userPaymentMethodService.getMyMethods', () => {
  beforeEach(() => {
    getPublicConfig.mockReset()
    vi.mocked(userPaymentMethodRepository.findAllForUser).mockReset()
    vi.mocked(mapPaymentMethodFull).mockReset()
  })

  it('always returns EPAY and BANK including disabled unbound rail with fees', async () => {
    const { redisClient } = await import('../../src/config/redis')
    vi.mocked(redisClient.get).mockResolvedValue(null)
    getPublicConfig.mockResolvedValue({
      epay: { feeRateBp: 600, feePercent: 6, arrivalTime: 'Within 24 hours', enabled: false },
      bank: { feeRateBp: 700, feePercent: 7, arrivalTime: '3-5 days', enabled: true },
      bankFields: [],
      updatedAt: '2026-08-09T00:00:00.000Z',
    })
    vi.mocked(userPaymentMethodRepository.findAllForUser).mockResolvedValue([
      {
        id: 'pm-bank',
        userId: 'u1',
        methodType: 'BANK',
        epayEmail: null,
        bankName: 'HDFC',
        bankAccountHolder: null,
        accountHolderFirstName: 'A',
        accountHolderLastName: 'B',
        branch: null,
        bankAccountNumber: '12345',
        bankIfscCode: 'HDFC0001',
        upiNumber: null,
        registeredPhone: null,
        registeredEmail: null,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never)
    vi.mocked(mapPaymentMethodFull).mockReturnValue({
      methodType: 'BANK',
      firstName: 'A',
      lastName: 'B',
      holderName: 'A B',
      bankName: 'HDFC',
      branch: null,
      accountNumber: '12345',
      ifscCode: 'HDFC0001',
      phone: null,
      upiId: null,
      email: null,
    })

    const result = await userPaymentMethodService.getMyMethods('u1')
    expect(result.methods).toHaveLength(2)
    expect(result.methods[0]).toMatchObject({
      methodType: 'EPAY',
      bound: false,
      id: null,
      enabled: false,
      feePercent: 6,
    })
    expect(result.methods[1]).toMatchObject({
      methodType: 'BANK',
      bound: true,
      id: 'pm-bank',
      enabled: true,
      feePercent: 7,
      bankName: 'HDFC',
    })
  })
})
