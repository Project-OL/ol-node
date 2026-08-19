import {
  AgencyTransferChannel,
  Prisma,
  RankingBoard,
  SupportTicketType,
  WalletCurrencyType,
} from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { redisClient, RedisKeys, PAYROLL_SUMMARY_TTL } from '../config/redis'
import { payrollAssignmentRepository } from '../repositories/payrollAssignment.repository'
import { withdrawalService } from './withdrawal.service'
import { mapPaymentMethodFull, mapPaymentMethodMaskedForAgent } from '../utils/payment-method-mask'
import { cacheRedisService } from './cacheRedis.service'
import { AppError } from '../middlewares/errorHandler'
import { agencyRepository } from '../repositories/agency.repository'
import { agencyHostRepository } from '../repositories/agencyHost.repository'
import { agencyLeaveApplicationRepository } from '../repositories/agencyLeaveApplication.repository'
import { agencyAgentApplicationRepository } from '../repositories/agencyAgentApplication.repository'
import { supportRepository } from '../repositories/support.repository'
import { rootLogger } from '../utils/rootLogger'
import { displayNameFromUser } from '../utils/profileDisplay'
import { formatUserName } from '../utils/user-display'
import { agencyCommissionService } from './agencyCommission.service'
import { rankingService } from './ranking.service'
import { agencyCommissionRepository } from '../repositories/agencyCommission.repository'
import { agencyKycService } from './agencyKyc.service'
import { agencyCoinsellerService } from './agencyCoinseller.service'
import { formatLocalAmount, resolveLocalFx } from '../utils/local-currency'
import { withdrawalHostPayoutPoints } from '../utils/payroll-fee'

const log = rootLogger.child({ module: 'agency.service' })

const TX_TIMEOUT_MS = 20_000

type HostWithAgencyRow = NonNullable<
  Awaited<ReturnType<typeof agencyHostRepository.getHostWithAgency>>
>

export function mapHostAgencyMeBlock(
  hostRow: HostWithAgencyRow,
  pendingLeave: { id: string; autoApproveAt: Date } | null,
) {
  return {
    agencyPublicId: hostRow.agency.defaultPublicId.toString(),
    agencyDisplayName: formatUserName(hostRow.agency.user ?? {}),
    /** Agency owner first + last (empty if both missing). */
    name: formatUserName(hostRow.agency.user ?? {}),
    avatarUrl: hostRow.agency.user?.avatarUrl ?? null,
    joinedAt: hostRow.joinedAt.toISOString(),
    pendingLeaveApplication: pendingLeave
      ? {
          id: pendingLeave.id,
          autoApproveAt: pendingLeave.autoApproveAt.toISOString(),
        }
      : undefined,
  }
}

