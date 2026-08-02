import type { AgencyHostHistoryReason, Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

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
            user: { select: { avatarUrl: true } },
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
            isTagged: true,
          },
        },
      },
    })
  },

  /**
   * All-time per-host earnings/commission/live-duration aggregates from
   * `agency_daily_earnings`, keyed by hostUserId. Hosts with no rows are absent
   * (callers default to zero).
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

    const rows = await prismaRead.agencyDailyEarning.groupBy({
      by: ['hostUserId'],
      where: {
        agencyUserId,
        hostUserId: { in: hostUserIds },
        ...(fromDay || toDay
          ? {
              day: {
                ...(fromDay ? { gte: fromDay } : {}),
                ...(toDay ? { lte: toDay } : {}),
              },
            }
          : {}),
      },
      _sum: {
        hostEarningsPoints: true,
        hostCommissionPoints: true,
        liveDurationSeconds: true,
      },
    })

    for (const r of rows) {
      map.set(r.hostUserId, {
        hostEarnings: r._sum.hostEarningsPoints ?? 0n,
        hostCommission: r._sum.hostCommissionPoints ?? 0n,
        liveDurationSeconds: r._sum.liveDurationSeconds ?? 0n,
      })
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
