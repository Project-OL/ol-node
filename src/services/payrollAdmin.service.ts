import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { withdrawalService } from './withdrawal.service'
import { auditService } from './audit.service'
import { withdrawalRepository } from '../repositories/withdrawal.repository'
import { payrollAssignmentRepository } from '../repositories/payrollAssignment.repository'
import { storageService } from './storage.service'
import { mapPaymentMethodMaskedForAgent } from '../utils/payment-method-mask'
import { buildUserDisplayName, formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import { isAdminWithdrawalRevertable } from '../utils/admin-withdrawal-revert'

type AdminUserCard = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  avatarUrl: string | null
  country: string | null
}

function mapUserCard(u: AdminUserCard) {
  const displayName = buildUserDisplayName(u)
  return {
    userId: u.id,
    username: u.username,
    displayName,
    name: formatUserName(u),
    publicId: u.publicId.toString(),
    displayPublicId: resolveDisplayPublicId(u),
    avatarUrl: u.avatarUrl,
    country: u.country,
  }
}

function mapAdminAssignment(
  row: NonNullable<Awaited<ReturnType<typeof payrollAssignmentRepository.getByIdForAdmin>>>,
  config: { inrPerUsd: number },
) {
  const w = row.withdrawal
  const hostPayoutUsd = Number(w.hostPayoutUsd ?? 0)
  const platformFeePoints = w.platformFeePoints ?? 0n
  const hostPayoutPoints = w.amountPoints - platformFeePoints
  const proofKey = row.proofS3Key?.trim() || null

  return {
    assignmentId: row.id,
    status: row.status,
    assignmentNumber: row.assignmentNumber,
    assignedAt: row.assignedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    waitingExpiresAt: row.waitingExpiresAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason ?? null,
    /** Proof image / receipt uploaded by agency agent. */
    proofS3Key: proofKey,
    proofImageUrl: proofKey ? storageService.getCdnOrS3PublicUrl(proofKey) : null,
    agent: mapUserCard(row.agencyUser),
    host: mapUserCard(w.user),
    withdrawal: {
      withdrawalId: w.id,
      status: w.status,
      requestedAt: w.requestedAt.toISOString(),
      processedAt: w.processedAt?.toISOString() ?? null,
      disputeTicketId: w.disputeTicketId ?? null,
      assignmentCount: w.assignmentCount,
      /** Gross points withdrawn (escrowed from host). */
      grossPoints: w.amountPoints.toString(),
      /** Platform fee taken from gross. */
      platformFeePoints: platformFeePoints.toString(),
      /** Points owed / paid to host (= gross − platform fee). */
      hostPayoutPoints: hostPayoutPoints.toString(),
      hostPayoutUsd: w.hostPayoutUsd?.toString() ?? null,
      localCurrencyAmount: (hostPayoutUsd * config.inrPerUsd).toFixed(2),
      localCurrencyCode: 'INR' as const,
      /** Processing reward credited to the agency agent. */
      agentRewardPoints: (w.agentRewardPoints ?? 0n).toString(),
      notes: w.notes ?? null,
      /** True when admin may POST `/admin/agency/withdrawal/:id/reverse` (≤4 days + status). */
      canRevert: isAdminWithdrawalRevertable({
        status: w.status,
        requestedAt: w.requestedAt,
      }),
    },
    paymentMethod: w.paymentMethod ? mapPaymentMethodMaskedForAgent(w.paymentMethod) : null,
  }
}

