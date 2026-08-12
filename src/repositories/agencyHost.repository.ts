import { Prisma, type AgencyHostHistoryReason } from '@prisma/client'
import { prismaRead } from '../config/database'
import { addUtcDays } from '../utils/datetime'

export const agencyHostRepository = {
  async insertHost(
    data: { agencyUserId: string; hostUserId: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agencyHost.create({
      data: {
        agencyUserId: data.agencyUserId,
        hostUserId: data.hostUserId,
      },
    })
  },

  async removeHost(hostUserId: string, tx: Prisma.TransactionClient) {
    return tx.agencyHost.delete({
      where: { hostUserId },
    })
  },

  async getHost(hostUserId: string) {
    return prismaRead.agencyHost.findUnique({
      where: { hostUserId },
    })
  },

  async getHostWithAgency(hostUserId: string) {
    return prismaRead.agencyHost.findUnique({
      where: { hostUserId },
      include: {
        agency: {
          include: {
            user: { select: { avatarUrl: true, firstName: true, lastName: true } },
          },
        },
      },
    })
  },

  async listHosts(agencyUserId: string, params: { limit: number; cursor?: string | null }) {
    let cursor: { joinedAt: Date; hostUserId: string } | null = null
    if (params.cursor) {
      const parts = params.cursor.split('|')
      if (parts.length === 2 && parts[0] && parts[1]) {
        cursor = { joinedAt: new Date(parts[0]), hostUserId: parts[1] }
      }
    }

    const where: Prisma.AgencyHostWhereInput = cursor
      ? {
          agencyUserId,
          OR: [
            { joinedAt: { lt: cursor.joinedAt } },
            {
              joinedAt: cursor.joinedAt,
              hostUserId: { lt: cursor.hostUserId },
            },
          ],
        }
      : { agencyUserId }

    return prismaRead.agencyHost.findMany({
      where,
      orderBy: [{ joinedAt: 'desc' }, { hostUserId: 'desc' }],
      take: params.limit + 1,
      select: {
        hostUserId: true,
        joinedAt: true,
        host: {
          select: {
            id: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            gender: true,
            dateOfBirth: true,
            country: true,
            isTagged: true,
            hourlyWage: true,
          },
        },
      },
    })
  },

  /**
   * All-time per-host aggregates for the agency hosts list.
   * - `hostEarnings` ← `agency_daily_earnings.host_earnings_points`
   * - `hostCommission` ← unreversed `AGENT_COMMISSION` ledger credited to the agency
   *   for that host (`counterparty_id`) — amount actually processed to the agency
   * - `liveDurationSeconds` ← `live_streams` (ended − started), sessions since host
   *   joined this agency (webhook `host_live_sessions` path is unused in prod)
   *
   * Hosts with no rows across all sources are absent (callers default to zero).
   */
  async getHostEarningsAggregates(
    agencyUserId: string,
    hostUserIds: string[],
  ): Promise<
    Map<string, { hostEarnings: bigint; hostCommission: bigint; liveDurationSeconds: bigint }>
  > {
    return this.getHostEarningsAggregatesInRange(agencyUserId, hostUserIds)
  },

  /** Per-host aggregates; optional inclusive UTC day range. Missing hosts → absent from map. */
  async getHostEarningsAggregatesInRange(
    agencyUserId: string,
    hostUserIds: string[],
    fromDay?: Date,
    toDay?: Date,
  ): Promise<
    Map<string, { hostEarnings: bigint; hostCommission: bigint; liveDurationSeconds: bigint }>
  > {
    const map = new Map<
      string,
      { hostEarnings: bigint; hostCommission: bigint; liveDurationSeconds: bigint }
    >()
    if (hostUserIds.length === 0) return map

    const ensure = (hostUserId: string) => {
      let row = map.get(hostUserId)
      if (!row) {
        row = { hostEarnings: 0n, hostCommission: 0n, liveDurationSeconds: 0n }
        map.set(hostUserId, row)
      }
      return row
    }

    const dayFilter =
      fromDay || toDay
        ? {
            day: {
              ...(fromDay ? { gte: fromDay } : {}),
              ...(toDay ? { lte: toDay } : {}),
            },
          }
        : {}

    const earningsRows = await prismaRead.agencyDailyEarning.groupBy({
      by: ['hostUserId'],
      where: {
        agencyUserId,
        hostUserId: { in: hostUserIds },
        ...dayFilter,
      },
      _sum: {
        hostEarningsPoints: true,
      },
    })

    for (const r of earningsRows) {
      ensure(r.hostUserId).hostEarnings = r._sum.hostEarningsPoints ?? 0n
    }

    // Half-open ledger / stream window from inclusive UTC calendar days.
    const fromAt = fromDay ?? null
    const toExclusive = toDay ? addUtcDays(toDay, 1) : null

    const commissionWhere: Prisma.PointLedgerEntryWhereInput = {
      txType: 'AGENT_COMMISSION',
      direction: 'CREDIT',
      counterpartyId: { in: hostUserIds },
      wallet: {
        userId: agencyUserId,
        currencyType: 'POINT',
      },
      ...(fromAt || toExclusive
        ? {
            createdAt: {
              ...(fromAt ? { gte: fromAt } : {}),
              ...(toExclusive ? { lt: toExclusive } : {}),
            },
          }
        : {}),
    }

    const commissionEntries = await prismaRead.pointLedgerEntry.findMany({
      where: commissionWhere,
      select: {
        amount: true,
        counterpartyId: true,
        idempotencyKey: true,
        metadata: true,
      },
    })

    // Omit credits that have a matching admin reverse debit.
    const reverseKeys = new Set(
      (
        await prismaRead.pointLedgerEntry.findMany({
          where: {
            idempotencyKey: {
              in: commissionEntries
                .map((e) => {
                  const meta = e.metadata as { hostLedgerEntryId?: string } | null
                  const hostLedgerId =
                    meta?.hostLedgerEntryId ??
                    (e.idempotencyKey?.startsWith('agency-commission:')
                      ? e.idempotencyKey.slice('agency-commission:'.length)
                      : null)
                  return hostLedgerId ? `agency-commission-reverse:${hostLedgerId}` : null
                })
                .filter((k): k is string => Boolean(k)),
            },
          },
          select: { idempotencyKey: true },
        })
      ).map((r) => r.idempotencyKey),
    )

    for (const e of commissionEntries) {
      if (!e.counterpartyId) continue
      const meta = e.metadata as { hostLedgerEntryId?: string } | null
      const hostLedgerId =
        meta?.hostLedgerEntryId ??
        (e.idempotencyKey?.startsWith('agency-commission:')
          ? e.idempotencyKey.slice('agency-commission:'.length)
          : null)
      if (hostLedgerId && reverseKeys.has(`agency-commission-reverse:${hostLedgerId}`)) {
        continue
      }
      ensure(e.counterpartyId).hostCommission += e.amount
    }

    // Duration from live_streams since joining this agency (source of truth).
    const memberships = await prismaRead.agencyHost.findMany({
      where: { agencyUserId, hostUserId: { in: hostUserIds } },
      select: { hostUserId: true, joinedAt: true },
    })
    const joinedAtByHost = new Map(memberships.map((m) => [m.hostUserId, m.joinedAt]))

    const streams = await prismaRead.liveStream.findMany({
      where: {
        userId: { in: hostUserIds },
        startedAt: {
          not: null,
          ...(fromAt ? { gte: fromAt } : {}),
          ...(toExclusive ? { lt: toExclusive } : {}),
        },
        endedAt: { not: null },
      },
      select: { userId: true, startedAt: true, endedAt: true },
    })

    for (const s of streams) {
      if (!s.startedAt || !s.endedAt || s.endedAt <= s.startedAt) continue
      const joinedAt = joinedAtByHost.get(s.userId)
      if (!joinedAt || s.startedAt < joinedAt) continue
      const secs = BigInt(Math.floor((s.endedAt.getTime() - s.startedAt.getTime()) / 1000))
      if (secs > 0n) ensure(s.userId).liveDurationSeconds += secs
    }

    return map
  },

  async insertHistory(
    row: {
      agencyUserId: string
      hostUserId: string
      joinedAt: Date
      reason: AgencyHostHistoryReason
      exitMetadata?: Prisma.InputJsonValue | null
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agencyHostHistory.create({
      data: {
        agencyUserId: row.agencyUserId,
        hostUserId: row.hostUserId,
        joinedAt: row.joinedAt,
        reason: row.reason,
        exitMetadata: row.exitMetadata ?? undefined,
      },
    })
  },

  /** Most recent exit or join audit row for cooldown checks. */
  async getRecentExitForHost(hostUserId: string) {
    return prismaRead.agencyHostHistory.findFirst({
      where: { hostUserId },
      orderBy: { exitedAt: 'desc' },
    })
  },

  async countHostsForAgency(agencyUserId: string) {
    return prismaRead.agencyHost.count({
      where: { agencyUserId },
    })
  },

  async listHostUserIdsForAgency(agencyUserId: string) {
    return prismaRead.agencyHost.findMany({
      where: { agencyUserId },
      select: { hostUserId: true },
    })
  },

  async findLatestRejectedApplication(hostUserId: string) {
    return prismaRead.agencyHostApplication.findFirst({
      where: { hostUserId, status: 'REJECTED' },
      orderBy: { resolvedAt: 'desc' },
    })
  },

  async findLatestResolvedLeaveApplication(hostUserId: string) {
    return prismaRead.agencyLeaveApplication.findFirst({
      where: {
        hostUserId,
        status: { not: 'CANCELLED' },
        resolvedAt: { not: null },
      },
      orderBy: { resolvedAt: 'desc' },
    })
  },
}
