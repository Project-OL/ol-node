import { AgencyHostHistoryReason, PointTxType, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { RedisKeys } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { cacheRedisService } from './cacheRedis.service'
import { agencyRepository } from '../repositories/agency.repository'
import { agencyApplicationRepository } from '../repositories/agencyApplication.repository'
import { agencyHostRepository } from '../repositories/agencyHost.repository'
import { agencyLeaveApplicationRepository } from '../repositories/agencyLeaveApplication.repository'
import { enqueueLeaveAutoApprove, removeLeaveAutoApproveJob } from '../queues/agency.queue'
import { agencyService } from './agency.service'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { walletLevelService } from './user-level.service'
import { userRepository } from '../repositories/user.repository'
import { bigIntToStr, formatDuration } from '../utils/bigint'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'

type HostEarningsAgg = {
  hostEarnings: bigint
  hostCommission: bigint
  liveDurationSeconds: bigint
}

const TX_MS = 20_000
const DAY_MS = 24 * 60 * 60 * 1000
/** Wait after host exit / rejected join before joining another agency. */
const JOIN_COOLDOWN_MS = DAY_MS
/** Wait after a resolved leave application before filing another leave. */
const LEAVE_COOLDOWN_MS = 30 * DAY_MS
const REMOVAL_TENURE_MS = 7 * DAY_MS
const REMOVAL_INACTIVE_MS = 30 * DAY_MS
/** Membership shorter than 24 hours → immediate exit (no leave application). */
const IMMEDIATE_LEAVE_MS = DAY_MS
const LATE_APPROVE_MS = 14 * DAY_MS
const AUTO_APPROVE_MS = 7 * DAY_MS

function nextAllowedFrom(ts: Date, cooldownMs: number): Date {
  return new Date(ts.getTime() + cooldownMs)
}

function computeAge(dob: Date | null): number | null {
  if (!dob) return null
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const m = today.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
    age--
  }
  return age >= 0 ? age : null
}

function mapHostProfileFields(
  hostUserId: string,
  host: {
    id: string
    publicId: bigint
    defaultPublicId: bigint
    currentVipPublicId: bigint | null
    username: string
    firstName: string | null
    lastName: string | null
    avatarUrl: string | null
    gender: string | null
    dateOfBirth: Date | null
  },
  levels: Map<string, { livestreamLevel: number; wealthLevel: number }>,
) {
  const level = levels.get(hostUserId)
  const displayName = buildUserDisplayName(host)
  return {
    userId: host.id,
    publicId: host.publicId.toString(),
    displayPublicId: resolveDisplayPublicId(host),
    name: displayName,
    gender: host.gender,
    age: computeAge(host.dateOfBirth),
    wealthLevel: level?.wealthLevel ?? 0,
    livestreamLevel: level?.livestreamLevel ?? 0,
    avatarUrl: host.avatarUrl,
    displayName,
  }
}

function mapHostListItem(
  row: {
    hostUserId: string
    joinedAt: Date
    host: {
      id: string
      publicId: bigint
      defaultPublicId: bigint
      currentVipPublicId: bigint | null
      username: string
      firstName: string | null
      lastName: string | null
      avatarUrl: string | null
      gender: string | null
      dateOfBirth: Date | null
      isTagged: boolean
      hourlyWage: bigint
    }
  },
  levels: Map<string, { livestreamLevel: number; wealthLevel: number }>,
  earnings: Map<string, HostEarningsAgg>,
) {
  const agg = earnings.get(row.hostUserId)
  const liveDurationSeconds = agg?.liveDurationSeconds ?? 0n
  const hostCommission = agg?.hostCommission ?? 0n
  return {
    hostUserId: row.hostUserId,
    ...mapHostProfileFields(row.hostUserId, row.host, levels),
    isTagged: row.host.isTagged,
    joinedAt: row.joinedAt.toISOString(),
    hostEarnings: bigIntToStr(agg?.hostEarnings ?? 0n),
    /** Commission points credited to the agency from this host (AGENT_COMMISSION ledger). */
    hostCommission: bigIntToStr(hostCommission),
    /** Alias for clients that label agency cut as "hostAgency". */
    hostAgency: bigIntToStr(hostCommission),
    hourlyWage: bigIntToStr(row.host.hourlyWage ?? 0n),
    liveDurationSeconds: bigIntToStr(liveDurationSeconds),
    liveDurationFormatted: formatDuration(liveDurationSeconds),
  }
}