export const payrollAdminService = {
  getConfig() {
    return withdrawalService.getPayrollConfig()
  },

  async updateConfig(
    adminUserId: string,
    updates: {
      platformFeeRateBp?: number
      agentRewardRateBp?: number
      serviceFeeUsd?: number
      minWithdrawalUsd?: number
      maxWithdrawalUsd?: number
      slaHours?: number
      waitingHours?: number
      maxAssignmentAttempts?: number
      inrPerUsd?: number
    },
  ) {
    const current = await prisma.payrollConfig.findUnique({ where: { id: 1 } })
    if (!current) {
      throw new AppError(500, 'Payroll config missing', 'CONFIG_ERROR')
    }

    const newAr = updates.agentRewardRateBp ?? current.agentRewardRateBp
    if (newAr > 10000) {
      throw new AppError(
        422,
        'Agent reward share cannot exceed 100% of platform fee',
        'INVALID_FEE_CONFIG',
      )
    }

    const data: Prisma.PayrollConfigUpdateInput = {}
    // platformFeeRateBp is stored for legacy/admin display; runtime fees use tiered rates in resolvePlatformFeeRateBp().
    if (updates.platformFeeRateBp != null) data.platformFeeRateBp = updates.platformFeeRateBp
    if (updates.agentRewardRateBp != null) data.agentRewardRateBp = updates.agentRewardRateBp
    if (updates.serviceFeeUsd != null)
      data.serviceFeeUsd = new Prisma.Decimal(updates.serviceFeeUsd)
    if (updates.minWithdrawalUsd != null)
      data.minWithdrawalUsd = new Prisma.Decimal(updates.minWithdrawalUsd)
    if (updates.maxWithdrawalUsd != null)
      data.maxWithdrawalUsd = new Prisma.Decimal(updates.maxWithdrawalUsd)
    if (updates.slaHours != null) data.slaHours = updates.slaHours
    if (updates.waitingHours != null) data.waitingHours = updates.waitingHours
    if (updates.maxAssignmentAttempts != null)
      data.maxAssignmentAttempts = updates.maxAssignmentAttempts
    if (updates.inrPerUsd != null) data.inrPerUsd = new Prisma.Decimal(updates.inrPerUsd)
    data.updatedByUserId = adminUserId

    await prisma.payrollConfig.update({
      where: { id: 1 },
      data,
    })

    await withdrawalService.bustPayrollConfigCache()
    return withdrawalService.getPayrollConfig()
  },

  async listPendingPlatformWithdrawals(opts: { limit: number; cursor?: string }) {
    const rows = await withdrawalRepository.listPendingPlatform(opts)
    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined
    return {
      items: page.map((w) => withdrawalService.serializeWithdrawal(w)),
      nextCursor,
      hasMore,
    }
  },

  async manuallyAssignWithdrawal(adminUserId: string, withdrawalId: string, agencyUserId?: string) {
    await withdrawalService.assignToAgency(withdrawalId, {
      overrideAgencyUserId: agencyUserId,
      allowBeyondAssignmentCap: true,
      rejectOnIneligibleOverride: !!agencyUserId,
    })
    auditService.log({
      userId: adminUserId,
      actionType: 'WITHDRAWAL_MANUAL_ASSIGN',
      actionStatus: 'success',
      actionDetails: { withdrawalId, agencyUserId: agencyUserId ?? null },
    })
  },

  getDisputedPayrolls(opts: { limit: number; cursor?: string }) {
    return withdrawalService.getAdminDisputedPayrolls(opts)
  },

  async listAssignments(query: {
    status?: string
    agencyUserId?: string
    hostUserId?: string
    withdrawalId?: string
    from?: string
    to?: string
    cursor?: string
    limit: number
  }) {
    const from = query.from ? new Date(query.from) : undefined
    const to = query.to ? new Date(query.to) : undefined
    if (from && Number.isNaN(from.getTime())) {
      throw new AppError(400, 'Invalid from', 'INVALID_REQUEST')
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new AppError(400, 'Invalid to', 'INVALID_REQUEST')
    }

    const rows = await payrollAssignmentRepository.listForAdmin({
      status: query.status,
      agencyUserId: query.agencyUserId,
      hostUserId: query.hostUserId,
      withdrawalId: query.withdrawalId,
      from,
      to,
      cursor: query.cursor,
      limit: query.limit,
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const config = await withdrawalService.getPayrollConfig()
    return {
      items: page.map((r) => mapAdminAssignment(r, config)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    }
  },

  async getAssignmentDetail(assignmentId: string) {
    const row = await payrollAssignmentRepository.getByIdForAdmin(assignmentId)
    if (!row) throw new AppError(404, 'Assignment not found', 'NOT_FOUND')
    const config = await withdrawalService.getPayrollConfig()
    return mapAdminAssignment(row, config)
  },
}
