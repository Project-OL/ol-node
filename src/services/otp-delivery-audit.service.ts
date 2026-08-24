import { env } from '../config/env'
import { prisma } from '../config/database'
import type { OtpDeliveryAuditStatus, OtpDeliveryMeans } from '../models/otp-delivery-audit.schemas'
import type { OtpPurpose } from '../models/types'
import { otpDeliveryAuditRepository } from '../repositories/otpDeliveryAudit.repository'
import type { OtpProviderName } from './providers/provider.types'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'otp-delivery-audit' })

export type { OtpDeliveryAuditStatus, OtpDeliveryMeans }

const BILLABLE_MEANS = ['email', 'whatsapp', 'sms'] as const

export function meansFromProvider(provider: OtpProviderName): Exclude<OtpDeliveryMeans, 'none'> {
  if (provider === 'ses_email') return 'email'
  if (provider === 'msg91_whatsapp') return 'whatsapp'
  return 'sms'
}

export function otpDeliveryCostRates() {
  return {
    currency: env.OTP_COST_CURRENCY.toUpperCase(),
    emailMinor: env.OTP_COST_EMAIL_MINOR,
    whatsappMinor: env.OTP_COST_WHATSAPP_MINOR,
    smsMinor: env.OTP_COST_SMS_MINOR,
  }
}

export function chargeMinorForMeans(means: OtpDeliveryMeans): number {
  const rates = otpDeliveryCostRates()
  if (means === 'email') return rates.emailMinor
  if (means === 'whatsapp') return rates.whatsappMinor
  if (means === 'sms') return rates.smsMinor
  return 0
}

/** UTC calendar month window: [start, end). Defaults to current UTC month. */
export function utcMonthRange(
  year?: number,
  month?: number,
): {
  year: number
  month: number
  from: Date
  to: Date
} {
  const now = new Date()
  const y = year ?? now.getUTCFullYear()
  const m = month ?? now.getUTCMonth() + 1
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0))
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0))
  return { year: y, month: m, from, to }
}

type MeansCostBucket = { count: number; chargeMinor: number }

function emptyMeansBuckets(): Record<(typeof BILLABLE_MEANS)[number], MeansCostBucket> {
  return {
    email: { count: 0, chargeMinor: 0 },
    whatsapp: { count: 0, chargeMinor: 0 },
    sms: { count: 0, chargeMinor: 0 },
  }
}

function fillMeansBuckets(
  rows: Array<{ means: string; _count: { _all: number }; _sum: { chargeMinor: number | null } }>,
): {
  byMeans: Record<(typeof BILLABLE_MEANS)[number], MeansCostBucket>
  totalCount: number
  totalChargeMinor: number
} {
  const byMeans = emptyMeansBuckets()
  let totalCount = 0
  let totalChargeMinor = 0
  for (const row of rows) {
    if (!(BILLABLE_MEANS as readonly string[]).includes(row.means)) continue
    const means = row.means as (typeof BILLABLE_MEANS)[number]
    const count = row._count._all
    const chargeMinor = row._sum.chargeMinor ?? 0
    byMeans[means] = { count, chargeMinor }
    totalCount += count
    totalChargeMinor += chargeMinor
  }
  return { byMeans, totalCount, totalChargeMinor }
}

export type OtpDeliveryAuditListItem = {
  id: string
  userId: string | null
  purpose: string
  flow: string
  means: string
  provider: string | null
  status: string
  targetType: string
  targetMasked: string
  country: string | null
  chargeMinor: number
  chargeCurrency: string
  providerMessageId: string | null
  fallbackFrom: string | null
  routeReason: string | null
  error: string | null
  createdAt: string
}

