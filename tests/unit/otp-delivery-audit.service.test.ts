import { describe, it, expect, vi, beforeEach } from 'vitest'

const create = vi.fn().mockResolvedValue({})
const list = vi.fn()
const summarize = vi.fn()
const costsByMeansInRange = vi.fn()
const costsByCountryAndMeansInRange = vi.fn()
const findUniqueUser = vi.fn()

vi.mock('../../src/repositories/otpDeliveryAudit.repository', () => ({
  otpDeliveryAuditRepository: {
    create: (...args: unknown[]) => create(...args),
    list: (...args: unknown[]) => list(...args),
    summarize: (...args: unknown[]) => summarize(...args),
    costsByMeansInRange: (...args: unknown[]) => costsByMeansInRange(...args),
    costsByCountryAndMeansInRange: (...args: unknown[]) =>
      costsByCountryAndMeansInRange(...args),
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUniqueUser(...args),
    },
  },
}))

vi.mock('../../src/config/env', () => ({
  env: {
    OTP_COST_CURRENCY: 'INR',
    OTP_COST_EMAIL_MINOR: 2,
    OTP_COST_WHATSAPP_MINOR: 25,
    OTP_COST_SMS_MINOR: 15,
  },
}))

vi.mock('../../src/utils/rootLogger', () => ({
  rootLogger: {
    child: () => ({
      error: vi.fn(),
    }),
  },
}))

const {
  chargeMinorForMeans,
  meansFromProvider,
  otpDeliveryAuditService,
  utcMonthRange,
} = await import('../../src/services/otp-delivery-audit.service')

describe('otpDeliveryAuditService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findUniqueUser.mockResolvedValue(null)
  })

  it('maps providers to means', () => {
    expect(meansFromProvider('ses_email')).toBe('email')
    expect(meansFromProvider('msg91_whatsapp')).toBe('whatsapp')
    expect(meansFromProvider('msg91_sms')).toBe('sms')
  })

  it('resolves configured charge by means', () => {
    expect(chargeMinorForMeans('email')).toBe(2)
    expect(chargeMinorForMeans('whatsapp')).toBe(25)
    expect(chargeMinorForMeans('sms')).toBe(15)
    expect(chargeMinorForMeans('none')).toBe(0)
  })

  it('builds UTC month ranges', () => {
    const range = utcMonthRange(2026, 7)
    expect(range.from.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(range.to.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('records success with charge and country', async () => {
    otpDeliveryAuditService.record({
      purpose: 'set_security_password',
      means: 'whatsapp',
      provider: 'msg91_whatsapp',
      status: 'success',
      targetType: 'phone',
      targetMasked: '******3210',
      country: 'IN',
      providerMessageId: 'wa-1',
    })

    await vi.waitFor(() => expect(create).toHaveBeenCalled())
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'set_security_password',
        means: 'whatsapp',
        status: 'success',
        chargeMinor: 25,
        chargeCurrency: 'INR',
        country: 'IN',
      }),
    )
  })

  it('resolves country from user when missing on email send', async () => {
    findUniqueUser.mockResolvedValue({ country: 'India' })
    otpDeliveryAuditService.record({
      userId: '11111111-1111-1111-1111-111111111111',
      purpose: 'bind_email',
      means: 'email',
      provider: 'ses_email',
      status: 'success',
      targetType: 'email',
      targetMasked: 'te***t@example.com',
    })

    await vi.waitFor(() => expect(create).toHaveBeenCalled())
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        country: 'India',
        chargeMinor: 2,
      }),
    )
  })

  it('monthlyCosts aggregates by means for a selected month', async () => {
    costsByMeansInRange.mockResolvedValue([
      { means: 'email', _count: { _all: 10 }, _sum: { chargeMinor: 20 } },
      { means: 'whatsapp', _count: { _all: 4 }, _sum: { chargeMinor: 100 } },
      { means: 'sms', _count: { _all: 2 }, _sum: { chargeMinor: 30 } },
    ])

    const result = await otpDeliveryAuditService.monthlyCosts({ year: 2026, month: 7 })
    expect(result).toMatchObject({
      year: 2026,
      month: 7,
      currency: 'INR',
      totalCount: 16,
      totalChargeMinor: 150,
      byMeans: {
        email: { count: 10, chargeMinor: 20 },
        whatsapp: { count: 4, chargeMinor: 100 },
        sms: { count: 2, chargeMinor: 30 },
      },
    })
    expect(costsByMeansInRange).toHaveBeenCalledWith(
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-08-01T00:00:00.000Z'),
    )
  })

  it('costsByCountry pivots means into table rows', async () => {
    costsByCountryAndMeansInRange.mockResolvedValue([
      { country: 'IN', means: 'whatsapp', _count: { _all: 3 }, _sum: { chargeMinor: 75 } },
      { country: 'IN', means: 'sms', _count: { _all: 1 }, _sum: { chargeMinor: 15 } },
      { country: null, means: 'email', _count: { _all: 2 }, _sum: { chargeMinor: 4 } },
    ])

    const result = await otpDeliveryAuditService.costsByCountry({ year: 2026, month: 7 })
    expect(result.countries).toEqual([
      {
        country: 'IN',
        email: { count: 0, chargeMinor: 0 },
        whatsapp: { count: 3, chargeMinor: 75 },
        sms: { count: 1, chargeMinor: 15 },
        totalCount: 4,
        totalChargeMinor: 90,
      },
      {
        country: 'UNKNOWN',
        email: { count: 2, chargeMinor: 4 },
        whatsapp: { count: 0, chargeMinor: 0 },
        sms: { count: 0, chargeMinor: 0 },
        totalCount: 2,
        totalChargeMinor: 4,
      },
    ])
    expect(result.totalChargeMinor).toBe(94)
  })

  it('lists audits with country field', async () => {
    list.mockResolvedValue({
      total: 1,
      rows: [
        {
          id: 'a1',
          userId: null,
          purpose: 'modify_phone',
          means: 'sms',
          provider: 'msg91_sms',
          status: 'success',
          targetType: 'phone',
          targetMasked: '******9999',
          country: 'IN',
          chargeMinor: 15,
          chargeCurrency: 'INR',
          providerMessageId: 'sms-1',
          fallbackFrom: null,
          routeReason: 'sms_request_threshold',
          error: null,
          createdAt: new Date('2026-07-15T00:00:00.000Z'),
        },
      ],
    })

    const result = await otpDeliveryAuditService.list({ page: 1, limit: 20 })
    expect(result.items[0]).toMatchObject({
      flow: 'modify_phone',
      means: 'sms',
      country: 'IN',
      chargeMinor: 15,
    })
  })
})
