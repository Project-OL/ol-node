import { env } from '../config/env'
import { prisma } from '../config/database'
import { OTP_COST_RATES_TTL, RedisKeys, redisClient } from '../config/redis'
import type { OtpDeliveryAuditStatus, OtpDeliveryMeans } from '../models/otp-delivery-audit.schemas'
import type { OtpPurpose } from '../models/types'
import { otpDeliveryAuditRepository } from '../repositories/otpDeliveryAudit.repository'
import { otpCostRateRepository, type OtpCostRateRow } from '../repositories/otpCostRate.repository'
import type { OtpProviderName } from './providers/provider.types'
import { rootLogger } from '../utils/rootLogger'
import { utcMonthRange } from '../utils/utc-month-range'

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

/** means -> country (upper-case ISO alpha-2) -> rate row */
type CountryRateMap = Map<string, Map<string, { rateMinor: number; currency: string }>>

function buildCountryRateMap(rows: OtpCostRateRow[]): CountryRateMap {
  const map: CountryRateMap = new Map()
  for (const row of rows) {
    const byCountry = map.get(row.means) ?? new Map()
    byCountry.set(row.country.toUpperCase(), { rateMinor: row.rateMinor, currency: row.currency })
    map.set(row.means, byCountry)
  }
  return map
}

async function getCountryRateMap(): Promise<CountryRateMap> {
  const key = RedisKeys.otpCostRates()
  try {
    const hit = await redisClient.get(key)
    if (hit) return buildCountryRateMap(JSON.parse(hit) as OtpCostRateRow[])
  } catch {
    /* miss */
  }

  const rows = await otpCostRateRepository.findAll()
  try {
    await redisClient.setex(key, OTP_COST_RATES_TTL, JSON.stringify(rows))
  } catch {
    /* ignore */
  }
  return buildCountryRateMap(rows)
}

async function bustCountryRateCache() {
  await redisClient.del(RedisKeys.otpCostRates())
}

/**
 * Resolve the charge for one delivery. WhatsApp/SMS pricing varies by destination
 * country (Meta conversation pricing, carrier termination rates), so a country-specific
 * `otp_cost_rates` override wins; falling back to the flat env default (`OTP_COST_*`)
 * when no override is configured for that country. Email stays flat — SES pricing does
 * not vary by recipient country in this integration.
 */
export async function resolveOtpCharge(
  means: OtpDeliveryMeans,
  country?: string | null,
): Promise<{ chargeMinor: number; currency: string }> {
  const rates = otpDeliveryCostRates()
  if (means === 'email') return { chargeMinor: rates.emailMinor, currency: rates.currency }
  if (means === 'none') return { chargeMinor: 0, currency: rates.currency }

  const normalizedCountry = country?.trim().toUpperCase() || null
  if (normalizedCountry) {
    const map = await getCountryRateMap()
    const override = map.get(means)?.get(normalizedCountry)
    if (override) return { chargeMinor: override.rateMinor, currency: override.currency }
  }

  return {
    chargeMinor: means === 'whatsapp' ? rates.whatsappMinor : rates.smsMinor,
    currency: rates.currency,
  }
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
      const { chargeMinor, currency } =
        params.status === 'success'
          ? await resolveOtpCharge(params.means, country)
          : { chargeMinor: 0, currency: otpDeliveryCostRates().currency }
      await otpDeliveryAuditRepository.create({
        userId: params.userId,
        purpose: params.purpose,
        means: params.means,
        provider: params.provider ?? null,
        status: params.status,
        targetType: params.targetType,
        targetMasked: params.targetMasked,
        country: country ? country.slice(0, 100) : null,
        chargeMinor,
        chargeCurrency: currency,
        providerMessageId: params.providerMessageId ?? null,
        fallbackFrom: params.fallbackFrom ?? null,
        routeReason: params.routeReason ?? null,
        error: params.error ? params.error.slice(0, 500) : null,
      })
    })().catch((err) => log.error({ err }, 'OTP delivery audit persist failed'))
  },

  async getCostRates() {
    const rates = otpDeliveryCostRates()
    const countryOverrides = await otpCostRateRepository.findAll()
    return {
      currency: rates.currency,
      rates: {
        email: rates.emailMinor,
        whatsapp: rates.whatsappMinor,
        sms: rates.smsMinor,
        none: 0,
      },
      countryRates: countryOverrides.map((row) => ({
        means: row.means,
        country: row.country,
        rateMinor: row.rateMinor,
        currency: row.currency,
        updatedAt: row.updatedAt.toISOString(),
      })),
      note: 'Amounts are minor currency units (e.g. paise when currency is INR). Charged only on successful delivery. A countryRates entry overrides the flat rates.whatsapp/rates.sms default for that (means, country) — WhatsApp/SMS pricing varies by destination country; email stays flat.',
    }
  },

  /**
   * Upsert a per-country WhatsApp/SMS rate override. Busts the cached rate map.
   * Always stored in the global OTP_COST_CURRENCY — this system tracks one currency
   * at a time, so a mixed-currency override would break the summed monthly/by-country
   * totals the same way the old flat rate broke per-country totals.
   */
  async setCountryRate(params: {
    means: 'whatsapp' | 'sms'
    country: string
    rateMinor: number
    updatedByUserId?: string | null
  }) {
    const row = await otpCostRateRepository.upsert({
      means: params.means,
      country: params.country.trim().toUpperCase(),
      rateMinor: params.rateMinor,
      currency: otpDeliveryCostRates().currency,
      updatedByUserId: params.updatedByUserId,
    })
    await bustCountryRateCache()
    return {
      means: row.means,
      country: row.country,
      rateMinor: row.rateMinor,
      currency: row.currency,
      updatedAt: row.updatedAt.toISOString(),
    }
  },

  /** Remove a per-country override, reverting that country to the flat env default. */
  async deleteCountryRate(means: 'whatsapp' | 'sms', country: string) {
    await otpCostRateRepository.delete(means, country.trim().toUpperCase())
    await bustCountryRateCache()
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

    const rateMap = await getCountryRateMap()
    const defaults = otpDeliveryCostRates()
    const currentRateFor = (means: 'whatsapp' | 'sms', country: string): number =>
      rateMap.get(means)?.get(country)?.rateMinor ??
      (means === 'whatsapp' ? defaults.whatsappMinor : defaults.smsMinor)

    const countries = [...map.values()]
      .map((entry) => ({
        ...entry,
        // Rate that WOULD apply to a send today — for comparing against the historical
        // chargeMinor above (which stays whatever was true when each OTP was sent).
        // UNKNOWN has no country to look up, so it always reflects the flat env default.
        currentRates:
          entry.country === 'UNKNOWN'
            ? { whatsapp: defaults.whatsappMinor, sms: defaults.smsMinor }
            : { whatsapp: currentRateFor('whatsapp', entry.country), sms: currentRateFor('sms', entry.country) },
      }))
      .sort((a, b) => {
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
