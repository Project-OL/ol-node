import { prisma, prismaRead } from '../config/database'

export type OtpDeliveryAuditCreateInput = {
  userId?: string | null
  purpose: string
  means: string
  provider?: string | null
  status: string
  targetType: string
  targetMasked: string
  country?: string | null
  chargeMinor: number
  chargeCurrency: string
  providerMessageId?: string | null
  fallbackFrom?: string | null
  routeReason?: string | null
  error?: string | null
}

export type OtpDeliveryAuditListFilters = {
  purpose?: string
  means?: string
  status?: string
  userId?: string
  country?: string
  from?: Date
  to?: Date
  page: number
  limit: number
}

function buildWhere(filters: Omit<OtpDeliveryAuditListFilters, 'page' | 'limit'>) {
  return {
    ...(filters.purpose ? { purpose: filters.purpose } : {}),
    ...(filters.means ? { means: filters.means } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.country ? { country: filters.country } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            // Half-open [from, to) — same as costs/by-country UTC month windows.
            ...(filters.to ? { lt: filters.to } : {}),
          },
        }
      : {}),
  }
}

export const otpDeliveryAuditRepository = {
  async create(data: OtpDeliveryAuditCreateInput) {
    return prisma.otpDeliveryAudit.create({
      data: {
        userId: data.userId ?? undefined,
        purpose: data.purpose,
        means: data.means,
        provider: data.provider ?? undefined,
        status: data.status,
        targetType: data.targetType,
        targetMasked: data.targetMasked,
        country: data.country ?? undefined,
        chargeMinor: data.chargeMinor,
        chargeCurrency: data.chargeCurrency,
        providerMessageId: data.providerMessageId ?? undefined,
        fallbackFrom: data.fallbackFrom ?? undefined,
        routeReason: data.routeReason ?? undefined,
        error: data.error ?? undefined,
      },
    })
  },

  async list(filters: OtpDeliveryAuditListFilters) {
    const where = buildWhere(filters)
    const skip = (filters.page - 1) * filters.limit
    const [total, rows] = await Promise.all([
      prismaRead.otpDeliveryAudit.count({ where }),
      prismaRead.otpDeliveryAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: filters.limit,
        select: {
          id: true,
          userId: true,
          purpose: true,
          means: true,
          provider: true,
          status: true,
          targetType: true,
          targetMasked: true,
          country: true,
          chargeMinor: true,
          chargeCurrency: true,
          providerMessageId: true,
          fallbackFrom: true,
          routeReason: true,
          error: true,
          createdAt: true,
        },
      }),
    ])
    return { total, rows }
  },

  async summarize(filters: Omit<OtpDeliveryAuditListFilters, 'page' | 'limit'>) {
    const where = buildWhere(filters)
    const [byMeans, byPurpose, totals] = await Promise.all([
      prismaRead.otpDeliveryAudit.groupBy({
        by: ['means'],
        where,
        _count: { _all: true },
        _sum: { chargeMinor: true },
      }),
      prismaRead.otpDeliveryAudit.groupBy({
        by: ['purpose'],
        where,
        _count: { _all: true },
        _sum: { chargeMinor: true },
      }),
      prismaRead.otpDeliveryAudit.aggregate({
        where,
        _count: { _all: true },
        _sum: { chargeMinor: true },
      }),
    ])
    return { byMeans, byPurpose, totals }
  },

  /** Successful delivery totals grouped by means inside [from, to). */
  async costsByMeansInRange(from: Date, to: Date) {
    return prismaRead.otpDeliveryAudit.groupBy({
      by: ['means'],
      where: {
        status: 'success',
        means: { in: ['email', 'whatsapp', 'sms'] },
        createdAt: { gte: from, lt: to },
      },
      _count: { _all: true },
      _sum: { chargeMinor: true },
    })
  },

  /** Successful delivery totals grouped by country × means inside [from, to). */
  async costsByCountryAndMeansInRange(from: Date, to: Date) {
    return prismaRead.otpDeliveryAudit.groupBy({
      by: ['country', 'means'],
      where: {
        status: 'success',
        means: { in: ['email', 'whatsapp', 'sms'] },
        createdAt: { gte: from, lt: to },
      },
      _count: { _all: true },
      _sum: { chargeMinor: true },
    })
  },
}