async function finalizeAgencyHostExit(
  agencyUserId: string,
  hostUserId: string,
  reason: AgencyHostHistoryReason,
  tx: Prisma.TransactionClient,
  metadata?: Prisma.InputJsonValue,
) {
  const row = await tx.agencyHost.findUnique({
    where: { hostUserId },
  })
  if (!row || row.agencyUserId !== agencyUserId) {
    return
  }

  await agencyHostRepository.insertHistory(
    {
      agencyUserId,
      hostUserId,
      joinedAt: row.joinedAt,
      reason,
      exitMetadata: metadata ?? undefined,
    },
    tx,
  )

  await agencyHostRepository.removeHost(hostUserId, tx)
  await tx.user.update({
    where: { id: hostUserId },
    data: { currentAgencyId: null },
  })
  await agencyRepository.incrementHostCount(agencyUserId, -1, tx)
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

/** Same face gate as agency KYC: `face_verified` on KYC row or indexed face profile. */
async function isHostFaceVerified(hostUserId: string): Promise<boolean> {
  const [kyc, profile] = await Promise.all([
    prismaRead.agencyApplicationKyc.findUnique({
      where: { userId: hostUserId },
      select: { faceVerified: true },
    }),
    prismaRead.userFaceProfile.findUnique({
      where: { userId: hostUserId },
      select: { status: true },
    }),
  ])
  return Boolean(kyc?.faceVerified) || profile?.status === 'INDEXED'
}

async function assertJoinCooldown(hostUserId: string): Promise<void> {
  const recentExit = await agencyHostRepository.getRecentExitForHost(hostUserId)
  if (recentExit && Date.now() - recentExit.exitedAt.getTime() < JOIN_COOLDOWN_MS) {
    throw new AppError(429, 'Agency application cooldown', 'AGENCY_APPLICATION_COOLDOWN', {
      nextAllowedAt: nextAllowedFrom(recentExit.exitedAt, JOIN_COOLDOWN_MS).toISOString(),
    })
  }

  const recentReject = await agencyHostRepository.findLatestRejectedApplication(hostUserId)
  if (recentReject?.resolvedAt && Date.now() - recentReject.resolvedAt.getTime() < JOIN_COOLDOWN_MS) {
    throw new AppError(429, 'Agency application cooldown', 'AGENCY_APPLICATION_COOLDOWN', {
      nextAllowedAt: nextAllowedFrom(recentReject.resolvedAt, JOIN_COOLDOWN_MS).toISOString(),
    })
  }
}

export const agencyHostService = {
  async applyToAgency(hostUserId: string, agencyPublicId: string, message?: string | null) {
    let agencyPid: bigint
    try {
      agencyPid = BigInt(agencyPublicId.trim())
    } catch {
      throw new AppError(400, 'Invalid agency id', 'INVALID_AGENCY_ID')
    }

    const agency = await agencyRepository.getAgencyByPublicId(agencyPid)
    if (!agency) {
      throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')
    }

    if (agency.userId === hostUserId) {
      throw new AppError(403, 'Cannot apply to your own agency', 'INVALID_APPLICANT')
    }

    await agencyService.enforcePauseGate(agency.userId)

    const hostUser = await prisma.user.findUnique({
      where: { id: hostUserId },
      select: {
        id: true,
        currentAgencyId: true,
        isAgent: true,
      },
    })
    if (!hostUser) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }
    if (hostUser.isAgent) {
      throw new AppError(403, 'Agents cannot apply as hosts', 'INVALID_APPLICANT')
    }
    if (hostUser.currentAgencyId) {
      throw new AppError(409, 'Already in an agency', 'ALREADY_IN_AGENCY')
    }

    await assertJoinCooldown(hostUserId)

    const now = new Date()
    try {
      await prisma.$transaction(
        async (tx) => {
          await agencyApplicationRepository.createAcceptedApplication(
            {
              agencyUserId: agency.userId,
              hostUserId,
              message: message ?? undefined,
              resolvedAt: now,
            },
            tx,
          )
          await agencyHostRepository.insertHost({ agencyUserId: agency.userId, hostUserId }, tx)
          await tx.user.update({
            where: { id: hostUserId },
            data: { currentAgencyId: agency.userId },
          })
          await agencyRepository.incrementHostCount(agency.userId, 1, tx)
        },
        { isolationLevel: 'Serializable', timeout: TX_MS },
      )
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new AppError(409, 'Already in an agency', 'ALREADY_IN_AGENCY')
      }
      throw e
    }

    await cacheRedisService.del(RedisKeys.agencyMe(hostUserId))
    await agencyService.onAgencyMutation(agency.userId)
    return { ok: true as const, immediate: true as const }
  },

  /**
   * @deprecated Instant join — cancel is no longer part of the happy path.
   * Legacy PENDING rows may still be deleted; ACCEPTED rows return INVALID_STATE.
   */
  async cancelApplication(hostUserId: string, applicationId: string) {
    const app = await agencyApplicationRepository.getApplicationById(applicationId)
    if (!app || app.hostUserId !== hostUserId) {
      throw new AppError(404, 'Application not found', 'NOT_FOUND')
    }
    if (app.status !== 'PENDING') {
      throw new AppError(409, 'Cannot cancel', 'INVALID_STATE')
    }
    await prisma.$transaction(
      async (tx) => {
        await agencyApplicationRepository.deletePending(applicationId, hostUserId, tx)
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )
    await agencyService.onAgencyMutation(app.agencyUserId)
    return { ok: true as const }
  },

  /** @deprecated Instant auto-join — agent accept removed from HTTP API. */
  async acceptApplication(agentUserId: string, applicationId: string) {
    await prisma.$transaction(
      async (tx) => {
        const app = await tx.agencyHostApplication.findUnique({
          where: { id: applicationId },
        })
        if (!app || app.agencyUserId !== agentUserId) {
          throw new AppError(404, 'Application not found', 'NOT_FOUND')
        }
        if (app.status !== 'PENDING') {
          throw new AppError(409, 'Invalid application state', 'INVALID_STATE')
        }

        const host = await tx.user.findUnique({
          where: { id: app.hostUserId },
          select: {
            id: true,
            currentAgencyId: true,
            isAgent: true,
          },
        })
        if (!host) {
          throw new AppError(404, 'Host not found', 'USER_NOT_FOUND')
        }
        if (host.currentAgencyId) {
          throw new AppError(409, 'Host joined another agency', 'CONFLICT')
        }

        await agencyApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: 'ACCEPTED',
            resolvedByUserId: agentUserId,
          },
          tx,
        )

        await agencyHostRepository.insertHost(
          { agencyUserId: agentUserId, hostUserId: app.hostUserId },
          tx,
        )
        await tx.user.update({
          where: { id: app.hostUserId },
          data: { currentAgencyId: agentUserId },
        })
        await agencyRepository.incrementHostCount(agentUserId, 1, tx)
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )

    const app = await agencyApplicationRepository.getApplicationById(applicationId)
    if (app) await agencyService.onAgencyMutation(app.agencyUserId)
    return { ok: true as const }
  },

  /** @deprecated Instant auto-join — agent reject removed from HTTP API. */
  async rejectApplication(agentUserId: string, applicationId: string, _reason?: string | null) {
    await prisma.$transaction(
      async (tx) => {
        const app = await tx.agencyHostApplication.findUnique({
          where: { id: applicationId },
        })
        if (!app || app.agencyUserId !== agentUserId) {
          throw new AppError(404, 'Application not found', 'NOT_FOUND')
        }
        if (app.status !== 'PENDING') {
          throw new AppError(409, 'Invalid application state', 'INVALID_STATE')
        }
        await agencyApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: 'REJECTED',
            resolvedByUserId: agentUserId,
          },
          tx,
        )
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )

    const app = await agencyApplicationRepository.getApplicationById(applicationId)
    if (app) await agencyService.onAgencyMutation(app.agencyUserId)
    return { ok: true as const }
  },

  async applyToLeave(hostUserId: string, reason?: string | null) {
    const membership = await agencyHostRepository.getHost(hostUserId)
    if (!membership) {
      throw new AppError(404, 'Not a host in any agency', 'NOT_IN_AGENCY')
    }

    await agencyService.enforcePauseGate(membership.agencyUserId)

    const pending = await agencyLeaveApplicationRepository.getPendingForHost(hostUserId)
    if (pending) {
      throw new AppError(409, 'Leave application pending', 'APPLICATION_PENDING')
    }

    const lastResolved = await agencyHostRepository.findLatestResolvedLeaveApplication(hostUserId)
    if (lastResolved?.resolvedAt && Date.now() - lastResolved.resolvedAt.getTime() < LEAVE_COOLDOWN_MS) {
      throw new AppError(429, 'Leave cooldown', 'LEAVE_COOLDOWN', {
        nextAllowedAt: nextAllowedFrom(lastResolved.resolvedAt, LEAVE_COOLDOWN_MS).toISOString(),
      })
    }

    const joinedMs = Date.now() - membership.joinedAt.getTime()
    const faceVerified = await isHostFaceVerified(hostUserId)
    const immediateLeave = joinedMs < IMMEDIATE_LEAVE_MS || !faceVerified

    if (immediateLeave) {
      await prisma.$transaction(
        async (tx) => {
          await finalizeAgencyHostExit(
            membership.agencyUserId,
            hostUserId,
            'LEAVE_AUTO_APPROVED',
            tx,
            {
              immediateWithin24h: joinedMs < IMMEDIATE_LEAVE_MS,
              immediateUnverifiedFace: !faceVerified,
            },
          )
        },
        { isolationLevel: 'Serializable', timeout: TX_MS },
      )
      await agencyService.onAgencyMutation(membership.agencyUserId)
      return { ok: true as const, immediate: true as const }
    }

    const autoAt = new Date(Date.now() + AUTO_APPROVE_MS)
    const created = await prisma.$transaction(
      async (tx) => {
        return agencyLeaveApplicationRepository.create(
          {
            agencyUserId: membership.agencyUserId,
            hostUserId,
            reason: reason ?? undefined,
            autoApproveAt: autoAt,
          },
          tx,
        )
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )

    await enqueueLeaveAutoApprove(created.id, autoAt)
    await agencyService.onAgencyMutation(membership.agencyUserId)
    return {
      ok: true as const,
      immediate: false as const,
      applicationId: created.id,
      autoApproveAt: autoAt.toISOString(),
    }
  },

  async cancelLeaveApplication(hostUserId: string, applicationId: string) {
    const row = await agencyLeaveApplicationRepository.getById(applicationId)
    if (!row || row.hostUserId !== hostUserId) {
      throw new AppError(404, 'Leave application not found', 'NOT_FOUND')
    }
    if (row.status !== 'PENDING') {
      throw new AppError(409, 'Cannot cancel', 'INVALID_STATE')
    }
    await removeLeaveAutoApproveJob(applicationId)
    const now = new Date()
    const updated = await prisma.$transaction(
      async (tx) => {
        const count = await agencyLeaveApplicationRepository.cancelPending(
          applicationId,
          hostUserId,
          tx,
        )
        return count
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )
    if (updated.count === 0) {
      throw new AppError(409, 'Cannot cancel', 'INVALID_STATE')
    }
    await cacheRedisService.del(RedisKeys.agencyMe(hostUserId))
    await agencyService.onAgencyMutation(row.agencyUserId)
    return { ok: true as const, cancelledAt: now.toISOString() }
  },

  async acceptLeaveApplication(agentUserId: string, applicationId: string) {
    await removeLeaveAutoApproveJob(applicationId)
    await prisma.$transaction(
      async (tx) => {
        const row = await tx.agencyLeaveApplication.findUnique({
          where: { id: applicationId },
        })
        if (!row || row.agencyUserId !== agentUserId) {
          throw new AppError(404, 'Leave application not found', 'NOT_FOUND')
        }
        if (row.status !== 'PENDING') {
          throw new AppError(409, 'Invalid state', 'INVALID_STATE')
        }
        await agencyLeaveApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: 'APPROVED',
            resolvedByUserId: agentUserId,
          },
          tx,
        )
        await finalizeAgencyHostExit(row.agencyUserId, row.hostUserId, 'LEAVE_APPROVED', tx)
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )
    const row = await agencyLeaveApplicationRepository.getById(applicationId)
    if (row) await agencyService.onAgencyMutation(row.agencyUserId)
    return { ok: true as const }
  },

  async rejectLeaveApplication(
    agentUserId: string,
    applicationId: string,
    _reason?: string | null,
  ) {
    const lateUntil = new Date(Date.now() + LATE_APPROVE_MS)
    await prisma.$transaction(
      async (tx) => {
        const row = await tx.agencyLeaveApplication.findUnique({
          where: { id: applicationId },
        })
        if (!row || row.agencyUserId !== agentUserId) {
          throw new AppError(404, 'Leave application not found', 'NOT_FOUND')
        }
        if (row.status !== 'PENDING') {
          throw new AppError(409, 'Invalid state', 'INVALID_STATE')
        }
        await tx.agencyLeaveApplication.update({
          where: { id: applicationId },
          data: {
            status: 'REJECTED',
            resolvedAt: new Date(),
            resolvedByUserId: agentUserId,
            lateApproveUntil: lateUntil,
          },
        })
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )
    const row = await agencyLeaveApplicationRepository.getById(applicationId)
    if (row) await agencyService.onAgencyMutation(row.agencyUserId)
    return { ok: true as const, lateApproveUntil: lateUntil.toISOString() }
  },

  async lateAcceptLeaveApplication(agentUserId: string, applicationId: string) {
    await prisma.$transaction(
      async (tx) => {
        const row = await tx.agencyLeaveApplication.findUnique({
          where: { id: applicationId },
        })
        if (!row || row.agencyUserId !== agentUserId) {
          throw new AppError(404, 'Leave application not found', 'NOT_FOUND')
        }
        if (row.status !== 'REJECTED') {
          throw new AppError(409, 'Invalid state', 'INVALID_STATE')
        }
        if (!row.lateApproveUntil || Date.now() > row.lateApproveUntil.getTime()) {
          throw new AppError(403, 'Late accept window expired', 'LATE_ACCEPT_EXPIRED')
        }
        await agencyLeaveApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: 'LATE_APPROVED',
            resolvedByUserId: agentUserId,
          },
          tx,
        )
        await finalizeAgencyHostExit(row.agencyUserId, row.hostUserId, 'LEAVE_LATE_APPROVED', tx)
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )
    await removeLeaveAutoApproveJob(applicationId)
    const row = await agencyLeaveApplicationRepository.getById(applicationId)
    if (row) await agencyService.onAgencyMutation(row.agencyUserId)
    return { ok: true as const }
  },

  async removeHost(agentUserId: string, hostUserId: string) {
    const membership = await agencyHostRepository.getHost(hostUserId)
    if (!membership || membership.agencyUserId !== agentUserId) {
      throw new AppError(404, 'Host not in your agency', 'NOT_FOUND')
    }

    const hostUser = await prisma.user.findUnique({
      where: { id: hostUserId },
      select: { status: true, lastActiveAt: true },
    })
    if (!hostUser) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    let reason: AgencyHostHistoryReason | null = null
    if (hostUser.status === 'suspended') {
      reason = 'REMOVED_SUSPENDED'
    } else {
      const tenureOk = Date.now() - membership.joinedAt.getTime() >= REMOVAL_TENURE_MS
      const lastActive = hostUser.lastActiveAt
      const inactiveOk =
        lastActive == null || Date.now() - lastActive.getTime() >= REMOVAL_INACTIVE_MS
      if (tenureOk && inactiveOk) {
        reason = 'REMOVED_INACTIVE'
      }
    }

    if (!reason) {
      throw new AppError(403, 'Removal not permitted', 'REMOVAL_NOT_PERMITTED', {
        reason: 'Host must be suspended, or in agency >7d with lastActiveAt >30d ago',
      })
    }

    await prisma.$transaction(
      async (tx) => {
        await finalizeAgencyHostExit(agentUserId, hostUserId, reason!, tx)
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )
    await agencyService.onAgencyMutation(agentUserId)
    return { ok: true as const }
  },

  async adminRemoveHostFromAgency(hostUserId: string, adminUserId: string) {
    const membership = await agencyHostRepository.getHost(hostUserId)
    if (!membership) {
      throw new AppError(404, 'User is not in an agency', 'NOT_IN_AGENCY')
    }

    const agencyUserId = membership.agencyUserId
    await prisma.$transaction(
      async (tx) => {
        await finalizeAgencyHostExit(
          agencyUserId,
          hostUserId,
          'ADMIN_FORCE_EXIT' as import('@prisma/client').AgencyHostHistoryReason,
          tx,
          {
            adminUserId,
            source: 'admin_user_moderation',
          },
        )
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )
    await agencyService.onAgencyMutation(agencyUserId)
    return { ok: true as const, userId: hostUserId, agencyUserId }
  },

  async forceExitFromCS(params: {
    hostUserId: string
    ticketId: bigint
    deductPoints?: bigint
    pauseAgency?: boolean
    csUserId: string
  }) {
    const membership = await agencyHostRepository.getHost(params.hostUserId)
    if (!membership) {
      throw new AppError(404, 'Host not in an agency', 'NOT_IN_AGENCY')
    }

    const agencyUserId = membership.agencyUserId
    const idemBase = `agency-force-exit:${params.ticketId.toString()}`

    await prisma.$transaction(
      async (tx) => {
        if (params.deductPoints != null && params.deductPoints > 0n) {
          await pointWalletService.debit(
            params.hostUserId,
            params.deductPoints,
            PointTxType.AGENCY_FORCE_EXIT_PENALTY,
            tx,
            {
              idempotencyKey: `${idemBase}:points`,
              description: 'Agency force exit (CS)',
              refId: params.ticketId.toString(),
              // System-initiated penalty — not subject to the available-points gate.
              availabilityCheck: false,
            },
          )
        }

        if (params.pauseAgency) {
          await agencyRepository.setPause(
            agencyUserId,
            { pausedAt: new Date(), pausedUntil: null },
            tx,
          )
        }

        await finalizeAgencyHostExit(agencyUserId, params.hostUserId, 'CS_FORCE_EXIT', tx, {
          ticketId: params.ticketId.toString(),
          csUserId: params.csUserId,
        })
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )

    if (params.deductPoints != null && params.deductPoints > 0n) {
      await walletService.adjustPointBalanceCache(params.hostUserId, -params.deductPoints)
    }
    await agencyService.onAgencyMutation(agencyUserId)
    return { ok: true as const }
  },

  async processAutoApproveJob(applicationId: string) {
    await prisma.$transaction(
      async (tx) => {
        const row = await tx.agencyLeaveApplication.findUnique({
          where: { id: applicationId },
        })
        if (!row || row.status !== 'PENDING') {
          return
        }
        await agencyLeaveApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: 'AUTO_APPROVED',
            resolvedByUserId: null,
          },
          tx,
        )
        await finalizeAgencyHostExit(row.agencyUserId, row.hostUserId, 'LEAVE_AUTO_APPROVED', tx)
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )
    const row = await agencyLeaveApplicationRepository.getById(applicationId)
    if (row) await agencyService.onAgencyMutation(row.agencyUserId)
  },

  async handleAgentAccountDeletion(
    agentUserId: string,
    tx: Prisma.TransactionClient,
    reason: AgencyHostHistoryReason = 'AGENT_DELETED',
  ) {
    const hostIds = await tx.agencyHost.findMany({
      where: { agencyUserId: agentUserId },
      select: { hostUserId: true },
    })
    for (const h of hostIds) {
      await finalizeAgencyHostExit(agentUserId, h.hostUserId, reason, tx)
    }
    await tx.agency.deleteMany({ where: { userId: agentUserId } })
    await tx.user.update({
      where: { id: agentUserId },
      data: { isAgent: false },
    })
  },

  async handleHostAccountDeletion(hostUserId: string, tx: Prisma.TransactionClient) {
    const membership = await tx.agencyHost.findUnique({
      where: { hostUserId },
    })
    if (!membership) return
    await finalizeAgencyHostExit(membership.agencyUserId, hostUserId, 'HOST_DELETED', tx)
  },

  async listLeaveApplicationsInbox(
    agencyUserId: string,
    params: { limit: number; cursor?: string | null },
  ) {
    const rows = await agencyLeaveApplicationRepository.listInbox(agencyUserId, params)
    const hasMore = rows.length > params.limit
    const page = hasMore ? rows.slice(0, params.limit) : rows
    const hostIds = page.map((r) => r.hostUserId)
    const levels =
      hostIds.length > 0
        ? await walletLevelService.getDisplayLevelsForUsers(hostIds)
        : new Map<string, { livestreamLevel: number; wealthLevel: number }>()
    const nextCursor =
      hasMore && page.length > 0
        ? `${page[page.length - 1]!.createdAt.toISOString()}|${page[page.length - 1]!.id}`
        : null
    return {
      items: page.map((row) => ({
        id: row.id,
        hostUserId: row.hostUserId,
        status: row.status,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
        autoApproveAt: row.autoApproveAt.toISOString(),
        lateApproveUntil: row.lateApproveUntil?.toISOString() ?? null,
        ...mapHostProfileFields(row.hostUserId, row.host, levels),
      })),
      nextCursor,
    }
  },

  async listHosts(agencyUserId: string, params: { limit: number; cursor?: string | null }) {
    const rows = await agencyHostRepository.listHosts(agencyUserId, params)
    const hasMore = rows.length > params.limit
    const page = hasMore ? rows.slice(0, params.limit) : rows
    const hostIds = page.map((r) => r.hostUserId)
    const [levels, earnings] = await Promise.all([
      hostIds.length > 0
        ? walletLevelService.getDisplayLevelsForUsers(hostIds)
        : new Map<string, { livestreamLevel: number; wealthLevel: number }>(),
      agencyHostRepository.getHostEarningsAggregates(agencyUserId, hostIds),
    ])
    const nextCursor =
      hasMore && page.length > 0
        ? `${page[page.length - 1]!.joinedAt.toISOString()}|${page[page.length - 1]!.hostUserId}`
        : null
    return {
      items: page.map((row) => mapHostListItem(row, levels, earnings)),
      nextCursor,
    }
  },

  async setHostTagged(agentUserId: string, hostUserId: string, isTagged: boolean) {
    const agency = await agencyRepository.getAgencyByUserId(agentUserId)
    if (!agency) {
      throw new AppError(403, 'Not an agency owner', 'FORBIDDEN')
    }
    const membership = await agencyHostRepository.getHost(hostUserId)
    if (!membership || membership.agencyUserId !== agency.userId) {
      throw new AppError(404, 'Host not in your agency', 'HOST_NOT_FOUND')
    }
    const updated = await userRepository.setIsTagged(hostUserId, isTagged)
    return { ok: true, userId: updated.id, isTagged: updated.isTagged }
  },

  async setHostTaggedByAdmin(hostUserId: string, isTagged: boolean) {
    const membership = await agencyHostRepository.getHost(hostUserId)
    if (!membership) {
      throw new AppError(404, 'User is not an agency host', 'HOST_NOT_FOUND')
    }
    const updated = await userRepository.setIsTagged(hostUserId, isTagged)
    return { ok: true, userId: updated.id, isTagged: updated.isTagged }
  },

  /** Admin bypass: add host to agency without cooldown gates. */
  async adminAddHost(agencyUserId: string, hostUserId: string, adminUserId: string) {
    const agency = await agencyRepository.getAgencyByUserId(agencyUserId)
    if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')

    const hostUser = await prisma.user.findUnique({
      where: { id: hostUserId },
      select: { id: true, currentAgencyId: true, isAgent: true },
    })
    if (!hostUser) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    if (hostUser.isAgent) {
      throw new AppError(403, 'Agents cannot be added as hosts', 'INVALID_APPLICANT')
    }
    if (hostUser.currentAgencyId) {
      throw new AppError(409, 'Host already in an agency', 'ALREADY_IN_AGENCY')
    }

    const now = new Date()
    try {
      await prisma.$transaction(
        async (tx) => {
          await agencyApplicationRepository.createAcceptedApplication(
            {
              agencyUserId,
              hostUserId,
              resolvedAt: now,
            },
            tx,
          )
          await agencyHostRepository.insertHost({ agencyUserId, hostUserId }, tx)
          await tx.user.update({
            where: { id: hostUserId },
            data: { currentAgencyId: agencyUserId },
          })
          await agencyRepository.incrementHostCount(agencyUserId, 1, tx)
        },
        { isolationLevel: 'Serializable', timeout: TX_MS },
      )
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new AppError(409, 'Already in an agency', 'ALREADY_IN_AGENCY')
      }
      throw e
    }

    await cacheRedisService.del(RedisKeys.agencyMe(hostUserId))
    await agencyService.onAgencyMutation(agencyUserId)
    return { ok: true as const, hostUserId, agencyUserId, adminUserId }
  },

  async adminTransferHosts(params: {
    sourceAgencyUserId: string
    targetAgencyUserId: string
    hostUserIds: string[]
    adminUserId: string
  }) {
    if (params.sourceAgencyUserId === params.targetAgencyUserId) {
      throw new AppError(400, 'Source and target agency must differ', 'INVALID_REQUEST')
    }

    const [source, target] = await Promise.all([
      agencyRepository.getAgencyByUserId(params.sourceAgencyUserId),
      agencyRepository.getAgencyByUserId(params.targetAgencyUserId),
    ])
    if (!source) throw new AppError(404, 'Source agency not found', 'AGENCY_NOT_FOUND')
    if (!target) throw new AppError(404, 'Target agency not found', 'AGENCY_NOT_FOUND')

    const transferred: string[] = []
    await prisma.$transaction(
      async (tx) => {
        for (const hostUserId of params.hostUserIds) {
          const membership = await tx.agencyHost.findUnique({ where: { hostUserId } })
          if (!membership || membership.agencyUserId !== params.sourceAgencyUserId) {
            throw new AppError(404, 'Host not in source agency', 'HOST_NOT_FOUND', {
              hostUserId,
            })
          }

          await finalizeAgencyHostExit(
            params.sourceAgencyUserId,
            hostUserId,
            'ADMIN_FORCE_EXIT',
            tx,
            {
              adminUserId: params.adminUserId,
              source: 'admin_agency_transfer',
              targetAgencyUserId: params.targetAgencyUserId,
            },
          )

          await agencyHostRepository.insertHost(
            { agencyUserId: params.targetAgencyUserId, hostUserId },
            tx,
          )
          await tx.user.update({
            where: { id: hostUserId },
            data: { currentAgencyId: params.targetAgencyUserId },
          })
          await agencyRepository.incrementHostCount(params.targetAgencyUserId, 1, tx)
          transferred.push(hostUserId)
        }
      },
      { isolationLevel: 'Serializable', timeout: TX_MS },
    )

    for (const hostUserId of transferred) {
      await cacheRedisService.del(RedisKeys.agencyMe(hostUserId))
    }
    await agencyService.onAgencyMutation(params.sourceAgencyUserId)
    await agencyService.onAgencyMutation(params.targetAgencyUserId)

    return {
      ok: true as const,
      transferredCount: transferred.length,
      hostUserIds: transferred,
    }
  },
}
