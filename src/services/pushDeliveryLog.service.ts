import {
  Prisma,
  PushDeliverySource,
  PushDeliveryStatus,
  type PushDeliveryLog,
} from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'push-delivery-log' })

export type PushDeliveryLogInput = {
  userId: string
  adminUserId?: string | null
  source: PushDeliverySource
  status: PushDeliveryStatus
  campaignId?: string | null
  title: string
  body: string
  data?: Record<string, string> | null
  errorCode?: string | null
}

function utcDayBounds(now = new Date()): { start: Date; end: Date; date: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  const date = start.toISOString().slice(0, 10)
  return { start, end, date }
}

export const pushDeliveryLogService = {
  async record(entry: PushDeliveryLogInput): Promise<void> {
    try {
      await prisma.pushDeliveryLog.create({
        data: {
          userId: entry.userId,
          adminUserId: entry.adminUserId ?? null,
          source: entry.source,
          status: entry.status,
          campaignId: entry.campaignId ?? null,
          title: entry.title.slice(0, 200),
          body: entry.body.slice(0, 1000),
          data: entry.data ?? undefined,
          errorCode: entry.errorCode ?? null,
        },
      })
    } catch (err) {
      log.warn(
        { err, userId: entry.userId, source: entry.source },
        'push delivery log write failed',
      )
    }
  },

  async recordMany(entries: PushDeliveryLogInput[]): Promise<void> {
    if (entries.length === 0) return
    try {
      await prisma.pushDeliveryLog.createMany({
        data: entries.map((entry) => ({
          userId: entry.userId,
          adminUserId: entry.adminUserId ?? null,
          source: entry.source,
          status: entry.status,
          campaignId: entry.campaignId ?? null,
          title: entry.title.slice(0, 200),
          body: entry.body.slice(0, 1000),
          data: (entry.data ?? undefined) as Prisma.InputJsonValue | undefined,
          errorCode: entry.errorCode ?? null,
        })),
      })
    } catch (err) {
      log.warn({ err, count: entries.length }, 'push delivery log bulk write failed')
    }
  },

  async getTodayStats(): Promise<{
    date: string
    timezone: 'UTC'
    sent: number
    failed: number
    skipped: number
    total: number
    bySource: Record<string, { sent: number; failed: number; skipped: number; total: number }>
  }> {
    const { start, end, date } = utcDayBounds()
    const rows = await prismaRead.pushDeliveryLog.groupBy({
      by: ['status', 'source'],
      where: { createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    })

    let sent = 0
    let failed = 0
    let skipped = 0
    const bySource: Record<
      string,
      { sent: number; failed: number; skipped: number; total: number }
    > = {}

    for (const row of rows) {
      const n = row._count._all
      if (row.status === PushDeliveryStatus.SENT) sent += n
      else if (row.status === PushDeliveryStatus.FAILED) failed += n
      else skipped += n

      const bucket = bySource[row.source] ?? { sent: 0, failed: 0, skipped: 0, total: 0 }
      if (row.status === PushDeliveryStatus.SENT) bucket.sent += n
      else if (row.status === PushDeliveryStatus.FAILED) bucket.failed += n
      else bucket.skipped += n
      bucket.total += n
      bySource[row.source] = bucket
    }

    return {
      date,
      timezone: 'UTC',
      sent,
      failed,
      skipped,
      total: sent + failed + skipped,
      bySource,
    }
  },

  async listDeliveries(params: {
    page: number
    limit: number
    status?: PushDeliveryStatus
    source?: PushDeliverySource
    /** When true (default for "today" dashboards), restrict to current UTC day. */
    todayOnly?: boolean
    campaignId?: string
  }): Promise<{
    deliveries: Array<{
      id: string
      status: PushDeliveryStatus
      source: PushDeliverySource
      campaignId: string | null
      title: string
      body: string
      data: Record<string, string> | null
      errorCode: string | null
      adminUserId: string | null
      createdAt: string
      user: {
        userId: string
        username: string
        name: string
        publicId: string
        displayPublicId: string
        avatarUrl: string | null
        country: string | null
        status: string
      }
    }>
    pagination: { page: number; limit: number; total: number; hasMore: boolean }
  }> {
    const where: Prisma.PushDeliveryLogWhereInput = {}
    if (params.status) where.status = params.status
    if (params.source) where.source = params.source
    if (params.campaignId) where.campaignId = params.campaignId
    if (params.todayOnly !== false) {
      const { start, end } = utcDayBounds()
      where.createdAt = { gte: start, lt: end }
    }

    const skip = (params.page - 1) * params.limit
    const [total, rows] = await Promise.all([
      prismaRead.pushDeliveryLog.count({ where }),
      prismaRead.pushDeliveryLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              publicId: true,
              defaultPublicId: true,
              currentVipPublicId: true,
              avatarUrl: true,
              country: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: params.limit,
      }),
    ])

    return {
      deliveries: rows.map((row) => mapDelivery(row)),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        hasMore: skip + rows.length < total,
      },
    }
  },
}

function mapDelivery(
  row: PushDeliveryLog & {
    user: {
      id: string
      username: string
      firstName: string | null
      lastName: string | null
      publicId: bigint
      defaultPublicId: bigint
      currentVipPublicId: bigint | null
      avatarUrl: string | null
      country: string | null
      status: string
    }
  },
) {
  const data =
    row.data && typeof row.data === 'object' && !Array.isArray(row.data)
      ? (Object.fromEntries(
          Object.entries(row.data as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        ) as Record<string, string>)
      : null

  return {
    id: row.id,
    status: row.status,
    source: row.source,
    campaignId: row.campaignId,
    title: row.title,
    body: row.body,
    data,
    errorCode: row.errorCode,
    adminUserId: row.adminUserId,
    createdAt: row.createdAt.toISOString(),
    user: {
      userId: row.user.id,
      username: row.user.username,
      name: formatUserName(row.user),
      publicId: row.user.publicId.toString(),
      displayPublicId: resolveDisplayPublicId(row.user),
      avatarUrl: row.user.avatarUrl,
      country: row.user.country,
      status: row.user.status,
    },
  }
}
