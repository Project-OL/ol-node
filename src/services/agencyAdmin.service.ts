import { prismaRead } from '../config/database'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { agencyRepository } from '../repositories/agency.repository'
import { agencyAgentApplicationRepository } from '../repositories/agencyAgentApplication.repository'
import { agencyCommissionRepository } from '../repositories/agencyCommission.repository'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { agencyHostRepository } from '../repositories/agencyHost.repository'
import { storageService } from './storage.service'
import { agencyCommissionService, agencyTierWindowMetricNote } from './agencyCommission.service'
import { env } from '../config/env'
import { displayNameFromUser } from '../utils/profileDisplay'
import { buildUserDisplayName, formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import { formatPointsAsUsd } from '../utils/points-currency'
import {
  addUtcDays,
  commissionPeriodToLedgerBounds,
  resolveCommissionPeriod,
  utcDateString,
  utcMonthBoundsExclusive,
  utcNow,
  utcStartOfDay,
  utcYearMonth,
} from '../utils/datetime'
import { agencyCommissionConfigService } from './agencyCommissionConfig.service'
import {
  effectiveTierWindowTotal,
  serializeAgencyTierLock,
} from '../utils/agency-tier-lock'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isAgencySuspended(agency: { pausedAt: Date | null; pausedUntil: Date | null }): boolean {
  if (!agency.pausedAt) return false
  if (agency.pausedUntil && agency.pausedUntil.getTime() <= Date.now()) return false
  return true
}

function agencyStatusLabel(agency: { pausedAt: Date | null; pausedUntil: Date | null }): string {
  return isAgencySuspended(agency) ? 'SUSPENDED' : 'ACTIVE'
}

function tierLockFields(
  agency: {
    currentWindowTotalPoints: bigint
    tierLockLevel: string | null
    tierLockUntil: Date | null
    tierLockBonusPoints: bigint | null
  },
  lockMinWindowPoints: bigint | null,
  now: Date = utcNow(),
) {
  const lock = serializeAgencyTierLock(agency, now)
  const { effective } = effectiveTierWindowTotal({
    actual: agency.currentWindowTotalPoints,
    lock: agency,
    lockLevelMinWindowPoints: lockMinWindowPoints,
    now,
  })
  return {
    ...lock,
    effectiveWindowTotalPoints: effective.toString(),
  }
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

function mapKycDocuments(
  kyc: {
    govtIdS3Key: string | null
    govtIdSubmittedAt: Date | null
    contactPhone: string | null
    contactEmail: string | null
    contactSubmittedAt: Date | null
    faceVerified: boolean
  } | null,
) {
  return {
    govtIdUploaded: Boolean(kyc?.govtIdSubmittedAt),
    govtIdUrl: kyc?.govtIdS3Key ? storageService.getCdnOrS3PublicUrl(kyc.govtIdS3Key) : null,
    govtIdSubmittedAt: kyc?.govtIdSubmittedAt?.toISOString() ?? null,
    contactSubmitted: Boolean(kyc?.contactSubmittedAt),
    contactPhone: kyc?.contactPhone ?? null,
    contactEmail: kyc?.contactEmail ?? null,
    contactSubmittedAt: kyc?.contactSubmittedAt?.toISOString() ?? null,
  }
}

function faceImageUrlFromProfile(
  faceProfile: { s3KeyReference?: string | null } | null | undefined,
): string | null {
  const key = faceProfile?.s3KeyReference?.trim()
  return key ? storageService.getCdnOrS3PublicUrl(key) : null
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
  faceProfile: { status?: string | null; s3KeyReference?: string | null } | null | undefined,
) {
  const faceIndexed = faceProfile?.status === 'INDEXED'
  const faceOk = Boolean(kyc?.faceVerified) || faceIndexed
  return {
    ...mapKycDocuments(kyc),
    faceVerified: faceOk,
    faceImageUrl: faceImageUrlFromProfile(faceProfile),
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
      totalAgencies > 0 ? Math.round((totalActiveAgencies / totalAgencies) * 10000) / 100 : 0

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
        earningsThisMonthUsd: formatPointsAsUsd(earnings),
        commissionTier: row.currentLevel,
        payrollPrivilegeGranted: row.payrollPrivilegeGranted,
        payrollEnabled: row.payrollEnabled,
        status: agencyStatusLabel(row),
        approvedAt: row.createdAt.toISOString(),
      }
    })

    return { items, total, skip: params.skip, take: params.take }
  },

  async listPendingApplications(params: { skip: number; take: number }) {
    return this.listApplications({
      statuses: ['PENDING', 'UNDER_REVIEW', 'MORE_DOCS_REQUIRED'],
      skip: params.skip,
      take: params.take,
    })
  },

  async listRejectedApplications(params: { skip: number; take: number }) {
    return this.listApplications({
      statuses: ['REJECTED'],
      skip: params.skip,
      take: params.take,
    })
  },

  async listApplications(params: {
    statuses: Array<'PENDING' | 'UNDER_REVIEW' | 'MORE_DOCS_REQUIRED' | 'APPROVED' | 'REJECTED'>
    skip: number
    take: number
  }) {
    const [rows, total] = await Promise.all([
      agencyAgentApplicationRepository.listByStatus([...params.statuses], params.skip, params.take),
      agencyAgentApplicationRepository.count([...params.statuses]),
    ])

    const items = rows.map((row) => {
      const faceImageUrl = faceImageUrlFromProfile(row.user.faceProfile)
      return {
        applicationId: row.id,
        applicantUserId: row.userId,
        applicantUserName: buildUserDisplayName(row.user),
        username: row.user.username,
        userPublicId: resolveDisplayPublicId(row.user),
        country: row.user.country ?? null,
        avatarUrl: row.user.avatarUrl ?? null,
        faceImageUrl,
        kyc: buildKycReviewStatus(row.kyc, row.user.faceProfile),
        status: row.status,
        appliedAt: row.createdAt.toISOString(),
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        reviewedBy: row.reviewedBy ?? null,
        adminNote: row.adminNote ?? null,
        userNote: row.userNote ?? null,
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
          faceProfile: { select: { status: true, s3KeyReference: true } },
        },
      }),
      agencyApplicationKycRepository.getKycForAdminReview(agencyUserId),
      agencyCommissionRepository.sumAgencyDailyEarningsAllTime(agencyUserId),
      agencyCommissionRepository.sumAgencyDailyEarnings(agencyUserId, monthStart, monthEnd),
      agencyRepository.countHostsWithCommission(agencyUserId),
    ])

    if (!owner) throw new AppError(404, 'Agency owner not found', 'USER_NOT_FOUND')

    const faceIndexed = owner.faceProfile?.status === 'INDEXED'
    const faceImageUrl = faceImageUrlFromProfile(owner.faceProfile)
    const kycVerified =
      Boolean(kycRow.kyc?.govtIdSubmittedAt) &&
      Boolean(kycRow.kyc?.contactSubmittedAt) &&
      (Boolean(kycRow.kyc?.faceVerified) || faceIndexed)

    const lifetimePoints = totalEarnings.hostEarningsPoints + totalEarnings.hostCommissionPoints
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
      kycDocuments: {
        ...mapKycDocuments(kycRow.kyc),
        faceImageUrl,
      },
      faceVerified: Boolean(kycRow.kyc?.faceVerified) || faceIndexed,
      faceImageUrl,
      totalHosts: agency.totalHostsCount,
      totalEarningHosts: earningHostsCount,
      totalEarningsPoints: lifetimePoints.toString(),
      totalEarningsUsd: formatPointsAsUsd(lifetimePoints),
      thisMonthEarningsPoints: monthPoints.toString(),
      thisMonthEarningsUsd: formatPointsAsUsd(monthPoints),
      commissionTier: agency.currentLevel,
      currentWindowTotalPoints: agency.currentWindowTotalPoints.toString(),
      ...tierLockFields(
        agency,
        agency.tierLockLevel
          ? ((await agencyCommissionRepository.getLevelRow(agency.tierLockLevel))?.minWindowPoints ??
              null)
          : null,
      ),
      payrollPrivilegeGranted: agency.payrollPrivilegeGranted,
      payrollEnabled: agency.payrollEnabled,
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
   * Window total sources are gated by AGENCY_TIER_INCLUDE_* env flags.
   */
  async forceRecomputeLevel(identifier: string) {
    const agency = await resolveAgencyByIdentifier(identifier)
    const lockMin = async (row: typeof agency) =>
      row.tierLockLevel
        ? ((await agencyCommissionRepository.getLevelRow(row.tierLockLevel))?.minWindowPoints ??
            null)
        : null

    const before = {
      currentLevel: agency.currentLevel,
      currentWindowTotalPoints: agency.currentWindowTotalPoints.toString(),
      lastLevelRecomputedAt: agency.lastLevelRecomputedAt?.toISOString() ?? null,
      ...tierLockFields(agency, await lockMin(agency)),
    }

    await agencyCommissionService.recomputeAgencyLevel(agency.userId, {
      skipDailyDedupe: true,
    })

    const afterRow = await agencyRepository.getAgencyByUserId(agency.userId)
    if (!afterRow) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')

    const metric = {
      includeHostEarnings: env.AGENCY_TIER_INCLUDE_HOST_EARNINGS,
      includeAgencyCommission: env.AGENCY_TIER_INCLUDE_AGENCY_COMMISSION,
    }
    const { from, toExclusive, totalMinutes } =
      await agencyCommissionConfigService.resolveRollingWindowBounds()
    const { fromDay, toDay } = await agencyCommissionConfigService.resolveRollingWindowDays()
    const cfg = await agencyCommissionConfigService.getConfig()
    return {
      ok: true as const,
      agencyUserId: agency.userId,
      agencyPublicId: agency.defaultPublicId.toString(),
      levelWindow: {
        from: utcDateString(fromDay),
        to: utcDateString(toDay),
        fromAt: from.toISOString(),
        toExclusiveAt: toExclusive.toISOString(),
        windowDays: cfg.windowDays,
        windowHours: cfg.windowHours,
        windowMinutes: cfg.windowMinutes,
        totalMinutes,
        includeHostEarnings: metric.includeHostEarnings,
        includeAgencyCommission: metric.includeAgencyCommission,
        note: agencyTierWindowMetricNote(metric),
      },
      before,
      after: {
        currentLevel: afterRow.currentLevel,
        currentWindowTotalPoints: afterRow.currentWindowTotalPoints.toString(),
        lastLevelRecomputedAt: afterRow.lastLevelRecomputedAt?.toISOString() ?? null,
        ...tierLockFields(afterRow, await lockMin(afterRow)),
      },
    }
  },

  /**
   * All current hosts for an agency with earnings + commission for a period.
   * Default period = rolling 30 UTC days ending today (same shape as days-only tier window).
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
    const nextCursor = hasMore && last ? `${last.joinedAt.toISOString()}|${last.hostUserId}` : null

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
          name: formatUserName(r.host),
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
   * Default period = rolling 30 UTC days ending today (same as host earnings).
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
    const senderIds = page
      .map((r) => {
        const meta =
          r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
            ? (r.metadata as Record<string, unknown>)
            : null
        return typeof meta?.senderUserId === 'string' ? meta.senderUserId : null
      })
      .filter((id): id is string => typeof id === 'string')
    const profileSelect = {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
      publicId: true,
      defaultPublicId: true,
      currentVipPublicId: true,
      avatarUrl: true,
    } as const
    const userIds = [...new Set([...hostIds, ...senderIds])]
    const users = await prismaRead.user.findMany({
      where: { id: { in: userIds } },
      select: profileSelect,
    })
    const userMap = new Map(users.map((u) => [u.id, u]))

    const toCard = (userId: string | null | undefined) => {
      if (!userId) return null
      const u = userMap.get(userId)
      if (!u) return null
      return {
        userId: u.id,
        displayName: buildUserDisplayName(u),
        name: formatUserName(u),
        publicId: String(u.publicId),
        displayPublicId: resolveDisplayPublicId(u),
        username: u.username,
        avatarUrl: u.avatarUrl,
      }
    }

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
        const meta =
          e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata)
            ? (e.metadata as Record<string, unknown>)
            : null
        const senderUserId =
          typeof meta?.senderUserId === 'string' ? meta.senderUserId : null
        const host = toCard(e.counterpartyId)
        return {
          id: e.id,
          direction: e.direction,
          amount: e.amount.toString(),
          balanceAfter: e.balanceAfter.toString(),
          refId: e.refId,
          counterpartyId: e.counterpartyId,
          description: e.description,
          createdAt: e.createdAt.toISOString(),
          category: typeof meta?.category === 'string' ? meta.category : null,
          rateBp: typeof meta?.rateBp === 'number' ? meta.rateBp : null,
          hostTxType: typeof meta?.hostTxType === 'string' ? meta.hostTxType : null,
          hostLedgerEntryId:
            typeof meta?.hostLedgerEntryId === 'string' ? meta.hostLedgerEntryId : null,
          giftId: typeof meta?.giftId === 'string' ? meta.giftId : null,
          giftName: typeof meta?.giftName === 'string' ? meta.giftName : null,
          giftContext: typeof meta?.context === 'string' ? meta.context : null,
          quantity: typeof meta?.quantity === 'number' ? meta.quantity : null,
          unitCoinCost: typeof meta?.unitCoinCost === 'number' ? meta.unitCoinCost : null,
          senderUserId,
          host,
          sender: toCard(senderUserId),
          /** Wallet-history shape for the host (ledger counterparty). */
          counterpartyDetails: host
            ? {
                userId: host.userId,
                name: host.name,
                publicId: host.publicId,
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
      { timeout: 20_000 },
    )

    await agencyService.bustCachesForAgency(agencyUserId, agency.defaultPublicId)
    await agencyCoinsellerService._bustCache(agencyUserId)
    await agencyService.bustRankingCache()

    return { ok: true as const, agencyUserId, adminUserId }
  },

  /**
   * Ban/bar agency: freeze owner wallets, expire open payroll, free hosts, delete agency,
   * bar re-application. User login remains active.
   */
  async banAgencyByAdmin(agencyUserId: string, adminUserId: string, reason?: string) {
    const agency = await agencyRepository.getAgencyByUserId(agencyUserId)
    if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')

    const { agencyHostService } = await import('./agencyHost.service')
    const { agencyService } = await import('./agency.service')
    const { agencyCoinsellerService } = await import('./agencyCoinseller.service')
    const { adminWalletService } = await import('./adminWallet.service')
    const { withdrawalService } = await import('./withdrawal.service')
    const { payrollAssignmentRepository } =
      await import('../repositories/payrollAssignment.repository')
    const { withdrawalRepository } = await import('../repositories/withdrawal.repository')
    const { removePayrollSla, removePayrollWaiting } = await import('../queues/payroll.queue')

    await adminWalletService.setAllWalletsFrozen(agencyUserId, true, adminUserId)

    const openAssignments = await prisma.withdrawalPayrollAssignment.findMany({
      where: {
        agencyUserId,
        status: { in: ['PENDING', 'WAITING'] },
      },
      select: { id: true, withdrawalId: true, status: true },
    })

    const withdrawalIdsToReassign: string[] = []
    await prisma.$transaction(
      async (tx) => {
        const now = new Date()
        for (const a of openAssignments) {
          await payrollAssignmentRepository.updateStatus(
            {
              id: a.id,
              status: 'EXPIRED',
              rejectionReason: reason?.trim() || 'Agency banned by admin',
            },
            tx,
          )
          await withdrawalRepository.incrementAssignmentCount(a.withdrawalId, tx)
          await withdrawalRepository.updateStatus({ id: a.withdrawalId, status: 'PENDING' }, tx)
          withdrawalIdsToReassign.push(a.withdrawalId)
          void now
        }

        await agencyHostService.handleAgentAccountDeletion(agencyUserId, tx, 'AGENCY_BANNED')

        await tx.user.update({
          where: { id: agencyUserId },
          data: {
            agencyBarredAt: new Date(),
            agencyBarredReason: reason?.trim() || null,
          },
        })
      },
      { timeout: 30_000 },
    )

    for (const a of openAssignments) {
      await removePayrollSla(a.id).catch(() => {})
      if (a.status === 'WAITING') {
        await removePayrollWaiting(a.id).catch(() => {})
      }
    }

    for (const wid of [...new Set(withdrawalIdsToReassign)]) {
      await withdrawalService.assignToAgency(wid).catch(() => {})
    }

    await agencyService.bustCachesForAgency(agencyUserId, agency.defaultPublicId)
    await agencyCoinsellerService._bustCache(agencyUserId)
    await agencyService.bustRankingCache()

    return {
      ok: true as const,
      agencyUserId,
      agencyPublicId: agency.defaultPublicId.toString(),
      barred: true as const,
      adminUserId,
    }
  },

  async unbarUser(userId: string, adminUserId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, agencyBarredAt: true },
    })
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    if (!user.agencyBarredAt) {
      throw new AppError(400, 'User is not agency-barred', 'NOT_AGENCY_BARRED')
    }

    await prisma.user.update({
      where: { id: userId },
      data: { agencyBarredAt: null, agencyBarredReason: null },
    })

    const { adminWalletService } = await import('./adminWallet.service')
    await adminWalletService.setAllWalletsFrozen(userId, false, adminUserId)

    return { ok: true as const, userId, barred: false as const }
  },
}