export const agencyService = {
  async bustCachesForAgency(userId: string, defaultPublicId: bigint) {
    await cacheRedisService.del(
      RedisKeys.agencyMe(userId),
      RedisKeys.agencyByPublicId(defaultPublicId.toString()),
    )
  },

  async bustRankingCache() {
    await cacheRedisService.delByKeyPrefix('agency:ranking:')
  },

  /**
   * After first/last name changes: rewrite `agencies.display_name`, drop ranking Redis,
   * bump platform ranking epochs so lists pick up the live name immediately.
   */
  async onOwnerNameChanged(userId: string): Promise<void> {
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    })
    const liveName = formatUserName(owner ?? {}).slice(0, 255)
    const agency = await prisma.agency.findUnique({
      where: { userId },
      select: { defaultPublicId: true },
    })
    if (agency) {
      if (liveName.length > 0) {
        await prisma.agency.update({
          where: { userId },
          data: { displayName: liveName },
        })
      }
      await this.bustCachesForAgency(userId, agency.defaultPublicId)
      await this.bustRankingCache()
    }
    await Promise.all([
      rankingService.bumpEpoch(RankingBoard.AGENCY),
      rankingService.bumpEpoch(RankingBoard.HOST),
      rankingService.bumpEpoch(RankingBoard.GIFT),
      rankingService.bumpEpoch(RankingBoard.RICH),
    ])
  },

  /**
   * Legacy: promote via support ticket + close ticket. Kept for rollback / scripts; HTTP uses
   * {@link agencyService.createAgencyFromApplication}.
   */
  async createAgencyFromTicket_deprecated(params: {
    adminUserId: string
    applicantUserId: string
    ticketId: bigint
  }) {
    await agencyKycService.validateKycComplete(params.applicantUserId)
    const ticket = await supportRepository.findTicketById(params.ticketId)
    if (!ticket) {
      throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')
    }
    if (ticket.userId !== params.applicantUserId) {
      throw new AppError(403, 'Ticket does not belong to user', 'TICKET_USER_MISMATCH')
    }
    if (ticket.type !== SupportTicketType.BUSINESS_COOPERATION) {
      throw new AppError(400, 'Invalid ticket type for agency', 'INVALID_TICKET_TYPE')
    }
    if (ticket.subType !== 'AGENCY_APPLICATION') {
      throw new AppError(400, 'Invalid ticket subtype for agency', 'INVALID_TICKET_SUBTYPE')
    }

    const existing = await agencyRepository.getAgencyByUserId(params.applicantUserId)
    if (existing) {
      log.info(
        { userId: params.applicantUserId },
        'createAgencyFromTicket_deprecated: agency already exists, no-op',
      )
      return { agency: existing, created: false as const }
    }

    const userRow = await prisma.user.findUnique({
      where: { id: params.applicantUserId },
      select: {
        id: true,
        defaultPublicId: true,
        username: true,
        firstName: true,
        lastName: true,
      },
    })
    if (!userRow) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const displayName = displayNameFromUser(userRow as never)

    const now = new Date()
    const agency = await prisma.$transaction(
      async (tx) => {
        const ag = await agencyRepository.createAgency(
          {
            userId: userRow.id,
            defaultPublicId: userRow.defaultPublicId,
            displayName: displayName.slice(0, 255),
          },
          tx,
        )
        await tx.user.update({
          where: { id: userRow.id },
          data: { isAgent: true },
        })
        await tx.wallet.upsert({
          where: {
            userId_currencyType: {
              userId: userRow.id,
              currencyType: WalletCurrencyType.TRADING_COIN,
            },
          },
          create: {
            userId: userRow.id,
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
          update: {},
        })
        await tx.supportTicket.update({
          where: { id: params.ticketId },
          data: {
            status: 'CLOSED',
            closedAt: now,
            closedByUserId: params.adminUserId,
            updatedAt: now,
          },
        })
        await seedCoinsellerWhatsappFromKyc(tx, userRow.id)
        return ag
      },
      { timeout: TX_TIMEOUT_MS },
    )

    await agencyService.bustCachesForAgency(agency.userId, agency.defaultPublicId)
    await agencyCoinsellerService._bustCache(agency.userId)
    await agencyService.bustRankingCache()
    await meServiceInvalidateSafe(params.applicantUserId)

    return { agency, created: true as const }
  },

  /**
   * Promote applicant to agent from `AgencyAgentApplication` after KYC complete.
   * Idempotent if agency row already exists.
   */
  async createAgencyFromApplication(params: {
    adminUserId: string
    applicantUserId: string
    applicationId: string
    commissionTier?: string
  }) {
    const existingAgency = await agencyRepository.getAgencyByUserId(params.applicantUserId)
    if (existingAgency) {
      log.info(
        { userId: params.applicantUserId },
        'createAgencyFromApplication: agency already exists, no-op',
      )
      return { agency: existingAgency, created: false as const }
    }

    const application = await agencyAgentApplicationRepository.findById(params.applicationId)
    if (!application) {
      throw new AppError(404, 'Application not found', 'APPLICATION_NOT_FOUND')
    }
    if (application.userId !== params.applicantUserId) {
      throw new AppError(
        403,
        'Application does not belong to this user',
        'APPLICATION_USER_MISMATCH',
      )
    }
    if (application.status === 'APPROVED') {
      throw new AppError(400, 'Application already approved', 'ALREADY_APPROVED')
    }
    if (application.status === 'REJECTED') {
      throw new AppError(400, 'Application was rejected', 'APPLICATION_REJECTED')
    }

    await agencyKycService.validateKycComplete(params.applicantUserId)

    const applicant = await prisma.user.findUnique({
      where: { id: params.applicantUserId },
      select: { agencyBarredAt: true, currentAgencyId: true },
    })
    if (applicant?.currentAgencyId) {
      throw new AppError(
        409,
        'Applicant is already a host in an agency',
        'ALREADY_IN_AGENCY',
      )
    }
    if (applicant?.agencyBarredAt) {
      throw new AppError(403, 'User is barred from operating an agency', 'AGENCY_BARRED')
    }

    let initialLevel = 'D'
    const explicitTier =
      params.commissionTier != null && params.commissionTier.trim() !== ''
    if (explicitTier) {
      const tierRow = await agencyCommissionRepository.getLevelRow(params.commissionTier!.trim())
      if (!tierRow) {
        throw new AppError(400, 'Invalid commission tier', 'INVALID_COMMISSION_TIER')
      }
      initialLevel = tierRow.level
    } else {
      const levels = await agencyCommissionRepository.getLevelConfig()
      initialLevel = levels[0]?.level ?? 'D'
    }

    const userRow = await prisma.user.findUnique({
      where: { id: params.applicantUserId },
      select: {
        id: true,
        defaultPublicId: true,
        username: true,
        firstName: true,
        lastName: true,
      },
    })
    if (!userRow) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const displayName = displayNameFromUser(userRow as never)

    const now = new Date()
    const agency = await prisma.$transaction(
      async (tx) => {
        const ag = await agencyRepository.createAgency(
          {
            userId: userRow.id,
            defaultPublicId: userRow.defaultPublicId,
            displayName: displayName.slice(0, 255),
          },
          tx,
        )
        await tx.agency.update({
          where: { userId: userRow.id },
          data: { currentLevel: initialLevel },
        })
        if (explicitTier) {
          await agencyCommissionService.snapshotAdminTierLock(userRow.id, initialLevel, {
            tx,
            now,
            actualWindowTotal: 0n,
          })
        }
        await tx.user.update({
          where: { id: userRow.id },
          data: { isAgent: true },
        })
        await tx.wallet.upsert({
          where: {
            userId_currencyType: {
              userId: userRow.id,
              currencyType: WalletCurrencyType.TRADING_COIN,
            },
          },
          create: {
            userId: userRow.id,
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
          update: {},
        })
        await tx.agencyAgentApplication.update({
          where: { id: params.applicationId },
          data: {
            status: 'APPROVED',
            reviewedBy: params.adminUserId,
            reviewedAt: now,
          },
        })
        await seedCoinsellerWhatsappFromKyc(tx, userRow.id)
        return ag
      },
      { timeout: TX_TIMEOUT_MS },
    )

    await agencyService.bustCachesForAgency(agency.userId, agency.defaultPublicId)
    await agencyCoinsellerService._bustCache(agency.userId)
    await agencyService.bustRankingCache()
    await agencyCommissionService.bustAgentCommissionCaches(agency.userId)
    await meServiceInvalidateSafe(params.applicantUserId)

    return { agency, created: true as const }
  },

  /** Agency row when `userId` is the owner (agent). */
  async getAgencyByOwnerId(userId: string) {
    return agencyRepository.getAgencyByUserId(userId)
  },

  async getAgencyByPublicIdString(publicIdString: string) {
    let pid: bigint
    try {
      pid = BigInt(publicIdString.trim())
    } catch {
      throw new AppError(400, 'Invalid agency public id', 'INVALID_AGENCY_ID')
    }
    return agencyRepository.getAgencyByPublicId(pid)
  },

  async getMyAgency(userId: string) {
    const [owned, hostRow, selfProfile] = await Promise.all([
      agencyRepository.getAgencyByUserId(userId),
      agencyHostRepository.getHostWithAgency(userId),
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { avatarUrl: true, firstName: true, lastName: true },
      }),
    ])

    let pendingJoin = 0
    let pendingLeave = 0
    if (owned) {
      ;[pendingJoin, pendingLeave] = await Promise.all([
        prismaRead.agencyHostApplication.count({
          where: { agencyUserId: userId, status: 'PENDING' },
        }),
        prismaRead.agencyLeaveApplication.count({
          where: { agencyUserId: userId, status: 'PENDING' },
        }),
      ])
    }

    return {
      owned,
      ownedAvatarUrl: owned ? (selfProfile?.avatarUrl ?? null) : null,
      /** Agency owner first + last when `owned` is set; empty string if both missing. */
      ownedName: owned ? formatUserName(selfProfile ?? {}) : null,
      hostMembership: hostRow,
      pendingJoinInbox: pendingJoin,
      pendingLeaveInbox: pendingLeave,
    }
  },

  /** Compact agency slice for `GET /users/me`. */
  async buildMeAgencyBlock(userId: string) {
    const [owned, hostRow] = await Promise.all([
      agencyRepository.getAgencyByUserId(userId),
      agencyHostRepository.getHostWithAgency(userId),
    ])

    let role: 'AGENT' | 'HOST' | 'NONE' = 'NONE'
    if (owned) role = 'AGENT'
    else if (hostRow) role = 'HOST'

    // pendingLeave feeds asHost only; avatarUrl + commission feed asAgent only — skip what the
    // role can't render (most users are neither, so this drops 2 queries from GET /users/me).
    const [pendingLeave, selfProfile, commissionExtras] = await Promise.all([
      hostRow ? agencyLeaveApplicationRepository.getPendingForHost(userId) : null,
      owned
        ? prismaRead.user.findUnique({
            where: { id: userId },
            select: { avatarUrl: true, firstName: true, lastName: true },
          })
        : null,
      owned ? agencyCommissionService.buildMeAgentCommissionSummary(userId) : undefined,
    ])

    return {
      role,
      asAgent: owned
        ? {
            agencyPublicId: owned.defaultPublicId.toString(),
            displayName: formatUserName(selfProfile ?? {}),
            name: formatUserName(selfProfile ?? {}),
            avatarUrl: selfProfile?.avatarUrl ?? null,
            totalHostsCount: owned.totalHostsCount,
            currentLevel: owned.currentLevel,
            payrollEnabled: owned.payrollEnabled,
            payrollPrivilegeGranted: owned.payrollPrivilegeGranted,
            paused: owned.pausedAt != null,
            ...commissionExtras,
          }
        : undefined,
      asHost: hostRow ? mapHostAgencyMeBlock(hostRow, pendingLeave) : undefined,
    }
  },

  async pauseAgency(
    userId: string,
    _source: 'CS' | 'ADMIN',
    tx?: import('@prisma/client').Prisma.TransactionClient,
    opts?: { pausedUntil?: Date | null },
  ) {
    const now = new Date()
    const run = async (inner: import('@prisma/client').Prisma.TransactionClient) => {
      return agencyRepository.setPause(
        userId,
        { pausedAt: now, pausedUntil: opts?.pausedUntil ?? null },
        inner,
      )
    }
    if (tx) return run(tx)
    const updated = await prisma.$transaction(async (inner) => run(inner), {
      timeout: TX_TIMEOUT_MS,
    })
    await cacheRedisService.del(RedisKeys.ctBalance(userId))
    await agencyService.onAgencyMutation(userId)
    return updated
  },

  async unpauseAgency(userId: string, opts?: { unfreezeWallets?: boolean; adminUserId?: string }) {
    const updated = await prisma.$transaction(
      async (tx) => agencyRepository.setPause(userId, { pausedAt: null, pausedUntil: null }, tx),
      { timeout: TX_TIMEOUT_MS },
    )
    if (opts?.unfreezeWallets !== false) {
      const { adminWalletService } = await import('./adminWallet.service')
      await adminWalletService.setAllWalletsFrozen(
        userId,
        false,
        opts?.adminUserId ?? userId,
      )
    }
    await agencyService.onAgencyMutation(userId)
    return updated
  },

  async suspendAgencyUntil(
    agencyUserId: string,
    pausedUntil: Date,
    opts?: { adminUserId?: string },
  ) {
    const agency = await agencyRepository.getAgencyByUserId(agencyUserId)
    if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')
    await agencyService.pauseAgency(agencyUserId, 'ADMIN', undefined, { pausedUntil })
    const { adminWalletService } = await import('./adminWallet.service')
    await adminWalletService.setAllWalletsFrozen(
      agencyUserId,
      true,
      opts?.adminUserId ?? agencyUserId,
    )
    return { ok: true as const, pausedUntil: pausedUntil.toISOString() }
  },

  async setCommissionTier(agencyUserId: string, commissionTier: string) {
    const agency = await agencyRepository.getAgencyByUserId(agencyUserId)
    if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')
    const lock = await agencyCommissionService.snapshotAdminTierLock(agencyUserId, commissionTier)
    await agencyCommissionService.bustAgentCommissionCaches(agencyUserId)
    await agencyService.onAgencyMutation(agencyUserId)
    return { ok: true as const, ...lock }
  },

  async setPayrollEnabled(userId: string, enabled: boolean) {
    const agency = await agencyRepository.getAgencyByUserId(userId)
    if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')
    if (enabled && !agency.payrollPrivilegeGranted) {
      throw new AppError(
        403,
        'Payroll privilege is disabled by admin',
        'PAYROLL_PRIVILEGE_DENIED',
      )
    }
    const updated = await agencyRepository.setPayrollEnabled(userId, enabled)
    await agencyService.onAgencyMutation(userId)
    return updated
  },

  /**
   * Admin: grant or revoke payroll privilege.
   * Revoke forces accept-toggle off so the agency stops receiving assignments immediately.
   */
  async setPayrollPrivilegeGranted(userId: string, granted: boolean) {
    const agency = await agencyRepository.getAgencyByUserId(userId)
    if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')
    const updated = await agencyRepository.setPayrollPrivilegeGranted(userId, granted)
    await agencyService.onAgencyMutation(userId)
    return updated
  },

  async onAgencyMutation(userId: string) {
    const ag = await agencyRepository.getAgencyByUserId(userId)
    if (ag) {
      await agencyService.bustCachesForAgency(userId, ag.defaultPublicId)
    }
    await agencyService.bustRankingCache()
  },

  /** Clear pause + unfreeze when pausedUntil has elapsed. Returns true if still paused. */
  async clearExpiredPauseIfNeeded(agencyUserId: string): Promise<boolean> {
    const ag = await agencyRepository.getAgencyByUserId(agencyUserId)
    if (!ag?.pausedAt) return false
    if (ag.pausedUntil && ag.pausedUntil.getTime() <= Date.now()) {
      await agencyService.unpauseAgency(agencyUserId)
      return false
    }
    return true
  },

  async enforcePauseGate(agencyUserId: string) {
    const stillPaused = await agencyService.clearExpiredPauseIfNeeded(agencyUserId)
    if (stillPaused) {
      throw new AppError(403, 'Agency is paused', 'AGENCY_PAUSED')
    }
  },

  async getPayrollSummary(agencyUserId: string) {
    const cacheKey = RedisKeys.payrollSummary(agencyUserId)
    const cached = await redisClient.get(cacheKey)
    if (cached) return JSON.parse(cached) as Record<string, unknown>

    const [agency, rewardSummary, tabCounts] = await Promise.all([
      prismaRead.agency.findUnique({
        where: { userId: agencyUserId },
        select: { payrollEnabled: true, payrollPrivilegeGranted: true, pausedAt: true },
      }),
      prismaRead.pointLedgerEntry.aggregate({
        where: {
          wallet: { userId: agencyUserId, currencyType: 'POINT' },
          txType: 'PAYROLL_PROCESSING_REWARD',
          direction: 'CREDIT',
        },
        _sum: { amount: true },
      }),
      payrollAssignmentRepository.countInboxByStatus(agencyUserId),
    ])

    if (!agency) throw new AppError(404, 'Agency not found', 'NOT_FOUND')

    const result = {
      takeOrderEnabled:
        agency.payrollPrivilegeGranted && agency.payrollEnabled && !agency.pausedAt,
      payrollEnabled: agency.payrollEnabled,
      payrollPrivilegeGranted: agency.payrollPrivilegeGranted,
      isPaused: !!agency.pausedAt,
      totalRewardPoints: (rewardSummary._sum.amount ?? BigInt(0)).toString(),
      tabCounts,
    }

    await redisClient.setex(cacheKey, PAYROLL_SUMMARY_TTL, JSON.stringify(result))
    return result
  },

  async getAssignmentDetail(assignmentId: string, agencyUserId: string) {
    const assignment = await payrollAssignmentRepository.getByIdForAgent(assignmentId, agencyUserId)
    if (!assignment) throw new AppError(404, 'Assignment not found', 'NOT_FOUND')

    const config = await withdrawalService.getPayrollConfig()

    const now = new Date()
    const isPendingAndActive = assignment.status === 'PENDING' && assignment.expiresAt > now
    const isWaiting = assignment.status === 'WAITING'
    const isDisputed = assignment.withdrawal.status === 'DISPUTED'

    const hostPayoutUsd = Number(assignment.withdrawal.hostPayoutUsd ?? 0)
    const hostPayoutPoints = withdrawalHostPayoutPoints({
      amountPoints: assignment.withdrawal.amountPoints,
      platformFeePoints: assignment.withdrawal.platformFeePoints,
      serviceFeePoints: assignment.withdrawal.serviceFeePoints,
    }).toString()
    const waitingSecondsRemaining =
      isWaiting && assignment.waitingExpiresAt && !isDisputed
        ? Math.max(0, Math.round((assignment.waitingExpiresAt.getTime() - now.getTime()) / 1000))
        : null

    return {
      id: assignment.id,
      status: assignment.status,
      expiresAt: assignment.expiresAt.toISOString(),
      /** PENDING: proof SLA. WAITING: seconds until waitingExpiresAt (auto-settle). */
      slaRemainingSeconds: isWaiting
        ? (waitingSecondsRemaining ?? 0)
        : Math.max(0, Math.round((assignment.expiresAt.getTime() - now.getTime()) / 1000)),
      waitingExpiresAt: assignment.waitingExpiresAt?.toISOString() ?? null,
      waitingSecondsRemaining,
      isDisputed: isWaiting && isDisputed,
      assignmentNumber: assignment.assignmentNumber,
      proofS3Key: assignment.proofS3Key ?? null,
      completedAt: assignment.completedAt?.toISOString() ?? null,
      /** Agency PAYROLL_HOST_PAYOUT points credited on settle (not host withdraw gross). */
      grossPoints: hostPayoutPoints,
      hostPayoutPoints,
      agentRewardPoints: assignment.withdrawal.agentRewardPoints?.toString() ?? '0',
      serviceFeePoints: assignment.withdrawal.serviceFeePoints?.toString() ?? null,
      hostPayoutUsd: assignment.withdrawal.hostPayoutUsd?.toString() ?? null,
      ...formatLocalAmount(
        hostPayoutUsd,
        resolveLocalFx(assignment.withdrawal.user.country, config),
      ),
      paymentMethod: assignment.withdrawal.paymentMethod
        ? isPendingAndActive
          ? mapPaymentMethodFull(assignment.withdrawal.paymentMethod)
          : mapPaymentMethodMaskedForAgent(assignment.withdrawal.paymentMethod)
        : null,
      requestedAt: assignment.withdrawal.requestedAt.toISOString(),
    }
  },
}

async function seedCoinsellerWhatsappFromKyc(tx: Prisma.TransactionClient, userId: string) {
  const kyc = await tx.agencyApplicationKyc.findUnique({
    where: { userId },
    select: { contactPhone: true },
  })
  if (!kyc?.contactPhone) return
  await tx.agencyCoinseller.upsert({
    where: { agencyUserId: userId },
    create: {
      agencyUserId: userId,
      whatsappNumber: kyc.contactPhone,
      transferChannel: AgencyTransferChannel.EPAY,
    },
    update: { whatsappNumber: kyc.contactPhone },
  })
}

async function meServiceInvalidateSafe(userId: string) {
  try {
    const { meService } = await import('./me.service')
    await meService.invalidateUserCaches(userId)
  } catch {
    /* ignore */
  }
}
