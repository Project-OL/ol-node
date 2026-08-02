import { prismaRead } from '../config/database'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { agencyRepository } from '../repositories/agency.repository'
import { agencyAgentApplicationRepository } from '../repositories/agencyAgentApplication.repository'
import { agencyCommissionRepository } from '../repositories/agencyCommission.repository'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { agencyHostRepository } from '../repositories/agencyHost.repository'
import { storageService } from './storage.service'
import { agencyCommissionService } from './agencyCommission.service'
import { displayNameFromUser } from '../utils/profileDisplay'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'
import {
  addUtcDays,
  agencyCommissionRollingWindowDays,
  commissionPeriodToLedgerBounds,
  resolveCommissionPeriod,
  utcDateString,
  utcMonthBoundsExclusive,
  utcNow,
  utcStartOfDay,
  utcYearMonth,
} from '../utils/datetime'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isAgencySuspended(agency: { pausedAt: Date | null; pausedUntil: Date | null }): boolean {
  if (!agency.pausedAt) return false
  if (agency.pausedUntil && agency.pausedUntil.getTime() <= Date.now()) return false
  return true
}

function agencyStatusLabel(agency: { pausedAt: Date | null; pausedUntil: Date | null }): string {
  return isAgencySuspended(agency) ? 'SUSPENDED' : 'ACTIVE'
}

function pctChange(today: bigint, yesterday: bigint): number | null {
  if (yesterday === 0n) {
    if (today === 0n) return 0
    return null
  }
  const t = Number(today)
  const y = Number(yesterday)
  return Math.round(((t - y) / y) * 10000) / 100
}

function mapKycDocuments(kyc: {
  govtIdS3Key: string | null
  govtIdSubmittedAt: Date | null
  contactPhone: string | null
  contactEmail: string | null
  contactSubmittedAt: Date | null
  faceVerified: boolean
} | null) {
  return {
    govtIdUploaded: Boolean(kyc?.govtIdSubmittedAt),
    govtIdUrl: kyc?.govtIdS3Key ? storageService.getCdnOrS3PublicUrl(kyc.govtIdS3Key) : null,
    govtIdSubmittedAt: kyc?.govtIdSubmittedAt?.toISOString() ?? null,
    contactPhone: kyc?.contactPhone ?? null,
    contactEmail: kyc?.contactEmail ?? null,
    contactSubmittedAt: kyc?.contactSubmittedAt?.toISOString() ?? null,
  }
}

function buildKycReviewStatus(
  kyc: {
    govtIdSubmittedAt: Date | null
    contactSubmittedAt: Date | null
    faceVerified: boolean
    govtIdS3Key: string | null
    contactPhone: string | null
    contactEmail: string | null
  } | null,
  faceIndexed: boolean,
) {
  const faceOk = Boolean(kyc?.faceVerified) || faceIndexed
  return {
    ...mapKycDocuments(kyc),
    faceVerified: faceOk,
    isComplete: Boolean(kyc?.govtIdSubmittedAt) && Boolean(kyc?.contactSubmittedAt) && faceOk,
  }
}

async function resolveAgencyByIdentifier(identifier: string) {
  const trimmed = identifier.trim()
  if (UUID_RE.test(trimmed)) {
    const byUserId = await agencyRepository.getAgencyByUserId(trimmed)
    if (byUserId) return byUserId
  }
  let pid: bigint
  try {
    pid = BigInt(trimmed)
  } catch {
    throw new AppError(400, 'Invalid agency identifier', 'INVALID_AGENCY_ID')
  }
  const agency = await agencyRepository.getAgencyByPublicId(pid)
  if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')
  return agency
}

