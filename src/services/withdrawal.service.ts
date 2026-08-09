import { randomUUID } from 'crypto'
import {
  Prisma,
  WithdrawalStatus,
  PointTxType,
  WalletCurrencyType,
  LedgerDirection,
} from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { redisClient, RedisKeys, PAYROLL_CONFIG_TTL, PAYROLL_SUMMARY_TTL } from '../config/redis'
import { cacheRedisService } from './cacheRedis.service'
import { bustAgencyDashboardCaches } from './agencyDashboard.service'
import {
  resolveCommissionPeriod,
  commissionPeriodToLedgerBounds,
  utcDateString,
} from '../utils/datetime'
import { AppError } from '../middlewares/errorHandler'
import { countryEqualsFilter } from '../utils/agency-country'
import { withSerializationRetry } from '../utils/txRetry'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { assertPointsDebitAllowed } from './wallet-freeze.service'
import { walletRepository } from '../repositories/wallet.repository'
import { withdrawalRepository } from '../repositories/withdrawal.repository'
import { payrollAssignmentRepository } from '../repositories/payrollAssignment.repository'
import { userPaymentMethodRepository } from '../repositories/userPaymentMethod.repository'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { auditService } from './audit.service'
import { supportService } from './support.service'
import { storageService } from './storage.service'
import { withdrawalPayoutRailConfigService } from './withdrawalPayoutRailConfig.service'
import { enqueuePlatformWithdrawalMessage } from '../queues/platform-message.queue'
import {
  enqueuePayrollSla,
  enqueuePayrollWaiting,
  removePayrollSla,
  removePayrollWaiting,
} from '../queues/payroll.queue'
import { mapPaymentMethodMaskedForAgent } from '../utils/payment-method-mask'
import { s3Bucket } from '../config/s3'
import {
  mapPaymentMethodForAgent,
  mapPaymentMethodMaskedForHost,
} from '../utils/payment-method-mask'
import { formatDuration } from '../utils/withdrawal-formatters'
import { resolvePlatformFeeRateBp } from '../utils/payroll-fee'
import type { DisputeWithdrawalInput } from '../models/withdrawal.schemas'
import type { InboxAssignmentRow } from '../repositories/payrollAssignment.repository'
import type { AssignmentListCursor } from '../repositories/payrollAssignment.repository'

const INTERACTIVE_TX_MS = 25_000
const DISPUTE_EVIDENCE_PRESIGN_TTL = 600

type AssignmentCursorPayload = { updatedAt: string; id: string }

function userDisplayName(user: {
  username: string
  firstName: string | null
  lastName: string | null
}): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return full.length > 0 ? full : user.username
}

function encodeAssignmentCursor(updatedAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({
      updatedAt: updatedAt.toISOString(),
      id,
    } satisfies AssignmentCursorPayload),
  ).toString('base64url')
}

function decodeAssignmentCursor(cursor: string): AssignmentListCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<AssignmentCursorPayload>
    if (!parsed.updatedAt || !parsed.id) throw new Error('missing')
    return { updatedAt: new Date(parsed.updatedAt), id: parsed.id }
  } catch {
    throw new AppError(400, 'Invalid cursor', 'INVALID_CURSOR')
  }
}

async function closeDisputeTicketByPublicId(
  ticketPublicId: string | null,
  closedByUserId: string,
): Promise<void> {
  if (!ticketPublicId) return
  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { publicId: ticketPublicId },
      select: { id: true, status: true },
    })
    if (ticket && ticket.status !== 'CLOSED') {
      await supportService.closeTicket(ticket.id, closedByUserId)
    }
  } catch {
    /* non-fatal */
  }
}

async function bustPayrollSummaryCache(agencyUserId: string) {
  await Promise.all([
    cacheRedisService.delByKeyPrefix(RedisKeys.payrollSummary(agencyUserId)),
    bustAgencyDashboardCaches(agencyUserId),
  ])
}

export type PayrollConfigSnapshot = {
  id: number
  platformFeeRateBp: number
  agentRewardRateBp: number
  serviceFeeUsd: number
  minWithdrawalUsd: number
  maxWithdrawalUsd: number
  slaHours: number
  waitingHours: number
  maxAssignmentAttempts: number
  inrPerUsd: number
}

function decNum(d: Prisma.Decimal): number {
  return new Prisma.Decimal(d.toString()).toNumber()
}

/** Agency PAYROLL_HOST_PAYOUT amount (= host gross − platform fee). */
function agencyCreditPoints(
  amountPoints: bigint,
  platformFeePoints: bigint | null | undefined,
): string {
  return (amountPoints - (platformFeePoints ?? 0n)).toString()
}

function secondsUntil(target: Date | null | undefined, now = Date.now()): number {
  if (!target) return 0
  return Math.max(0, Math.round((target.getTime() - now) / 1000))
}

/**
 * Pure fee math for Vitest + runtime. Uses BigInt for point splits; USD outputs use Decimal→number at boundaries only.
 */
export function calculateWithdrawalAmounts(
  grossPoints: bigint,
  config: PayrollConfigSnapshot,
): {
  platformFeeRateBp: number
  platformFeePoints: bigint
  agentRewardPoints: bigint
  hostPayoutPoints: bigint
  hostPayoutUsd: Prisma.Decimal
  serviceFeeUsd: number
  hostNetUsd: number
} {
  if (grossPoints <= 0n) {
    throw new AppError(400, 'Amount must be positive', 'INVALID_AMOUNT')
  }

  // Withdrawal gross may be any integer ≥ min / ≤ max (not required to be a step multiple).
  const grossUsd = Number(grossPoints) / 10000
  if (grossUsd < config.minWithdrawalUsd - 1e-9) {
    throw new AppError(400, 'Below minimum withdrawal amount', 'BELOW_MIN_WITHDRAWAL')
  }
  if (grossUsd > config.maxWithdrawalUsd + 1e-9) {
    throw new AppError(400, 'Above maximum withdrawal amount', 'ABOVE_MAX_WITHDRAWAL')
  }

  const platformFeeRateBp = resolvePlatformFeeRateBp(grossPoints)
  const platformFeePoints = (grossPoints * BigInt(platformFeeRateBp)) / 10000n
  // agentRewardRateBp = share of platform fee (6000 bp = 60% of platformFeePoints)
  const agentRewardPoints = (platformFeePoints * BigInt(config.agentRewardRateBp)) / 10000n
  const hostPayoutPoints = grossPoints - platformFeePoints

  const hostPayoutUsd = new Prisma.Decimal(hostPayoutPoints.toString()).div(
    new Prisma.Decimal(10000),
  )

  const serviceFeeUsd = config.serviceFeeUsd
  const hostNetUsd = hostPayoutUsd.toNumber() - serviceFeeUsd

  return {
    platformFeeRateBp,
    platformFeePoints,
    agentRewardPoints,
    hostPayoutPoints,
    hostPayoutUsd,
    serviceFeeUsd,
    hostNetUsd,
  }
}

/** Alias for tests / PR checklist naming. */
export const calculateAmounts = calculateWithdrawalAmounts

export { resolvePlatformFeeRateBp, calculateTieredPlatformFee } from '../utils/payroll-fee'

async function loadPayrollConfigRow(): Promise<PayrollConfigSnapshot> {
  const row = await prismaRead.payrollConfig.findUnique({ where: { id: 1 } })
  if (!row) {
    throw new AppError(500, 'Payroll config missing', 'CONFIG_ERROR')
  }
  return {
    id: row.id,
    platformFeeRateBp: row.platformFeeRateBp,
    agentRewardRateBp: row.agentRewardRateBp,
    serviceFeeUsd: decNum(row.serviceFeeUsd),
    minWithdrawalUsd: decNum(row.minWithdrawalUsd),
    maxWithdrawalUsd: decNum(row.maxWithdrawalUsd),
    slaHours: row.slaHours,
    waitingHours: row.waitingHours,
    maxAssignmentAttempts: row.maxAssignmentAttempts,
    inrPerUsd: decNum(row.inrPerUsd),
  }
}