function toListItem(row: {
  id: string
  userId: string | null
  purpose: string
  means: string
  provider: string | null
  status: string
  targetType: string
  targetMasked: string
  country: string | null
  chargeMinor: number
  chargeCurrency: string
  providerMessageId: string | null
  fallbackFrom: string | null
  routeReason: string | null
  error: string | null
  createdAt: Date
}): OtpDeliveryAuditListItem {
  return {
    id: row.id,
    userId: row.userId,
    purpose: row.purpose,
    flow: row.purpose,
    means: row.means,
    provider: row.provider,
    status: row.status,
    targetType: row.targetType,
    targetMasked: row.targetMasked,
    country: row.country,
    chargeMinor: row.chargeMinor,
    chargeCurrency: row.chargeCurrency,
    providerMessageId: row.providerMessageId,
    fallbackFrom: row.fallbackFrom,
    routeReason: row.routeReason,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }
}

export const otpDeliveryAuditService = {
  /**
   * Persist one delivery audit row. Fire-and-forget so provider latency is unaffected;
   * failures are logged only.
   */
  record(params: {
    userId?: string | null
    purpose: OtpPurpose
    means: OtpDeliveryMeans
    provider?: OtpProviderName | null
    status: OtpDeliveryAuditStatus
    targetType: 'email' | 'phone'
    targetMasked: string
    country?: string | null
    providerMessageId?: string
    fallbackFrom?: OtpProviderName
    routeReason?: string
    error?: string
  }) {
    const charged = params.status === 'success' ? chargeMinorForMeans(params.means) : 0
    const rates = otpDeliveryCostRates()
    void (async () => {
      let country = params.country?.trim() || null
      if (!country && params.userId) {
        try {
          const user = await prisma.user.findUnique({
            where: { id: params.userId },
            select: { country: true },
          })
          country = user?.country?.trim() || null
        } catch {
          /* keep null */
        }
      }
      await otpDeliveryAuditRepository.create({
        userId: params.userId,
        purpose: params.purpose,
        means: params.means,
        provider: params.provider ?? null,
        status: params.status,
        targetType: params.targetType,
        targetMasked: params.targetMasked,
        country: country ? country.slice(0, 100) : null,
        chargeMinor: charged,
        chargeCurrency: rates.currency,
        providerMessageId: params.providerMessageId ?? null,
        fallbackFrom: params.fallbackFrom ?? null,
        routeReason: params.routeReason ?? null,
        error: params.error ? params.error.slice(0, 500) : null,
      })
    })().catch((err) => log.error({ err }, 'OTP delivery audit persist failed'))
  },

  getCostRates() {
    const rates = otpDeliveryCostRates()
    return {
      currency: rates.currency,
      rates: {
        email: rates.emailMinor,
        whatsapp: rates.whatsappMinor,
        sms: rates.smsMinor,
        none: 0,
      },
      note: 'Amounts are minor currency units (e.g. paise when currency is INR). Charged only on successful delivery.',
    }
  },

  async list(filters: {
    purpose?: string
    means?: string
    status?: string
    userId?: string
    country?: string
    from?: Date
    to?: Date
    year?: number
    month?: number
    page: number
    limit: number
  }) {
    const range = resolveUtcListRange(filters)
    const { total, rows } = await otpDeliveryAuditRepository.list({
      ...filters,
      from: range.from,
      to: range.to,
    })
    return {
      timezone: 'UTC' as const,
      ...(range.year != null && range.month != null
        ? {
            year: range.year,
            month: range.month,
            from: range.from!.toISOString(),
            to: range.to!.toISOString(),
          }
        : range.from || range.to
          ? {
              ...(range.from ? { from: range.from.toISOString() } : {}),
              ...(range.to ? { to: range.to.toISOString() } : {}),
            }
          : {}),
      page: filters.page,
      limit: filters.limit,
      total,
      items: rows.map(toListItem),
    }
  },

  async summarize(filters: {
    purpose?: string
    means?: string
    status?: string
    userId?: string
    country?: string
    from?: Date
    to?: Date
    year?: number
    month?: number
  }) {
    const range = resolveUtcListRange(filters)
    const { byMeans, byPurpose, totals } = await otpDeliveryAuditRepository.summarize({
      ...filters,
      from: range.from,
      to: range.to,
    })
    const currency = otpDeliveryCostRates().currency
    return {
      timezone: 'UTC' as const,
      ...(range.year != null && range.month != null
        ? {
            year: range.year,
            month: range.month,
            from: range.from!.toISOString(),
            to: range.to!.toISOString(),
          }
        : range.from || range.to
          ? {
              ...(range.from ? { from: range.from.toISOString() } : {}),
              ...(range.to ? { to: range.to.toISOString() } : {}),
            }
          : {}),
      currency,
      totalCount: totals._count._all,
      totalChargeMinor: totals._sum.chargeMinor ?? 0,
      byMeans: byMeans.map((row) => ({
        means: row.means,
        count: row._count._all,
        chargeMinor: row._sum.chargeMinor ?? 0,
      })),
      byPurpose: byPurpose.map((row) => ({
        purpose: row.purpose,
        flow: row.purpose,
        count: row._count._all,
        chargeMinor: row._sum.chargeMinor ?? 0,
      })),
    }
  },

  /**
   * Monthly OTP cost rollup by channel (email / WhatsApp / SMS).
   * Defaults to the current UTC calendar month.
   */
  async monthlyCosts(params: { year?: number; month?: number }) {
    const { year, month, from, to } = utcMonthRange(params.year, params.month)
    const rows = await otpDeliveryAuditRepository.costsByMeansInRange(from, to)
    const { byMeans, totalCount, totalChargeMinor } = fillMeansBuckets(rows)
    return {
      timezone: 'UTC' as const,
      year,
      month,
      from: from.toISOString(),
      to: to.toISOString(),
      currency: otpDeliveryCostRates().currency,
      byMeans,
      totalCount,
      totalChargeMinor,
    }
  },

  /**
   * Per-country table rows: cost/count for each OTP means in a UTC month.
   */
  async costsByCountry(params: { year?: number; month?: number }) {
    const { year, month, from, to } = utcMonthRange(params.year, params.month)
    const rows = await otpDeliveryAuditRepository.costsByCountryAndMeansInRange(from, to)
    const map = new Map<
      string,
      {
        country: string
        email: MeansCostBucket
        whatsapp: MeansCostBucket
        sms: MeansCostBucket
        totalCount: number
        totalChargeMinor: number
      }
    >()

    for (const row of rows) {
      const countryKey = row.country?.trim() || 'UNKNOWN'
      let entry = map.get(countryKey)
      if (!entry) {
        entry = {
          country: countryKey,
          ...emptyMeansBuckets(),
          totalCount: 0,
          totalChargeMinor: 0,
        }
        map.set(countryKey, entry)
      }
      if (!(BILLABLE_MEANS as readonly string[]).includes(row.means)) continue
      const means = row.means as (typeof BILLABLE_MEANS)[number]
      const count = row._count._all
      const chargeMinor = row._sum.chargeMinor ?? 0
      entry[means] = { count, chargeMinor }
      entry.totalCount += count
      entry.totalChargeMinor += chargeMinor
    }

    const countries = [...map.values()].sort((a, b) => {
      if (b.totalChargeMinor !== a.totalChargeMinor) return b.totalChargeMinor - a.totalChargeMinor
      return a.country.localeCompare(b.country)
    })

    const monthTotals = fillMeansBuckets(rows)

    return {
      timezone: 'UTC' as const,
      year,
      month,
      from: from.toISOString(),
      to: to.toISOString(),
      currency: otpDeliveryCostRates().currency,
      totalCount: monthTotals.totalCount,
      totalChargeMinor: monthTotals.totalChargeMinor,
      byMeans: monthTotals.byMeans,
      countries,
    }
  },
}

/** Resolve list/summary time window. Prefer year+month (UTC calendar month) over from/to. */
function resolveUtcListRange(filters: { from?: Date; to?: Date; year?: number; month?: number }): {
  from?: Date
  to?: Date
  year?: number
  month?: number
} {
  if (filters.year != null && filters.month != null) {
    const r = utcMonthRange(filters.year, filters.month)
    return { from: r.from, to: r.to, year: r.year, month: r.month }
  }
  return { from: filters.from, to: filters.to }
}