export const agencyAdminService = {
  resolveAgencyByIdentifier,

  async getOverviewStats() {
    const now = utcNow()
    const todayStart = utcStartOfDay(now)
    const yesterdayStart = addUtcDays(todayStart, -1)

    const [
      totalAgencies,
      totalActiveAgencies,
      totalSuspendedAgencies,
      totalHosts,
      todayEarnings,
      yesterdayEarnings,
    ] = await Promise.all([
      agencyRepository.countAll(),
      agencyRepository.countActive(),
      agencyRepository.countSuspended(),
      agencyRepository.countAllHosts(),
      agencyRepository.sumPlatformDailyEarnings(todayStart, todayStart),
      agencyRepository.sumPlatformDailyEarnings(yesterdayStart, yesterdayStart),
    ])

    const activePct =
      totalAgencies > 0
        ? Math.round((totalActiveAgencies / totalAgencies) * 10000) / 100
        : 0

    return {
      totalAgencies,
      totalActiveAgencies,
      activeAgenciesPercent: activePct,
      totalSuspendedAgencies,
      totalHosts,
      todayAgencyEarningsPoints: todayEarnings.toString(),
      yesterdayAgencyEarningsPoints: yesterdayEarnings.toString(),
      todayEarningsChangePercent: pctChange(todayEarnings, yesterdayEarnings),
    }
  },

  async listAgencies(params: {
    status?: 'ACTIVE' | 'SUSPENDED'
    country?: string
    search?: string
    skip: number
    take: number
  }) {
    const now = utcNow()
    const { year, month } = utcYearMonth(now)
    const { start: monthStart, endExclusive: monthEndExclusive } = utcMonthBoundsExclusive(
      year,
      month,
    )
    const monthEnd = addUtcDays(monthEndExclusive, -1)

    const [rows, total, earningsMap] = await Promise.all([
      agencyRepository.listForAdmin(params),
      agencyRepository.countForAdmin(params),
      agencyRepository.sumEarningsByAgencyForRange(monthStart, monthEnd),
    ])

    const items = rows.map((row) => {
      const earnings = earningsMap.get(row.userId) ?? 0n
      return {
        agencyUserId: row.userId,
        agencyPublicId: row.defaultPublicId.toString(),
        userName: displayNameFromUser(row.user),
        userPublicId: resolveDisplayPublicId(row.user),
        totalHosts: row.totalHostsCount,
        country: row.user.country,
        earningsThisMonthPoints: earnings.toString(),
        commissionTier: row.currentLevel,
        status: agencyStatusLabel(row),
        approvedAt: row.createdAt.toISOString(),
      }
    })

    return { items, total, skip: params.skip, take: params.take }
  },

  async listPendingApplications(params: { skip: number; take: number }) {
    const statuses = ['PENDING', 'UNDER_REVIEW', 'MORE_DOCS_REQUIRED'] as const
    const [rows, total] = await Promise.all([
      agencyAgentApplicationRepository.listByStatus([...statuses], params.skip, params.take),
      agencyAgentApplicationRepository.count([...statuses]),
    ])

    const items = rows.map((row) => {
      const faceIndexed = row.user.faceProfile?.status === 'INDEXED'
      return {
        applicationId: row.id,
        applicantUserId: row.userId,
        applicantUserName: buildUserDisplayName(row.user),
        userPublicId: resolveDisplayPublicId(row.user),
        country: row.user.country ?? null,
        kyc: buildKycReviewStatus(row.kyc, faceIndexed),
        status: row.status,
        appliedAt: row.createdAt.toISOString(),
      }
    })

    return { items, total, skip: params.skip, take: params.take }
  },

  async getAgencyDetail(identifier: string) {
    const agency = await resolveAgencyByIdentifier(identifier)
    const agencyUserId = agency.userId

    const now = utcNow()
    const { year, month } = utcYearMonth(now)
    const { start: monthStart, endExclusive: monthEndExclusive } = utcMonthBoundsExclusive(
      year,
      month,
    )
    const monthEnd = addUtcDays(monthEndExclusive, -1)

    const [owner, kycRow, totalEarnings, monthEarnings, earningHostsCount] = await Promise.all([
      prismaRead.user.findUnique({
        where: { id: agencyUserId },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          publicId: true,
          defaultPublicId: true,
          currentVipPublicId: true,
          country: true,
          faceProfile: { select: { status: true } },
        },
      }),
      agencyApplicationKycRepository.getKycForAdminReview(agencyUserId),
      agencyCommissionRepository.sumAgencyDailyEarningsAllTime(agencyUserId),
      agencyCommissionRepository.sumAgencyDailyEarnings(agencyUserId, monthStart, monthEnd),
      agencyRepository.countHostsWithCommission(agencyUserId),
    ])

    if (!owner) throw new AppError(404, 'Agency owner not found', 'USER_NOT_FOUND')

    const faceIndexed = owner.faceProfile?.status === 'INDEXED'
    const kycVerified =
      Boolean(kycRow.kyc?.govtIdSubmittedAt) &&
      Boolean(kycRow.kyc?.contactSubmittedAt) &&
      (Boolean(kycRow.kyc?.faceVerified) || faceIndexed)

    const lifetimePoints =
      totalEarnings.hostEarningsPoints + totalEarnings.hostCommissionPoints
    const monthPoints = monthEarnings.hostEarningsPoints + monthEarnings.hostCommissionPoints

    return {
      agencyUserId,
      agencyPublicId: agency.defaultPublicId.toString(),
      userName: displayNameFromUser(owner),
      userPublicId: resolveDisplayPublicId(owner),
      contactPhone: kycRow.kyc?.contactPhone ?? null,
      contactEmail: kycRow.kyc?.contactEmail ?? null,
      approvedAt: agency.createdAt.toISOString(),
      country: owner.country,
      kycVerified,
      kycDocuments: mapKycDocuments(kycRow.kyc),
      faceVerified: Boolean(kycRow.kyc?.faceVerified) || faceIndexed,
      totalHosts: agency.totalHostsCount,
      totalEarningHosts: earningHostsCount,
      totalEarningsPoints: lifetimePoints.toString(),
      thisMonthEarningsPoints: monthPoints.toString(),
      commissionTier: agency.currentLevel,
      status: agencyStatusLabel(agency),
      pausedUntil: agency.pausedUntil?.toISOString() ?? null,
    }
  },

  async rejectApplication(params: {
    applicantUserId: string
    adminUserId: string
    adminNote?: string
    userNote?: string
  }) {
    const application = await agencyAgentApplicationRepository.findByUserId(params.applicantUserId)
    if (!application) {
      throw new AppError(404, 'Application not found', 'APPLICATION_NOT_FOUND')
    }
    if (application.status === 'APPROVED') {
      throw new AppError(400, 'Application already approved', 'ALREADY_APPROVED')
    }
    if (application.status === 'REJECTED') {
      return { ok: true as const, alreadyRejected: true as const }
    }

    await agencyAgentApplicationRepository.updateStatus(application.id, {
      status: 'REJECTED',
      reviewedBy: params.adminUserId,
      adminNote: params.adminNote,
      userNote: params.userNote,
    })

    return { ok: true as const, alreadyRejected: false as const }
  },

  /**
   * Force agency tier recompute (skips same-day dedupe). Returns before/after level.
   */
  async forceRecomputeLevel(identifier: string) {
    const agency = await resolveAgencyByIdentifier(identifier)
    const before = {
      currentLevel: agency.currentLevel,
      currentWindowTotalPoints: agency.currentWindowTotalPoints.toString(),
      lastLevelRecomputedAt: agency.lastLevelRecomputedAt?.toISOString() ?? null,
    }

    await agencyCommissionService.recomputeAgencyLevel(agency.userId, {
      skipDailyDedupe: true,
    })

    const afterRow = await agencyRepository.getAgencyByUserId(agency.userId)
    if (!afterRow) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')

    const { fromDay, toDay } = agencyCommissionRollingWindowDays()
    return {
      ok: true as const,
      agencyUserId: agency.userId,
      agencyPublicId: agency.defaultPublicId.toString(),
      levelWindow: {
        from: utcDateString(fromDay),
        to: utcDateString(toDay),
        note: 'Inclusive UTC days ending yesterday (today excluded)',
      },
      before,
      after: {
        currentLevel: afterRow.currentLevel,
        currentWindowTotalPoints: afterRow.currentWindowTotalPoints.toString(),
        lastLevelRecomputedAt: afterRow.lastLevelRecomputedAt?.toISOString() ?? null,
      },
    }
  },

  /**
   * All current hosts for an agency with earnings + commission for a period.
   * Default period = rolling 30 days ending yesterday (same as level window when periodDays=30).
   */
  async listHostEarnings(
    identifier: string,
    periodParams: { periodDays?: number; from?: string; to?: string },
    opts: { limit: number; cursor?: string | null },
  ) {
    const agency = await resolveAgencyByIdentifier(identifier)
    const period = resolveCommissionPeriod(periodParams)
    const rows = await agencyHostRepository.listHosts(agency.userId, {
      limit: opts.limit,
      cursor: opts.cursor,
    })
    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const hostIds = page.map((r) => r.hostUserId)
    const earningsMap = await agencyHostRepository.getHostEarningsAggregatesInRange(
      agency.userId,
      hostIds,
      period.start,
      period.end,
    )

    const last = page[page.length - 1]
    const nextCursor =
      hasMore && last ? `${last.joinedAt.toISOString()}|${last.hostUserId}` : null

    return {
      agencyUserId: agency.userId,
      agencyPublicId: agency.defaultPublicId.toString(),
      commissionTier: agency.currentLevel,
      period: {
        from: utcDateString(period.start),
        to: utcDateString(period.end),
        periodDays: periodParams.from && periodParams.to ? null : (periodParams.periodDays ?? 30),
      },
      hosts: page.map((r) => {
        const e = earningsMap.get(r.hostUserId)
        const hostEarningsPoints = e?.hostEarnings ?? 0n
        const hostCommissionPoints = e?.hostCommission ?? 0n
        return {
          hostUserId: r.hostUserId,
          joinedAt: r.joinedAt.toISOString(),
          displayName: buildUserDisplayName(r.host),
          publicId: String(r.host.publicId),
          displayPublicId: resolveDisplayPublicId(r.host),
          username: r.host.username,
          avatarUrl: r.host.avatarUrl,
          hostEarningsPoints: hostEarningsPoints.toString(),
          hostCommissionPoints: hostCommissionPoints.toString(),
          totalPoints: (hostEarningsPoints + hostCommissionPoints).toString(),
          liveDurationSeconds: (e?.liveDurationSeconds ?? 0n).toString(),
        }
      }),
      nextCursor,
      hasMore,
    }
  },

  /**
   * Per-credit commission history (AGENT_COMMISSION ledger) for an agency.
   * Filter with `hostPublicId` (or `hostUserId`) and optional date window.
   * Default period = rolling 30 days ending yesterday (same as host earnings).
   */
  async listCommissionHistory(
    identifier: string,
    periodParams: { periodDays?: number; from?: string; to?: string },
    opts: {
      hostPublicId?: string
      hostUserId?: string
      cursor?: string | null
      limit: number
    },
  ) {
    const agency = await resolveAgencyByIdentifier(identifier)

    let hostUserId = opts.hostUserId
    if (opts.hostPublicId) {
      if (!/^\d+$/.test(opts.hostPublicId.trim())) {
        throw new AppError(400, 'hostPublicId must be numeric', 'INVALID_REQUEST')
      }
      const pid = BigInt(opts.hostPublicId.trim())
      const host = await prismaRead.user.findFirst({
        where: {
          OR: [{ publicId: pid }, { defaultPublicId: pid }, { currentVipPublicId: pid }],
        },
        select: { id: true },
      })
      if (!host) throw new AppError(404, 'Host not found for hostPublicId', 'USER_NOT_FOUND')
      hostUserId = host.id
    }

    const period = resolveCommissionPeriod(periodParams)
    const { from, toExclusive } = commissionPeriodToLedgerBounds(period.start, period.end)

    const rows = await agencyCommissionRepository.listCommissionHistory({
      agencyUserId: agency.userId,
      hostUserId,
      from,
      toExclusive,
      cursor: opts.cursor ?? undefined,
      limit: opts.limit,
    })

    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const hostIds = page
      .map((r) => r.counterpartyId)
      .filter((id): id is string => typeof id === 'string')
    const hosts = await prismaRead.user.findMany({
      where: { id: { in: [...new Set(hostIds)] } },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        publicId: true,
        defaultPublicId: true,
        currentVipPublicId: true,
        avatarUrl: true,
      },
    })
    const hostMap = new Map(hosts.map((h) => [h.id, h]))

    return {
      agencyUserId: agency.userId,
      agencyPublicId: agency.defaultPublicId.toString(),
      commissionTier: agency.currentLevel,
      period: {
        from: utcDateString(period.start),
        to: utcDateString(period.end),
        periodDays: periodParams.from && periodParams.to ? null : (periodParams.periodDays ?? 30),
      },
      filter: {
        hostPublicId: opts.hostPublicId ?? null,
        hostUserId: hostUserId ?? null,
      },
      entries: page.map((e) => {
        const host = e.counterpartyId ? hostMap.get(e.counterpartyId) : undefined
        const meta =
          e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata)
            ? (e.metadata as Record<string, unknown>)
            : null
        return {
          id: e.id,
          direction: e.direction,
          amount: e.amount.toString(),
          balanceAfter: e.balanceAfter.toString(),
          refId: e.refId,
          description: e.description,
          createdAt: e.createdAt.toISOString(),
          category: typeof meta?.category === 'string' ? meta.category : null,
          rateBp: typeof meta?.rateBp === 'number' ? meta.rateBp : null,
          hostTxType: typeof meta?.hostTxType === 'string' ? meta.hostTxType : null,
          hostLedgerEntryId:
            typeof meta?.hostLedgerEntryId === 'string' ? meta.hostLedgerEntryId : null,
          host: host
            ? {
                userId: host.id,
                displayName: buildUserDisplayName(host),
                publicId: String(host.publicId),
                displayPublicId: resolveDisplayPublicId(host),
                username: host.username,
                avatarUrl: host.avatarUrl,
              }
            : null,
        }
      }),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    }
  },

  async deleteAgencyByAdmin(agencyUserId: string, adminUserId: string) {
    const agency = await agencyRepository.getAgencyByUserId(agencyUserId)
    if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')

    const { agencyHostService } = await import('./agencyHost.service')
    const { agencyService } = await import('./agency.service')
    const { agencyCoinsellerService } = await import('./agencyCoinseller.service')

    await prisma.$transaction(
      async (tx) => {
        await agencyHostService.handleAgentAccountDeletion(agencyUserId, tx)
      },
      { isolationLevel: 'Serializable', timeout: 20_000 },
    )

    await agencyService.bustCachesForAgency(agencyUserId, agency.defaultPublicId)
    await agencyCoinsellerService._bustCache(agencyUserId)
    await agencyService.bustRankingCache()

    return { ok: true as const, agencyUserId, adminUserId }
  },
}