export const withdrawalService = {
  async getPayrollConfig(): Promise<PayrollConfigSnapshot> {
    const key = RedisKeys.payrollConfig()
    const hit = await redisClient.get(key)
    if (hit) return JSON.parse(hit) as PayrollConfigSnapshot
    const snap = await loadPayrollConfigRow()
    await redisClient.setex(key, PAYROLL_CONFIG_TTL, JSON.stringify(snap))
    return snap
  },

  async bustPayrollConfigCache() {
    await redisClient.del(RedisKeys.payrollConfig())
  },

  calculateAmounts(grossPoints: bigint, config: PayrollConfigSnapshot) {
    return calculateWithdrawalAmounts(grossPoints, config)
  },

  /**
   * Agent payroll dashboard summary with period earnings.
   *
   * Keeps existing all-time/toggle fields and adds, for the resolved period:
   *   - paymentAmountProcessed: { usd, count } — COMPLETED, non-reversed payouts
   *   - pointsEarnings: { hostPayoutPoints, rewardPoints, totalPoints }
   *
   * Reversed (withdrawal status FAILED) payrolls are excluded from both.
   */
  async getAgentPayrollSummary(
    agencyUserId: string,
    periodParams: { periodDays?: number; from?: string; to?: string },
  ) {
    const { start, end } = resolveCommissionPeriod(periodParams)
    const periodKey =
      periodParams.from && periodParams.to
        ? `${periodParams.from}_${periodParams.to}`
        : String(periodParams.periodDays ?? 30)

    const cacheKey = RedisKeys.payrollSummaryPeriod(agencyUserId, periodKey)
    const cached = await redisClient.get(cacheKey)
    if (cached) return JSON.parse(cached) as Record<string, unknown>

    const { from, toExclusive } = commissionPeriodToLedgerBounds(start, end)

    const wallet = await walletRepository.getOrCreate(agencyUserId, WalletCurrencyType.POINT)

    const [agency, rewardSummary, tabCounts, periodEntries, completedAssignments] =
      await Promise.all([
        prismaRead.agency.findUnique({
          where: { userId: agencyUserId },
          select: { payrollEnabled: true, payrollPrivilegeGranted: true, pausedAt: true },
        }),
        prismaRead.pointLedgerEntry.aggregate({
          where: {
            walletId: wallet.id,
            txType: PointTxType.PAYROLL_PROCESSING_REWARD,
            direction: LedgerDirection.CREDIT,
          },
          _sum: { amount: true },
        }),
        payrollAssignmentRepository.countInboxByStatus(agencyUserId),
        prismaRead.pointLedgerEntry.findMany({
          where: {
            walletId: wallet.id,
            direction: LedgerDirection.CREDIT,
            txType: {
              in: [PointTxType.PAYROLL_HOST_PAYOUT, PointTxType.PAYROLL_PROCESSING_REWARD],
            },
            createdAt: { gte: from, lt: toExclusive },
          },
          select: { txType: true, amount: true, refId: true },
        }),
        prismaRead.withdrawalPayrollAssignment.findMany({
          where: {
            agencyUserId,
            status: 'COMPLETED',
            completedAt: { gte: from, lt: toExclusive },
            withdrawal: { status: { not: WithdrawalStatus.FAILED } },
          },
          select: { withdrawal: { select: { hostPayoutUsd: true } } },
        }),
      ])

    if (!agency) throw new AppError(404, 'Agency not found', 'NOT_FOUND')

    // Exclude ledger credits whose withdrawal was reversed (FAILED).
    const refIds = [...new Set(periodEntries.map((e) => e.refId).filter((r): r is string => !!r))]
    const reversed = refIds.length
      ? await prismaRead.withdrawal.findMany({
          where: { id: { in: refIds }, status: WithdrawalStatus.FAILED },
          select: { id: true },
        })
      : []
    const reversedSet = new Set(reversed.map((r) => r.id))

    let hostPayoutPoints = 0n
    let rewardPoints = 0n
    for (const e of periodEntries) {
      if (e.refId && reversedSet.has(e.refId)) continue
      if (e.txType === PointTxType.PAYROLL_HOST_PAYOUT) {
        hostPayoutPoints += e.amount
      } else if (e.txType === PointTxType.PAYROLL_PROCESSING_REWARD) {
        rewardPoints += e.amount
      }
    }

    let usd = new Prisma.Decimal(0)
    for (const a of completedAssignments) {
      if (a.withdrawal.hostPayoutUsd) usd = usd.add(a.withdrawal.hostPayoutUsd)
    }

    const result = {
      takeOrderEnabled:
        !!agency?.payrollPrivilegeGranted && !!agency.payrollEnabled && !agency.pausedAt,
      payrollEnabled: agency?.payrollEnabled ?? false,
      payrollPrivilegeGranted: agency?.payrollPrivilegeGranted ?? false,
      isPaused: !!agency?.pausedAt,
      totalRewardPoints: (rewardSummary._sum.amount ?? 0n).toString(),
      tabCounts,
      pendingCount: tabCounts.pending,
      waitingCount: tabCounts.waiting,
      settledCount: tabCounts.settled,
      completedCount: tabCounts.completed,
      period: {
        from: utcDateString(start),
        to: utcDateString(end),
      },
      paymentAmountProcessed: {
        usd: usd.toFixed(2),
        count: completedAssignments.length,
      },
      pointsEarnings: {
        hostPayoutPoints: hostPayoutPoints.toString(),
        rewardPoints: rewardPoints.toString(),
        totalPoints: (hostPayoutPoints + rewardPoints).toString(),
      },
    }

    await redisClient.setex(cacheKey, PAYROLL_SUMMARY_TTL, JSON.stringify(result))
    return result
  },

  async createWithdrawal(
    userId: string,
    params: {
      grossPoints: bigint
      paymentMethodId: string
      idempotencyKey: string
      notes?: string
    },
  ) {
    const idem = `withdrawal-create:${userId}:${params.idempotencyKey}`
    const cached = await walletService.getCachedIdemResponse(idem)
    if (cached) return cached

    const acquired = await walletService.acquireIdemKey(idem)
    if (!acquired) {
      throw new AppError(409, 'Already processing', 'IDEM_CONFLICT')
    }

    try {
      return await withdrawalService.executeCreateWithdrawal(userId, params, idem)
    } catch (err) {
      // Definitive failure: release the in-flight marker so a corrected retry
      // with the same key is not locked out for the idem TTL.
      try {
        await redisClient.del(RedisKeys.walletIdem(idem))
      } catch {
        // best-effort
      }
      throw err
    }
  },

  async executeCreateWithdrawal(
    userId: string,
    params: {
      grossPoints: bigint
      paymentMethodId: string
      idempotencyKey: string
      notes?: string
    },
    idem: string,
  ) {
    const faceIndexed = await faceVerificationRepository.isIndexedForUser(userId)
    if (!faceIndexed) {
      throw new AppError(
        403,
        'Face verification must be completed and indexed before withdrawing points',
        'FACE_NOT_INDEXED',
      )
    }

    await assertPointsDebitAllowed(userId)

    const method = await userPaymentMethodRepository.findById(params.paymentMethodId, userId)
    if (!method) {
      throw new AppError(404, 'Payment method not found', 'NOT_FOUND')
    }

    const methodType = method.methodType === 'BANK' ? 'BANK' : 'EPAY'
    await withdrawalPayoutRailConfigService.assertRailEnabled(methodType)

    // Multiple open withdrawals are allowed (v2). Spending is capped by the
    // host's AVAILABLE points (totalPoints − unconfirmedPoints), enforced under
    // the wallet lock inside the transaction below.

    const config = await withdrawalService.getPayrollConfig()
    const amounts = calculateWithdrawalAmounts(params.grossPoints, config)

    const withdrawalId = randomUUID()
    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)

    // Read Committed: the POINT wallet FOR UPDATE lock serializes the
    // availability check + escrow increment; the ledger/withdrawal keys are
    // derived from the (stable across retries) withdrawalId. Serializable
    // previously aborted every lock waiter with 40001 500s under parallel
    // withdrawal creation.
    await withSerializationRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Lock the POINT wallet row first so the availability check and hard debit
          // are serialized against concurrent withdrawal creation.
          await walletRepository.lockForUpdate(tx, wallet.id)
          const walletRow = await tx.wallet.findUniqueOrThrow({
            where: { id: wallet.id },
            select: { unconfirmedPoints: true },
          })
          const last = await tx.pointLedgerEntry.findFirst({
            where: { walletId: wallet.id },
            orderBy: { createdAt: 'desc' },
            select: { balanceAfter: true },
          })
          const totalPoints = last?.balanceAfter ?? 0n
          const unconfirmed = walletRow.unconfirmedPoints ?? 0n
          const available = totalPoints - unconfirmed
          if (available < params.grossPoints) {
            throw new AppError(400, 'Insufficient available points', 'INSUFFICIENT_POINTS', {
              balance: available.toString(),
              required: params.grossPoints.toString(),
              unconfirmed: unconfirmed.toString(),
            })
          }

          // Hard debit at request time — points leave the host wallet immediately.
          await pointWalletService.debit(
            userId,
            params.grossPoints,
            PointTxType.WITHDRAWAL,
            tx,
            {
              idempotencyKey: `withdrawal-debit:${withdrawalId}`,
              refId: withdrawalId,
              description: 'Withdrawal',
              availabilityCheck: true,
            },
          )

          await withdrawalRepository.create(
            {
              id: withdrawalId,
              walletId: wallet.id,
              userId,
              amountPoints: params.grossPoints,
              status: 'PENDING',
              paymentMethodId: method.id,
              hostPayoutUsd: amounts.hostPayoutUsd,
              platformFeePoints: amounts.platformFeePoints,
              agentRewardPoints: amounts.agentRewardPoints,
              idempotencyKey: `withdrawal:${userId}:${withdrawalId}`,
              notes: params.notes ?? null,
              withdrawalVersion: 2,
            },
            tx,
          )

          await userPaymentMethodRepository.touchLastUsed(method.id, userId, tx)
        },
        { timeout: INTERACTIVE_TX_MS },
      ),
    )

    await redisClient.del(RedisKeys.userPaymentMethods(userId))
    await walletService.adjustPointBalanceCache(userId, -params.grossPoints)
    await walletService.bustUnconfirmedCache(userId)

    await withdrawalService.assignToAgency(withdrawalId)

    const refreshed = await prismaRead.withdrawal.findUniqueOrThrow({
      where: { id: withdrawalId },
    })

    const response = {
      withdrawalId: refreshed.id,
      status: refreshed.status,
      grossPoints: refreshed.amountPoints.toString(),
      hostPayoutUsd: refreshed.hostPayoutUsd?.toString() ?? null,
    }
    await walletService.resolveIdemKey(idem, response)

    const pendingAssignment = await prismaRead.withdrawalPayrollAssignment.findFirst({
      where: { withdrawalId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      select: { agencyUserId: true },
    })
    void enqueuePlatformWithdrawalMessage({
      withdrawalId,
      event: 'created',
      hostUserId: userId,
      agentUserId: pendingAssignment?.agencyUserId,
    }).catch(() => {})

    return response
  },

  async assignToAgency(
    withdrawalId: string,
    opts?: {
      overrideAgencyUserId?: string
      /** Admin manual assign may exceed automatic attempt cap. */
      allowBeyondAssignmentCap?: boolean
      /** When override agency is ineligible (wrong country / payroll off), throw instead of PENDING_PLATFORM. */
      rejectOnIneligibleOverride?: boolean
    },
  ) {
    let assignmentIdOut: string | null = null
    let expiresAtOut: Date | null = null
    let countryMismatch = false
    let selfAssignBlocked = false

    await prisma.$transaction(
      async (tx) => {
        const w = await tx.withdrawal.findUnique({ where: { id: withdrawalId } })
        if (!w) return
        if (w.status !== 'PENDING' && w.status !== 'PENDING_PLATFORM') return

        const host = await tx.user.findUnique({
          where: { id: w.userId },
          select: { country: true, currentAgencyId: true },
        })
        const hostCountry = host?.country ?? null
        const withdrawerUserId = w.userId
        const excludeAgencyUserId = host?.currentAgencyId ?? null

        const cfgCap = await tx.payrollConfig.findUnique({ where: { id: 1 } })
        const maxAttempts = cfgCap?.maxAssignmentAttempts ?? 5
        const attemptCount = w.assignmentCount ?? 0
        if (
          attemptCount >= maxAttempts &&
          !opts?.overrideAgencyUserId &&
          !opts?.allowBeyondAssignmentCap
        ) {
          if (w.status !== WithdrawalStatus.PENDING_PLATFORM) {
            await withdrawalRepository.updateStatus(
              { id: withdrawalId, status: 'PENDING_PLATFORM' },
              tx,
            )
            auditService.log({
              actionType: 'WITHDRAWAL_ASSIGNMENTS_EXHAUSTED',
              actionStatus: 'success',
              actionDetails: { withdrawalId, assignmentCount: attemptCount },
            })
          }
          return
        }

        let agencyUserId: string | null = null
        if (!hostCountry) {
          agencyUserId = null
        } else if (opts?.overrideAgencyUserId) {
          if (
            opts.overrideAgencyUserId === withdrawerUserId ||
            opts.overrideAgencyUserId === excludeAgencyUserId
          ) {
            if (opts.rejectOnIneligibleOverride) {
              selfAssignBlocked = true
              return
            }
            agencyUserId = null
          } else {
            const ag = await tx.agency.findFirst({
              where: {
                userId: opts.overrideAgencyUserId,
                payrollEnabled: true,
                payrollPrivilegeGranted: true,
                OR: [{ pausedAt: null }, { pausedUntil: { lte: new Date() } }],
                user: { country: countryEqualsFilter(hostCountry) },
              },
            })
            if (ag) {
              agencyUserId = ag.userId
              await withdrawalRepository.touchAgencyPayrollTimestamp(agencyUserId, tx)
            } else if (opts.rejectOnIneligibleOverride) {
              countryMismatch = true
              return
            }
          }
        } else {
          agencyUserId = await withdrawalRepository.getNextEligibleAgency(tx, hostCountry, {
            withdrawerUserId,
            excludeAgencyUserId,
          })
        }

        if (!agencyUserId) {
          await withdrawalRepository.updateStatus(
            { id: withdrawalId, status: 'PENDING_PLATFORM' },
            tx,
          )
          auditService.log({
            actionType: 'WITHDRAWAL_NO_AGENCY',
            actionStatus: 'success',
            actionDetails: { withdrawalId, hostCountry },
          })
          return
        }

        const cfg = await tx.payrollConfig.findUnique({ where: { id: 1 } })
        const slaHours = cfg?.slaHours ?? 2
        const expiresAt = new Date(Date.now() + slaHours * 3600 * 1000)

        const assignmentNumber = w.assignmentCount + 1
        const assignmentId = randomUUID()

        await payrollAssignmentRepository.create(
          {
            id: assignmentId,
            withdrawalId,
            agencyUserId,
            expiresAt,
            assignmentNumber,
          },
          tx,
        )

        await withdrawalRepository.updateStatus({ id: withdrawalId, status: 'PENDING' }, tx)

        assignmentIdOut = assignmentId
        expiresAtOut = expiresAt
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_MS },
    )

    if (selfAssignBlocked) {
      throw new AppError(
        400,
        'Payroll cannot be assigned to the withdrawer or their own agency',
        'PAYROLL_SELF_ASSIGN_FORBIDDEN',
      )
    }

    if (countryMismatch) {
      throw new AppError(
        400,
        'Agency agent must be in the same country as the withdrawing host',
        'COUNTRY_MISMATCH',
      )
    }

    if (assignmentIdOut && expiresAtOut) {
      await enqueuePayrollSla(assignmentIdOut, expiresAtOut)
      const assignment = await prismaRead.withdrawalPayrollAssignment.findUnique({
        where: { id: assignmentIdOut },
        select: { agencyUserId: true },
      })
      if (assignment) await bustPayrollSummaryCache(assignment.agencyUserId)
    }
  },

  async processSlaExpiry(job: { assignmentId: string }) {
    const now = new Date()
    const assignment = await prismaRead.withdrawalPayrollAssignment.findUnique({
      where: { id: job.assignmentId },
    })
    if (!assignment) return
    if (assignment.status !== 'PENDING' || assignment.expiresAt > now) return

    let withdrawalId = assignment.withdrawalId
    let shouldReassign = false

    await prisma.$transaction(
      async (tx) => {
        const a = await tx.withdrawalPayrollAssignment.findUnique({
          where: { id: job.assignmentId },
        })
        if (!a || a.status !== 'PENDING' || a.expiresAt > now) return

        await payrollAssignmentRepository.updateStatus({ id: a.id, status: 'EXPIRED' }, tx)

        const wAfter = await withdrawalRepository.incrementAssignmentCount(a.withdrawalId, tx)

        const cfg = await tx.payrollConfig.findUnique({ where: { id: 1 } })
        const max = cfg?.maxAssignmentAttempts ?? 5

        if (wAfter.assignmentCount >= max) {
          await withdrawalRepository.updateStatus(
            { id: a.withdrawalId, status: 'PENDING_PLATFORM' },
            tx,
          )
          auditService.log({
            actionType: 'WITHDRAWAL_ASSIGNMENTS_EXHAUSTED',
            actionStatus: 'success',
            actionDetails: { withdrawalId: a.withdrawalId },
          })
          return
        }

        withdrawalId = a.withdrawalId
        shouldReassign = true
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_MS },
    )

    await removePayrollSla(job.assignmentId)
    if (shouldReassign) {
      await withdrawalService.assignToAgency(withdrawalId)
    }
  },

  async agentRejectPayroll(agentUserId: string, assignmentId: string, reason?: string) {
    let withdrawalId: string | null = null
    let hostUserId: string | null = null
    let rejectedWithdrawalId: string | null = null
    const now = new Date()

    await prisma.$transaction(
      async (tx) => {
        const a = await tx.withdrawalPayrollAssignment.findFirst({
          where: { id: assignmentId, agencyUserId: agentUserId },
        })
        if (!a) {
          throw new AppError(404, 'Assignment not found', 'NOT_FOUND')
        }
        if (a.status === 'WAITING') {
          throw new AppError(400, 'Assignment is under host review', 'AGENT_LOCKED_OUT')
        }
        if (a.status !== 'PENDING' || a.expiresAt <= now) {
          throw new AppError(400, 'Assignment cannot be rejected', 'INVALID_STATE')
        }

        hostUserId =
          (
            await tx.withdrawal.findUnique({
              where: { id: a.withdrawalId },
              select: { userId: true },
            })
          )?.userId ?? null
        rejectedWithdrawalId = a.withdrawalId

        await payrollAssignmentRepository.updateStatus(
          {
            id: assignmentId,
            status: 'REJECTED',
            rejectedAt: now,
            rejectionReason: reason ?? null,
          },
          tx,
        )

        const wAfter = await withdrawalRepository.incrementAssignmentCount(a.withdrawalId, tx)

        const cfg = await tx.payrollConfig.findUnique({ where: { id: 1 } })
        const max = cfg?.maxAssignmentAttempts ?? 5

        if (wAfter.assignmentCount >= max) {
          await withdrawalRepository.updateStatus(
            { id: a.withdrawalId, status: 'PENDING_PLATFORM' },
            tx,
          )
          auditService.log({
            actionType: 'WITHDRAWAL_ASSIGNMENTS_EXHAUSTED',
            actionStatus: 'success',
            actionDetails: { withdrawalId: a.withdrawalId },
          })
          withdrawalId = null
        } else {
          withdrawalId = a.withdrawalId
        }
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_MS },
    )

    await removePayrollSla(assignmentId)
    await bustPayrollSummaryCache(agentUserId)
    if (withdrawalId) await withdrawalService.assignToAgency(withdrawalId)

    if (hostUserId && rejectedWithdrawalId) {
      void enqueuePlatformWithdrawalMessage({
        withdrawalId: rejectedWithdrawalId,
        event: 'agent_rejected',
        hostUserId,
        agentUserId,
        reason,
      }).catch(() => {})
    }
  },

  async getPresignedProofUrl(agentUserId: string, assignmentId: string, mimeType: string) {
    const now = new Date()
    const a = await prismaRead.withdrawalPayrollAssignment.findFirst({
      where: { id: assignmentId, agencyUserId: agentUserId },
    })
    if (!a) throw new AppError(404, 'Assignment not found', 'NOT_FOUND')
    if (a.status === 'WAITING') {
      throw new AppError(400, 'Assignment is locked', 'AGENT_LOCKED_OUT')
    }
    if (a.status !== 'PENDING' || a.expiresAt <= now) {
      throw new AppError(400, 'Proof upload not allowed', 'INVALID_STATE')
    }

    const key = `payroll/proofs/${assignmentId}/${agentUserId}`
    const uploadUrl = await storageService.getPresignedPutUrl(key, mimeType, 600)
    return {
      uploadUrl,
      s3Key: key,
      s3Bucket: s3Bucket ?? '',
    }
  },

  async agentCompletePayroll(
    agentUserId: string,
    assignmentId: string,
    params: { proofS3Key: string; proofS3Bucket: string },
  ): Promise<{ agentRewardPoints: string; hostPayoutPoints: string }> {
    const now = new Date()
    const prefix = `payroll/proofs/${assignmentId}/`
    if (!params.proofS3Key.startsWith(prefix)) {
      throw new AppError(400, 'Invalid proof key', 'INVALID_PROOF_KEY')
    }

    const config = await withdrawalService.getPayrollConfig()
    const waitingExpiresAt = new Date(Date.now() + config.waitingHours * 60 * 60 * 1000)

    let rewardOut = '0'
    let hostPayoutOut = '0'
    let notifyWithdrawalId: string | null = null
    let notifyHostUserId: string | null = null

    await prisma.$transaction(
      async (tx) => {
        const a = await tx.withdrawalPayrollAssignment.findFirst({
          where: { id: assignmentId, agencyUserId: agentUserId },
          include: { withdrawal: true },
        })
        if (!a) throw new AppError(404, 'Assignment not found', 'NOT_FOUND')
        if (a.status === 'WAITING') {
          throw new AppError(400, 'Assignment is under host review', 'AGENT_LOCKED_OUT')
        }
        if (a.status !== 'PENDING') {
          throw new AppError(400, 'Assignment not active', 'INVALID_STATE')
        }
        if (a.expiresAt <= now) {
          throw new AppError(400, 'SLA expired', 'SLA_EXPIRED')
        }

        const grossPoints = a.withdrawal.amountPoints
        const platformFeePoints = a.withdrawal.platformFeePoints ?? 0n
        const hostPayoutPoints = grossPoints - platformFeePoints
        const reward = a.withdrawal.agentRewardPoints ?? 0n
        const hostUserId = a.withdrawal.userId
        notifyWithdrawalId = a.withdrawalId
        notifyHostUserId = hostUserId

        rewardOut = reward.toString()
        hostPayoutOut = hostPayoutPoints.toString()

        await payrollAssignmentRepository.updateStatus(
          {
            id: assignmentId,
            status: 'WAITING',
            proofS3Key: params.proofS3Key,
            proofS3Bucket: params.proofS3Bucket,
            waitingExpiresAt,
          },
          tx,
        )

        await withdrawalRepository.updateStatus(
          {
            id: a.withdrawalId,
            status: 'WAITING',
          },
          tx,
        )

        // Agency credits (host payout + processing reward) happen only after the
        // waitingHours dispute window elapses without a dispute (autoCompleteWaiting).
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_MS },
    )

    await removePayrollSla(assignmentId)
    await enqueuePayrollWaiting(assignmentId, waitingExpiresAt)
    await bustPayrollSummaryCache(agentUserId)

    console.info(
      `[withdrawal] Payroll proof → WAITING withdrawal=${notifyWithdrawalId} assignment=${assignmentId} agent=${agentUserId}`,
    )

    if (notifyWithdrawalId && notifyHostUserId) {
      void enqueuePlatformWithdrawalMessage({
        withdrawalId: notifyWithdrawalId,
        event: 'waiting',
        hostUserId: notifyHostUserId,
        agentUserId,
      }).catch(() => {})
    }

    return { agentRewardPoints: rewardOut, hostPayoutPoints: hostPayoutOut }
  },

  /** WAITING → COMPLETED + withdrawal PAID; credits agency host-payout + reward. */
  async autoCompleteWaiting(assignmentId: string): Promise<void> {
    const pre = await prismaRead.withdrawalPayrollAssignment.findUnique({
      where: { id: assignmentId },
      include: { withdrawal: true },
    })
    if (!pre) return

    const hostUserId = pre.withdrawal.userId
    const agentUserId = pre.agencyUserId
    const withdrawalId = pre.withdrawalId
    const grossPoints = pre.withdrawal.amountPoints
    const platformFeePoints = pre.withdrawal.platformFeePoints ?? 0n
    const hostPayoutPoints = grossPoints - platformFeePoints
    const reward = pre.withdrawal.agentRewardPoints ?? 0n
    const proofKey = pre.proofS3Key
    const now = new Date()

    await prisma.$transaction(
      async (tx) => {
        const a = await tx.withdrawalPayrollAssignment.findUnique({
          where: { id: assignmentId },
          include: { withdrawal: true },
        })
        if (!a || a.status !== 'WAITING') return
        if (a.waitingExpiresAt && a.waitingExpiresAt > now) return

        await payrollAssignmentRepository.updateStatus(
          {
            id: assignmentId,
            status: 'COMPLETED',
            completedAt: now,
          },
          tx,
        )

        await withdrawalRepository.updateStatus(
          {
            id: a.withdrawalId,
            status: 'PAID',
            payoutRef: proofKey ?? undefined,
            processedAt: now,
          },
          tx,
        )

        // Credit agency after dispute window (idempotent — safe if proof path already credited in legacy).
        if (hostPayoutPoints > 0n) {
          await pointWalletService.creditInTransaction(
            agentUserId,
            hostPayoutPoints,
            PointTxType.PAYROLL_HOST_PAYOUT,
            tx,
            {
              idempotencyKey: `payroll-host-payout:${assignmentId}`,
              refId: withdrawalId,
              counterpartyId: hostUserId,
              description: 'Payroll host payout',
              applyLivestreamLevel: false,
            },
          )
        }

        if (reward > 0n) {
          await pointWalletService.creditInTransaction(
            agentUserId,
            reward,
            PointTxType.PAYROLL_PROCESSING_REWARD,
            tx,
            {
              idempotencyKey: `payroll-reward:${assignmentId}`,
              refId: withdrawalId,
              counterpartyId: hostUserId,
              description: 'Payroll processing reward',
              applyLivestreamLevel: false,
            },
          )
        }

        // Legacy soft-escrow creates: settle host ledger now (new model already hard-debited at create).
        const hardDebitAtCreate = await pointLedgerRepository.findByIdempotencyKey(
          tx,
          `withdrawal-debit:${withdrawalId}`,
        )
        const softEscrowAtCreate = await pointLedgerRepository.findByIdempotencyKey(
          tx,
          `withdrawal-escrow:${withdrawalId}`,
        )
        if (softEscrowAtCreate && !hardDebitAtCreate) {
          await pointWalletService.debit(
            hostUserId,
            grossPoints,
            PointTxType.WITHDRAWAL_ESCROW_SETTLED,
            tx,
            {
              idempotencyKey: `withdrawal-settled:${assignmentId}`,
              refId: withdrawalId,
              counterpartyId: agentUserId,
              description: 'Withdrawal escrow settled',
              availabilityCheck: false,
              freezeCheck: false,
            },
          )
          await tx.wallet.update({
            where: {
              userId_currencyType: {
                userId: hostUserId,
                currencyType: WalletCurrencyType.POINT,
              },
            },
            data: { unconfirmedPoints: { decrement: grossPoints } },
          })
        }
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_MS },
    )

    await removePayrollWaiting(assignmentId)
    await bustPayrollSummaryCache(agentUserId)
    await walletService.adjustPointBalanceCache(agentUserId, 0n)
    await walletService.adjustPointBalanceCache(hostUserId, 0n)
    await walletService.bustUnconfirmedCache(hostUserId)

    void enqueuePlatformWithdrawalMessage({
      withdrawalId,
      event: 'paid',
      hostUserId,
      agentUserId,
    }).catch(() => {})
  },

  async createDisputeEvidenceUploadUrl(
    withdrawalId: string,
    userId: string,
    mimeType: string,
  ): Promise<{ uploadUrl: string; s3Key: string; expiresInSec: number }> {
    const row = await prismaRead.withdrawal.findFirst({
      where: { id: withdrawalId, userId },
      select: { status: true },
    })
    if (!row) throw new AppError(404, 'Withdrawal not found', 'NOT_FOUND')
    const waitingAssignment =
      await payrollAssignmentRepository.findWaitingByWithdrawalId(withdrawalId)
    const allowWaitingEvidence =
      (row.status === 'PENDING' || row.status === 'WAITING') && !!waitingAssignment
    if (row.status !== 'PAID' && row.status !== 'DISPUTED' && !allowWaitingEvidence) {
      throw new AppError(
        400,
        'Evidence upload only allowed for PAID, DISPUTED, or WAITING withdrawals',
        'INVALID_STATE',
      )
    }

    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
    const s3Key = `withdrawal/disputes/${userId}/${withdrawalId}/${Date.now()}.${ext}`
    const uploadUrl = await storageService.getPresignedPutUrl(
      s3Key,
      mimeType,
      DISPUTE_EVIDENCE_PRESIGN_TTL,
    )
    return {
      uploadUrl,
      s3Key,
      expiresInSec: DISPUTE_EVIDENCE_PRESIGN_TTL,
    }
  },

  async disputeWithdrawal(hostUserId: string, withdrawalId: string, input: DisputeWithdrawalInput) {
    const w = await prismaRead.withdrawal.findFirst({
      where: { id: withdrawalId, userId: hostUserId },
      include: {
        payrollAssignments: {
          where: { status: 'WAITING' },
          take: 1,
        },
      },
    })
    if (!w) throw new AppError(404, 'Withdrawal not found', 'NOT_FOUND')
    if (w.disputeTicketId) {
      throw new AppError(409, 'Dispute already raised', 'DISPUTE_ALREADY_RAISED')
    }

    const waitingAssignment = w.payrollAssignments[0] ?? null
    const isWaitingPeriod =
      (w.status === 'PENDING' || w.status === 'WAITING') && waitingAssignment != null

    if (w.status !== 'PAID' && !isWaitingPeriod) {
      throw new AppError(400, 'Withdrawal cannot be disputed in its current state', 'INVALID_STATE')
    }

    if (w.status === 'PAID') {
      if (!w.processedAt) {
        throw new AppError(400, 'Missing processed timestamp', 'INVALID_STATE')
      }
      const windowEnd = new Date(w.processedAt)
      windowEnd.setDate(windowEnd.getDate() + 30)
      if (new Date() > windowEnd) {
        throw new AppError(400, 'Dispute window expired', 'DISPUTE_WINDOW_EXPIRED')
      }
    }

    const completed = await payrollAssignmentRepository.findCompletedForWithdrawal(withdrawalId)

    const evidenceUrl = input.evidenceS3Key
      ? storageService.getPublicUrl(input.evidenceS3Key)
      : undefined

    const ticket = await supportService.createTicket(hostUserId, {
      type: 'REPORT_COMPLAINTS',
      subType: 'WITHDRAWAL_DISPUTE',
      description: `Withdrawal dispute for ID: ${withdrawalId}. ${input.description}`,
      imageUrl: evidenceUrl,
      transactionRef: { refType: 'WITHDRAWAL', refId: withdrawalId },
    })

    await prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.DISPUTED,
        disputeTicketId: ticket.publicId,
      },
    })

    if (waitingAssignment) {
      try {
        await removePayrollWaiting(waitingAssignment.id)
      } catch {
        /* non-fatal */
      }
      await bustPayrollSummaryCache(waitingAssignment.agencyUserId)
    }

    auditService.log({
      userId: hostUserId,
      actionType: 'WITHDRAWAL_DISPUTE_RAISED',
      actionStatus: 'success',
      actionDetails: {
        withdrawalId,
        ticketPublicId: ticket.publicId,
        agencyUserId: waitingAssignment?.agencyUserId ?? completed?.agencyUserId,
        proofS3Key: waitingAssignment?.proofS3Key ?? completed?.proofS3Key,
        evidenceS3Key: input.evidenceS3Key,
        waitingPeriod: isWaitingPeriod,
      },
    })

    return { ticketId: ticket.publicId }
  },

  async adminResolveDisputeFavourAgent(
    adminUserId: string,
    withdrawalId: string,
    reason: string,
  ): Promise<void> {
    const pre = await prismaRead.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: {
        payrollAssignments: {
          where: { status: 'WAITING' },
          take: 1,
        },
      },
    })
    if (!pre) throw new AppError(404, 'Withdrawal not found', 'NOT_FOUND')
    if (pre.status !== 'DISPUTED') {
      throw new AppError(400, 'Withdrawal is not disputed', 'INVALID_STATE')
    }
    const assignment = pre.payrollAssignments[0]
    if (!assignment) {
      throw new AppError(404, 'Waiting assignment not found', 'NOT_FOUND')
    }

    const hostUserId = pre.userId
    const agentUserId = assignment.agencyUserId
    const grossPoints = pre.amountPoints
    const platformFeePoints = pre.platformFeePoints ?? 0n
    const hostPayoutPoints = grossPoints - platformFeePoints
    const reward = pre.agentRewardPoints ?? 0n
    const proofKey = assignment.proofS3Key
    const ticketPublicId = pre.disputeTicketId
    const now = new Date()

    await prisma.$transaction(
      async (tx) => {
        const w = await tx.withdrawal.findUnique({
          where: { id: withdrawalId },
          include: {
            payrollAssignments: {
              where: { id: assignment.id, status: 'WAITING' },
              take: 1,
            },
          },
        })
        if (!w || w.status !== 'DISPUTED') return
        const a = w.payrollAssignments[0]
        if (!a) return

        await payrollAssignmentRepository.updateStatus(
          { id: a.id, status: 'COMPLETED', completedAt: now },
          tx,
        )

        await withdrawalRepository.updateStatus(
          {
            id: withdrawalId,
            status: 'PAID',
            payoutRef: proofKey ?? undefined,
            processedAt: now,
          },
          tx,
        )

        await tx.withdrawal.update({
          where: { id: withdrawalId },
          data: { disputeTicketId: null, failReason: null },
        })

        // Host was hard-debited at create (new); settle by crediting the agency.
        if (hostPayoutPoints > 0n) {
          await pointWalletService.creditInTransaction(
            agentUserId,
            hostPayoutPoints,
            PointTxType.PAYROLL_HOST_PAYOUT,
            tx,
            {
              idempotencyKey: `payroll-host-payout:${a.id}`,
              refId: withdrawalId,
              counterpartyId: hostUserId,
              description: `Payroll host payout (admin: ${reason})`,
              applyLivestreamLevel: false,
            },
          )
        }

        if (reward > 0n) {
          await pointWalletService.creditInTransaction(
            agentUserId,
            reward,
            PointTxType.PAYROLL_PROCESSING_REWARD,
            tx,
            {
              idempotencyKey: `payroll-reward:${a.id}`,
              refId: withdrawalId,
              counterpartyId: hostUserId,
              description: `Payroll processing reward (admin: ${reason})`,
              applyLivestreamLevel: false,
            },
          )
        }

        const hardDebitAtCreate = await pointLedgerRepository.findByIdempotencyKey(
          tx,
          `withdrawal-debit:${withdrawalId}`,
        )
        const softEscrowAtCreate = await pointLedgerRepository.findByIdempotencyKey(
          tx,
          `withdrawal-escrow:${withdrawalId}`,
        )
        if (softEscrowAtCreate && !hardDebitAtCreate) {
          await pointWalletService.debit(
            hostUserId,
            grossPoints,
            PointTxType.WITHDRAWAL_ESCROW_SETTLED,
            tx,
            {
              idempotencyKey: `withdrawal-settled:${a.id}`,
              refId: withdrawalId,
              counterpartyId: agentUserId,
              description: `Withdrawal escrow settled (admin: ${reason})`,
              availabilityCheck: false,
              freezeCheck: false,
            },
          )
          await tx.wallet.update({
            where: {
              userId_currencyType: {
                userId: hostUserId,
                currencyType: WalletCurrencyType.POINT,
              },
            },
            data: { unconfirmedPoints: { decrement: grossPoints } },
          })
        }
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_MS },
    )

    await removePayrollWaiting(assignment.id)
    await walletService.adjustPointBalanceCache(agentUserId, 0n)
    await walletService.adjustPointBalanceCache(hostUserId, 0n)
    await walletService.bustUnconfirmedCache(hostUserId)
    await bustPayrollSummaryCache(agentUserId)
    await closeDisputeTicketByPublicId(ticketPublicId, adminUserId)

    auditService.log({
      userId: adminUserId,
      actionType: 'WITHDRAWAL_DISPUTE_RESOLVED_AGENT',
      actionStatus: 'success',
      actionDetails: { withdrawalId, reason },
    })

    void enqueuePlatformWithdrawalMessage({
      withdrawalId,
      event: 'paid',
      hostUserId,
      agentUserId,
    }).catch(() => {})
  },

  async adminResolveDisputeFavourHost(
    adminUserId: string,
    withdrawalId: string,
    reason: string,
    overrideAgencyUserId?: string,
  ): Promise<void> {
    const pre = await prismaRead.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: {
        payrollAssignments: {
          where: { status: 'WAITING' },
          take: 1,
        },
      },
    })
    if (!pre) throw new AppError(404, 'Withdrawal not found', 'NOT_FOUND')
    if (pre.status !== 'DISPUTED') {
      throw new AppError(400, 'Withdrawal is not disputed', 'INVALID_STATE')
    }
    const assignment = pre.payrollAssignments[0]
    if (!assignment) {
      throw new AppError(404, 'Waiting assignment not found', 'NOT_FOUND')
    }

    const agentUserId = assignment.agencyUserId
    const hostPayoutPoints = pre.amountPoints - (pre.platformFeePoints ?? 0n)
    const agentReward = pre.agentRewardPoints ?? 0n
    const ticketPublicId = pre.disputeTicketId
    const now = new Date()

    await prisma.$transaction(
      async (tx) => {
        const w = await tx.withdrawal.findUnique({
          where: { id: withdrawalId },
          include: {
            payrollAssignments: {
              where: { id: assignment.id, status: 'WAITING' },
              take: 1,
            },
          },
        })
        if (!w || w.status !== 'DISPUTED') return
        const a = w.payrollAssignments[0]
        if (!a) return

        if (hostPayoutPoints > 0n) {
          const payoutKey = `payroll-host-payout:${a.id}`
          const existingPayout = await pointLedgerRepository.findByIdempotencyKey(tx, payoutKey)
          if (existingPayout) {
            await pointWalletService.debit(
              agentUserId,
              hostPayoutPoints,
              PointTxType.ADJUSTMENT,
              tx,
              {
                idempotencyKey: `payroll-host-payout-reversal:${a.id}`,
                refId: withdrawalId,
                description: `Payroll host payout reversal: ${reason}`,
                availabilityCheck: false,
              },
            )
          }
        }

        if (agentReward > 0n) {
          const rewardKey = `payroll-reward:${a.id}`
          const existingReward = await pointLedgerRepository.findByIdempotencyKey(tx, rewardKey)
          if (existingReward) {
            await pointWalletService.debit(agentUserId, agentReward, PointTxType.ADJUSTMENT, tx, {
              idempotencyKey: `payroll-reward-reversal:${a.id}`,
              refId: withdrawalId,
              description: `Payroll reward reversal: ${reason}`,
              availabilityCheck: false,
            })
          }
        }

        await payrollAssignmentRepository.updateStatus(
          {
            id: a.id,
            status: 'REJECTED',
            rejectedAt: now,
            rejectionReason: reason,
          },
          tx,
        )

        await tx.withdrawal.update({
          where: { id: withdrawalId },
          data: {
            status: 'PENDING',
            disputeTicketId: null,
            assignmentCount: { increment: 1 },
          },
        })
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_MS },
    )

    await removePayrollWaiting(assignment.id)
    await walletService.adjustPointBalanceCache(agentUserId, 0n)
    await bustPayrollSummaryCache(agentUserId)
    await closeDisputeTicketByPublicId(ticketPublicId, adminUserId)

    await withdrawalService.assignToAgency(withdrawalId, {
      overrideAgencyUserId: overrideAgencyUserId ?? agentUserId,
      allowBeyondAssignmentCap: true,
    })

    auditService.log({
      userId: adminUserId,
      actionType: 'WITHDRAWAL_DISPUTE_RESOLVED_HOST',
      actionStatus: 'success',
      actionDetails: {
        withdrawalId,
        reason,
        reassignedTo: overrideAgencyUserId ?? agentUserId,
      },
    })
  },

  /** @deprecated use disputeWithdrawal */
  async raiseDispute(hostUserId: string, withdrawalId: string, description?: string) {
    return withdrawalService.disputeWithdrawal(hostUserId, withdrawalId, {
      description: description ?? 'Withdrawal dispute',
    })
  },

  async adminReverseWithdrawal(adminUserId: string, withdrawalId: string, reason: string) {
    const w = await prismaRead.withdrawal.findUnique({
      where: { id: withdrawalId },
    })
    if (!w) throw new AppError(404, 'Withdrawal not found', 'NOT_FOUND')
    if (w.status === 'FAILED') {
      return w
    }
    // v2 allows cancelling open (escrowed) withdrawals in addition to reversing
    // settled (PAID/DISPUTED) ones.
    const REVERSIBLE: WithdrawalStatus[] = [
      'PAID',
      'DISPUTED',
      'PENDING',
      'PENDING_PLATFORM',
      'WAITING',
    ]
    if (!REVERSIBLE.includes(w.status)) {
      throw new AppError(400, 'Withdrawal cannot be reversed', 'INVALID_STATE')
    }

    const isV2 = w.withdrawalVersion === 2
    // PAID means agency was credited and withdrawal finished. DISPUTED may still be
    // unsettled (during waiting window) or post-PAID dispute.
    const wasSettled = w.status === 'PAID'

    const completed = await payrollAssignmentRepository.findCompletedForWithdrawal(withdrawalId)
    const waitingAssignment =
      await payrollAssignmentRepository.findWaitingByWithdrawalId(withdrawalId)
    const creditAssignment = waitingAssignment ?? completed
    const agencyUserId = creditAssignment?.agencyUserId ?? null
    const hostPayoutPoints = w.amountPoints - (w.platformFeePoints ?? 0n)
    const agentReward = w.agentRewardPoints ?? 0n

    const openAssignment = await prismaRead.withdrawalPayrollAssignment.findFirst({
      where: {
        withdrawalId,
        status: { in: ['PENDING', 'WAITING'] },
      },
    })

    await prisma.$transaction(
      async (tx) => {
        const hardDebitAtCreate = await pointLedgerRepository.findByIdempotencyKey(
          tx,
          `withdrawal-debit:${withdrawalId}`,
        )
        const softEscrowAtCreate = await pointLedgerRepository.findByIdempotencyKey(
          tx,
          `withdrawal-escrow:${withdrawalId}`,
        )

        // New model hard-debits at create; legacy soft-escrow only reduced ledger on settle.
        const needsHostRefund = Boolean(hardDebitAtCreate) || wasSettled || !isV2
        const needsUnconfirmedRelease = Boolean(softEscrowAtCreate) && !wasSettled

        if (needsHostRefund) {
          await pointWalletService.creditInTransaction(
            w.userId,
            w.amountPoints,
            PointTxType.WITHDRAWAL_REFUND,
            tx,
            {
              idempotencyKey: `withdrawal-refund:${withdrawalId}`,
              refId: withdrawalId,
              description: `Withdrawal reversal: ${reason}`,
              applyLivestreamLevel: false,
            },
          )
        }

        if (needsUnconfirmedRelease) {
          await tx.wallet.update({
            where: {
              userId_currencyType: {
                userId: w.userId,
                currencyType: WalletCurrencyType.POINT,
              },
            },
            data: { unconfirmedPoints: { decrement: w.amountPoints } },
          })
        }

        if (agencyUserId && creditAssignment && hostPayoutPoints > 0n) {
          const payoutKey = `payroll-host-payout:${creditAssignment.id}`
          const existingPayout = await pointLedgerRepository.findByIdempotencyKey(tx, payoutKey)
          if (existingPayout) {
            await pointWalletService.debit(
              agencyUserId,
              hostPayoutPoints,
              PointTxType.ADJUSTMENT,
              tx,
              {
                idempotencyKey: `payroll-host-payout-reversal:${creditAssignment.id}`,
                refId: withdrawalId,
                description: `Payroll host payout reversal for withdrawal ${withdrawalId}`,
                availabilityCheck: false,
              },
            )
          }
        }

        if (agencyUserId && creditAssignment && agentReward > 0n) {
          const rewardKey = `payroll-reward:${creditAssignment.id}`
          const existing = await pointLedgerRepository.findByIdempotencyKey(tx, rewardKey)
          if (existing) {
            await pointWalletService.debit(agencyUserId, agentReward, PointTxType.ADJUSTMENT, tx, {
              idempotencyKey: `payroll-reward-reversal:${creditAssignment.id}`,
              refId: withdrawalId,
              description: `Payroll reward reversal for withdrawal ${withdrawalId}`,
              availabilityCheck: false,
            })
          }
        }

        if (openAssignment) {
          await payrollAssignmentRepository.updateStatus(
            {
              id: openAssignment.id,
              status: 'EXPIRED',
              rejectionReason: `Withdrawal reversed: ${reason}`,
            },
            tx,
          )
        }

        await withdrawalRepository.updateStatus(
          {
            id: withdrawalId,
            status: 'FAILED',
            failReason: reason,
          },
          tx,
        )
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_MS },
    )

    if (openAssignment) {
      await removePayrollSla(openAssignment.id)
      if (openAssignment.status === 'WAITING') {
        await removePayrollWaiting(openAssignment.id)
      }
      await bustPayrollSummaryCache(openAssignment.agencyUserId)
    }

    await walletService.adjustPointBalanceCache(w.userId, 0n)
    await walletService.bustUnconfirmedCache(w.userId)
    if (agencyUserId) {
      await walletService.adjustPointBalanceCache(agencyUserId, 0n)
      await bustPayrollSummaryCache(agencyUserId)
    }

    auditService.log({
      userId: adminUserId,
      actionType: 'WITHDRAWAL_REVERSED',
      actionStatus: 'success',
      actionDetails: { withdrawalId, reason, adminUserId },
    })

    void enqueuePlatformWithdrawalMessage({
      withdrawalId,
      event: 'failed',
      hostUserId: w.userId,
      agentUserId: agencyUserId ?? undefined,
      reason,
    }).catch(() => {})

    return prismaRead.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } })
  },

  /**
   * When admin freezes points: close all unsettled withdrawals and release soft escrow
   * (or reverse real debits for legacy v1). Settled PAID/DISPUTED rows are left alone.
   */
  async cancelUnsettledWithdrawalsForPointsFreeze(
    userId: string,
    adminUserId: string,
  ): Promise<{ cancelledIds: string[] }> {
    const open = await prisma.withdrawal.findMany({
      where: {
        userId,
        status: {
          in: ['PENDING', 'PENDING_PLATFORM', 'KYC_CHECK', 'APPROVED', 'PROCESSING', 'WAITING'],
        },
      },
      select: { id: true },
      orderBy: { requestedAt: 'asc' },
    })

    const cancelledIds: string[] = []
    for (const row of open) {
      await withdrawalService.adminReverseWithdrawal(
        adminUserId,
        row.id,
        'Points frozen by admin — withdrawal cancelled and escrow released',
      )
      cancelledIds.push(row.id)
    }
    return { cancelledIds }
  },

  async getWithdrawalHistory(userId: string, opts: { limit: number; cursor?: string }) {
    const rows = await withdrawalRepository.listForUser(userId, opts)
    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined
    return {
      items: page.map((row) =>
        withdrawalService.serializeWithdrawal({
          ...row,
          latestAssignmentStatus: row.payrollAssignments[0]?.status ?? null,
        }),
      ),
      nextCursor,
      hasMore,
    }
  },

  async getWithdrawalById(userId: string, id: string) {
    return withdrawalService.getWithdrawalDetail(id, userId)
  },

  async getWithdrawalDetail(withdrawalId: string, userId: string) {
    const row = await withdrawalRepository.findWithdrawalDetailForHost(withdrawalId, userId)
    if (!row) throw new AppError(404, 'Withdrawal not found', 'NOT_FOUND')

    const config = await withdrawalService.getPayrollConfig()

    const hostStatus = withdrawalService.resolveHostFacingStatus(
      row.status,
      row.payrollAssignments[0]?.status ?? null,
    )

    const timeTakenSeconds =
      hostStatus === 'PAID' && row.processedAt
        ? Math.round((row.processedAt.getTime() - row.requestedAt.getTime()) / 1000)
        : null

    const localCurrencyAmount =
      row.hostPayoutUsd !== null ? Number(row.hostPayoutUsd) * Number(config.inrPerUsd) : null

    const maskedMethod = row.paymentMethod ? mapPaymentMethodMaskedForHost(row.paymentMethod) : null

    return {
      id: row.id,
      status: hostStatus,
      grossPoints: row.amountPoints.toString(),
      grossUsd: (Number(row.amountPoints) / 10_000).toFixed(2),
      hostPayoutPoints: (Number(row.amountPoints) - Number(row.platformFeePoints ?? 0)).toString(),
      hostPayoutUsd: row.hostPayoutUsd?.toString() ?? null,
      platformFeePoints: row.platformFeePoints?.toString() ?? null,
      agentRewardPoints: row.agentRewardPoints?.toString() ?? null,
      notes: row.notes ?? null,
      timeTakenSeconds,
      timeTakenFormatted: timeTakenSeconds != null ? formatDuration(timeTakenSeconds) : null,
      localCurrencyAmount: localCurrencyAmount?.toFixed(2) ?? null,
      localCurrencyCode: 'INR',
      paymentMethod: maskedMethod,
      requestedAt: row.requestedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      disputeTicketId: row.disputeTicketId ?? null,
      assignmentCount: row.assignmentCount,
      payoutRef: row.payoutRef ?? null,
    }
  },

  /**
   * Host-facing status. After proof upload, withdrawal is persisted as WAITING.
   * Legacy rows may still be PENDING with assignment WAITING — map those without backfill.
   */
  resolveHostFacingStatus(
    status: WithdrawalStatus,
    latestAssignmentStatus?: string | null,
  ): WithdrawalStatus {
    if (status === 'WAITING') return 'WAITING'
    if (status === 'PENDING' && latestAssignmentStatus === 'WAITING') return 'WAITING'
    return status
  },

  serializeWithdrawal(w: {
    id: string
    amountPoints: bigint
    status: WithdrawalStatus
    requestedAt: Date
    processedAt: Date | null
    hostPayoutUsd: Prisma.Decimal | null
    platformFeePoints: bigint | null
    agentRewardPoints: bigint | null
    assignmentCount: number
    disputeTicketId: string | null
    paymentMethodId: string | null
    failReason?: string | null
    /** When set (host history), map PENDING + assignment WAITING → WAITING. */
    latestAssignmentStatus?: string | null
  }) {
    const status =
      w.latestAssignmentStatus !== undefined
        ? withdrawalService.resolveHostFacingStatus(w.status, w.latestAssignmentStatus)
        : w.status
    return {
      id: w.id,
      grossPoints: w.amountPoints.toString(),
      status,
      requestedAt: w.requestedAt.toISOString(),
      processedAt: w.processedAt?.toISOString() ?? null,
      hostPayoutUsd: w.hostPayoutUsd?.toString() ?? null,
      platformFeePoints: w.platformFeePoints?.toString() ?? null,
      agentRewardPoints: w.agentRewardPoints?.toString() ?? null,
      assignmentCount: w.assignmentCount,
      disputeTicketId: w.disputeTicketId,
      paymentMethodId: w.paymentMethodId,
      failReason: w.failReason ?? null,
    }
  },

  async getAgentPayrollInbox(
    agencyUserId: string,
    status: 'PENDING' | 'WAITING' | 'COMPLETED',
    cursor: string | undefined,
    limit: number,
  ) {
    if (status === 'PENDING') {
      return withdrawalService.getAgentPayrollInboxPending(agencyUserId, cursor, limit)
    }
    if (status === 'WAITING') {
      return withdrawalService.getAgentPayrollInboxWaiting(agencyUserId, cursor, limit)
    }

    const rows = await payrollAssignmentRepository.findInboxByStatus(
      agencyUserId,
      'COMPLETED',
      cursor,
      limit,
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined
    const config = await withdrawalService.getPayrollConfig()
    const tabCounts = await payrollAssignmentRepository.countInboxByStatus(agencyUserId)

    return {
      items: page.map((a) => {
        const settled = withdrawalService.mapSettledInboxItem(a, config)
        return {
          id: settled.id,
          status: settled.status,
          expiresAt: a.expiresAt.toISOString(),
          slaRemainingSeconds: 0,
          grossPoints: settled.grossPoints,
          hostPayoutUsd: settled.hostPayoutUsd,
          localCurrencyAmount: settled.localCurrencyAmount,
          localCurrencyCode: settled.localCurrencyCode,
          agentRewardPoints: settled.agentRewardPoints,
          paymentMethod: settled.paymentMethod,
        }
      }),
      nextCursor: nextCursor ?? null,
      total: tabCounts.completed,
    }
  },

  async getPayrollInbox(
    agencyUserId: string,
    opts: { status?: string; limit: number; cursor?: string },
  ) {
    const raw = (opts.status ?? 'PENDING').toUpperCase()
    const status =
      raw === 'WAITING' || raw === 'COMPLETED' ? (raw as 'WAITING' | 'COMPLETED') : 'PENDING'
    return withdrawalService.getAgentPayrollInbox(agencyUserId, status, opts.cursor, opts.limit)
  },

  async getPayrollAssignmentDetailForAgent(agencyUserId: string, assignmentId: string) {
    const row = await payrollAssignmentRepository.getByIdWithWithdrawalAndMethod(
      assignmentId,
      agencyUserId,
      new Date(),
    )
    if (!row) throw new AppError(404, 'Assignment not found', 'NOT_FOUND')
    return row
  },

  mapPendingInboxItem(a: InboxAssignmentRow, config: PayrollConfigSnapshot) {
    const hostPayoutUsd = Number(a.withdrawal.hostPayoutUsd ?? 0)
    return {
      id: a.id,
      status: a.status,
      withdrawalId: a.withdrawalId,
      expiresAt: a.expiresAt.toISOString(),
      slaRemainingSeconds: secondsUntil(a.expiresAt),
      grossPoints: agencyCreditPoints(a.withdrawal.amountPoints, a.withdrawal.platformFeePoints),
      hostPayoutUsd: a.withdrawal.hostPayoutUsd?.toString() ?? null,
      localCurrencyAmount: (hostPayoutUsd * config.inrPerUsd).toFixed(2),
      localCurrencyCode: 'INR' as const,
      agentRewardPoints: a.withdrawal.agentRewardPoints?.toString() ?? '0',
      paymentMethod: mapPaymentMethodForAgent(a.withdrawal.paymentMethod, a.status, a.expiresAt),
    }
  },

  mapWaitingInboxItem(a: InboxAssignmentRow, config: PayrollConfigSnapshot) {
    const hostPayoutUsd = Number(a.withdrawal.hostPayoutUsd ?? 0)
    const isDisputed = a.withdrawal.status === 'DISPUTED'
    const waitingExpiresAt = a.waitingExpiresAt
    const waitingSecondsRemaining =
      isDisputed || !waitingExpiresAt ? null : secondsUntil(waitingExpiresAt)
    return {
      id: a.id,
      status: a.status,
      withdrawalId: a.withdrawalId,
      waitingExpiresAt: waitingExpiresAt?.toISOString() ?? null,
      /** Countdown to end of waiting window (auto-PAID). Alias of waitingSecondsRemaining. */
      slaRemainingSeconds: waitingSecondsRemaining ?? 0,
      waitingSecondsRemaining,
      isDisputed,
      grossPoints: agencyCreditPoints(a.withdrawal.amountPoints, a.withdrawal.platformFeePoints),
      hostPayoutUsd: a.withdrawal.hostPayoutUsd?.toString() ?? null,
      localCurrencyAmount: (hostPayoutUsd * config.inrPerUsd).toFixed(2),
      localCurrencyCode: 'INR' as const,
      agentRewardPoints: a.withdrawal.agentRewardPoints?.toString() ?? '0',
      paymentMethod: a.withdrawal.paymentMethod
        ? mapPaymentMethodMaskedForAgent(a.withdrawal.paymentMethod)
        : null,
    }
  },

  mapSettledInboxItem(a: InboxAssignmentRow, config: PayrollConfigSnapshot) {
    const hostPayoutUsd = Number(a.withdrawal.hostPayoutUsd ?? 0)
    return {
      id: a.id,
      status: a.status as 'COMPLETED' | 'REJECTED',
      withdrawalId: a.withdrawalId,
      slaRemainingSeconds: 0,
      grossPoints: agencyCreditPoints(a.withdrawal.amountPoints, a.withdrawal.platformFeePoints),
      hostPayoutUsd: a.withdrawal.hostPayoutUsd?.toString() ?? null,
      localCurrencyAmount: (hostPayoutUsd * config.inrPerUsd).toFixed(2),
      localCurrencyCode: 'INR' as const,
      agentRewardPoints: a.withdrawal.agentRewardPoints?.toString() ?? '0',
      rejectionReason: a.rejectionReason ?? null,
      proofS3Key: a.proofS3Key ?? null,
      completedAt: a.completedAt?.toISOString() ?? null,
      rejectedAt: a.rejectedAt?.toISOString() ?? null,
      assignmentNumber: a.assignmentNumber,
      paymentMethod: a.withdrawal.paymentMethod
        ? mapPaymentMethodMaskedForAgent(a.withdrawal.paymentMethod)
        : null,
    }
  },

  async getAgentPayrollInboxPending(
    agencyUserId: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const rows = await payrollAssignmentRepository.findByAgentAndStatus(
      agencyUserId,
      ['PENDING'],
      limit,
      cursor,
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const config = await withdrawalService.getPayrollConfig()
    const tabCounts = await payrollAssignmentRepository.countInboxByStatus(agencyUserId)
    return {
      items: page.map((a) => withdrawalService.mapPendingInboxItem(a, config)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      total: tabCounts.pending,
    }
  },

  async getAgentPayrollInboxWaiting(
    agencyUserId: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const rows = await payrollAssignmentRepository.findByAgentAndStatus(
      agencyUserId,
      ['WAITING'],
      limit,
      cursor,
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const config = await withdrawalService.getPayrollConfig()
    const tabCounts = await payrollAssignmentRepository.countInboxByStatus(agencyUserId)
    return {
      items: page.map((a) => withdrawalService.mapWaitingInboxItem(a, config)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      total: tabCounts.waiting,
    }
  },

  async getAgentPayrollInboxSettled(
    agencyUserId: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const listCursor = cursor ? decodeAssignmentCursor(cursor) : undefined
    const rows = await payrollAssignmentRepository.findSettledByAgent(
      agencyUserId,
      limit,
      listCursor,
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const config = await withdrawalService.getPayrollConfig()
    const tabCounts = await payrollAssignmentRepository.countInboxByStatus(agencyUserId)
    const last = page[page.length - 1]
    return {
      items: page.map((a) => withdrawalService.mapSettledInboxItem(a, config)),
      nextCursor: hasMore && last ? encodeAssignmentCursor(last.updatedAt, last.id) : null,
      total: tabCounts.settled,
    }
  },

  async getAdminDisputedPayrolls(opts: { limit: number; cursor?: string }) {
    const take = opts.limit + 1
    const rows = await prismaRead.withdrawal.findMany({
      where: {
        status: 'DISPUTED',
        payrollAssignments: { some: { status: 'WAITING' } },
        ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
      },
      orderBy: { requestedAt: 'desc' },
      take,
      include: {
        paymentMethod: true,
        payrollAssignments: {
          where: { status: 'WAITING' },
          take: 1,
          include: {
            agencyUser: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                publicId: true,
              },
            },
          },
        },
      },
    })
    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const hostUsers = await prismaRead.user.findMany({
      where: { id: { in: page.map((w) => w.userId) } },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        publicId: true,
      },
    })
    const hostById = new Map(hostUsers.map((u) => [u.id, u]))
    const config = await withdrawalService.getPayrollConfig()
    return {
      items: page.map((w) => {
        const a = w.payrollAssignments[0]!
        const host = hostById.get(w.userId)
        const hostPayoutUsd = Number(w.hostPayoutUsd ?? 0)
        return {
          withdrawalId: w.id,
          hostUserId: w.userId,
          hostDisplayName: host ? userDisplayName(host) : w.userId,
          hostPublicId: host?.publicId.toString() ?? '',
          grossPoints: w.amountPoints.toString(),
          hostPayoutUsd: w.hostPayoutUsd?.toString() ?? null,
          localCurrencyAmount: (hostPayoutUsd * config.inrPerUsd).toFixed(2),
          localCurrencyCode: 'INR' as const,
          disputeTicketId: w.disputeTicketId,
          requestedAt: w.requestedAt.toISOString(),
          assignment: {
            id: a.id,
            agentUserId: a.agencyUserId,
            agentDisplayName: userDisplayName(a.agencyUser),
            agentPublicId: a.agencyUser.publicId.toString(),
            proofS3Key: a.proofS3Key,
            waitingExpiresAt: a.waitingExpiresAt?.toISOString() ?? null,
          },
          paymentMethod: w.paymentMethod ? mapPaymentMethodMaskedForAgent(w.paymentMethod) : null,
        }
      }),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    }
  },
}
