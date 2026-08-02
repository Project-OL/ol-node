import type { Prisma, WithdrawalStatus } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

const PENDING_STATUSES: WithdrawalStatus[] = ['PENDING', 'PROCESSING', 'PENDING_PLATFORM']

/** Open (escrow-locked) statuses for v2 escrow accounting. */
const ESCROWED_STATUSES: WithdrawalStatus[] = ['PENDING', 'PENDING_PLATFORM']

export type WithdrawalDetailRow = Prisma.WithdrawalGetPayload<{
  include: {
    paymentMethod: true
    payrollAssignments: {
      include: {
        agencyUser: { select: { username: true; firstName: true; lastName: true } }
      }
    }
  }
}>

export const withdrawalRepository = {
  async create(
    data: {
      id: string
      walletId: string
      userId: string
      amountPoints: bigint
      amountFiatCents?: bigint | null
      currency?: string
      status: WithdrawalStatus
      paymentMethodId: string
      hostPayoutUsd: Prisma.Decimal
      platformFeePoints: bigint
      agentRewardPoints: bigint
      idempotencyKey: string
      notes?: string | null
      withdrawalVersion?: number
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.withdrawal.create({
      data: {
        id: data.id,
        walletId: data.walletId,
        userId: data.userId,
        amountPoints: data.amountPoints,
        amountFiatCents: data.amountFiatCents ?? undefined,
        currency: data.currency ?? 'USD',
        status: data.status,
        paymentMethodId: data.paymentMethodId,
        hostPayoutUsd: data.hostPayoutUsd,
        platformFeePoints: data.platformFeePoints,
        agentRewardPoints: data.agentRewardPoints,
        idempotencyKey: data.idempotencyKey,
        notes: data.notes ?? null,
        withdrawalVersion: data.withdrawalVersion ?? 2,
      },
    })
  },

  getById(id: string) {
    return prismaRead.withdrawal.findUnique({ where: { id } })
  },

  getByIdForUser(id: string, userId: string) {
    return prismaRead.withdrawal.findFirst({
      where: { id, userId },
    })
  },

  findWithdrawalDetailForHost(
    withdrawalId: string,
    userId: string,
  ): Promise<WithdrawalDetailRow | null> {
    return prismaRead.withdrawal.findFirst({
      where: { id: withdrawalId, userId },
      include: {
        paymentMethod: true,
        payrollAssignments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            agencyUser: {
              select: { username: true, firstName: true, lastName: true },
            },
          },
        },
      },
    })
  },

  countActiveWithdrawalsForUser(userId: string): Promise<number> {
    return prismaRead.withdrawal.count({
      where: {
        userId,
        status: { in: PENDING_STATUSES },
      },
    })
  },

  async listForUser(userId: string, opts: { limit: number; cursor?: string }) {
    const take = opts.limit + 1
    const rows = await prismaRead.withdrawal.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      take,
      ...(opts.cursor
        ? {
            cursor: { id: opts.cursor },
            skip: 1,
          }
        : {}),
    })
    return rows
  },

  async updateStatus(
    data: {
      id: string
      status: WithdrawalStatus
      payoutRef?: string | null
      processedAt?: Date | null
      failReason?: string | null
      disputeTicketId?: string | null
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.withdrawal.update({
      where: { id: data.id },
      data: {
        status: data.status,
        ...(data.payoutRef !== undefined ? { payoutRef: data.payoutRef } : {}),
        ...(data.processedAt !== undefined ? { processedAt: data.processedAt } : {}),
        ...(data.failReason !== undefined ? { failReason: data.failReason } : {}),
        ...(data.disputeTicketId !== undefined ? { disputeTicketId: data.disputeTicketId } : {}),
      },
    })
  },

  async incrementAssignmentCount(id: string, tx: Prisma.TransactionClient) {
    return tx.withdrawal.update({
      where: { id },
      data: { assignmentCount: { increment: 1 } },
    })
  },

  /**
   * Total grossPoints currently escrowed (open v2 withdrawals in PENDING /
   * PENDING_PLATFORM). v1 (legacy real-debit) withdrawals are excluded — their
   * points were already removed from the ledger sum at create time.
   *
   * Note: `wallets.unconfirmedPoints` is the authoritative source for the
   * availability check; this helper is a reconciliation/observability aid.
   */
  async getTotalEscrowedPoints(userId: string, tx?: Prisma.TransactionClient): Promise<bigint> {
    const db = tx ?? prisma
    const agg = await db.withdrawal.aggregate({
      where: {
        userId,
        withdrawalVersion: 2,
        status: { in: ESCROWED_STATUSES },
      },
      _sum: { amountPoints: true },
    })
    return agg._sum.amountPoints ?? 0n
  },

  async hasPendingWithdrawalUsingMethod(userId: string, paymentMethodId: string): Promise<boolean> {
    const n = await prismaRead.withdrawal.count({
      where: {
        userId,
        paymentMethodId,
        status: { in: PENDING_STATUSES },
      },
    })
    return n > 0
  },

  /**
   * Round-robin pick (FOR UPDATE SKIP LOCKED). Updates last_payroll_assigned_at in same tx.
   * Prefers agencies with fewer open PENDING/WAITING assignments, then least-recently-assigned
   * (NULLS FIRST = newly enabled payroll). Same-country only; excludes withdrawer and their
   * current agency.
   */
  async getNextEligibleAgency(
    tx: Prisma.TransactionClient,
    hostCountry: string,
    opts: {
      withdrawerUserId: string
      excludeAgencyUserId?: string | null
    },
  ): Promise<string | null> {
    const excludeAgencyUserId = opts.excludeAgencyUserId ?? null
    const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT a.user_id
      FROM agencies a
      INNER JOIN users u ON u.id = a.user_id
      LEFT JOIN (
        SELECT agency_user_id, COUNT(*)::int AS open_cnt
        FROM withdrawal_payroll_assignments
        WHERE status IN ('PENDING', 'WAITING')
        GROUP BY agency_user_id
      ) open ON open.agency_user_id = a.user_id
      WHERE a.payroll_enabled = true
        AND (
          a.paused_at IS NULL
          OR (a.paused_until IS NOT NULL AND a.paused_until <= NOW())
        )
        AND u.country = ${hostCountry}
        AND a.user_id <> ${opts.withdrawerUserId}::uuid
        AND (
          ${excludeAgencyUserId}::uuid IS NULL
          OR a.user_id <> ${excludeAgencyUserId}::uuid
        )
      ORDER BY COALESCE(open.open_cnt, 0) ASC,
               a.last_payroll_assigned_at ASC NULLS FIRST,
               a.user_id ASC
      LIMIT 1
      FOR UPDATE OF a SKIP LOCKED
    `
    if (!rows.length) return null
    const uid = rows[0].user_id
    await tx.agency.update({
      where: { userId: uid },
      data: { lastPayrollAssignedAt: new Date() },
    })
    return uid
  },

  async touchAgencyPayrollTimestamp(agencyUserId: string, tx: Prisma.TransactionClient) {
    await tx.agency.update({
      where: { userId: agencyUserId },
      data: { lastPayrollAssignedAt: new Date() },
    })
  },

  listOverdueSlaAssignments(now: Date, limit: number) {
    return prismaRead.withdrawalPayrollAssignment.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: now },
      },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    })
  },

  listPendingPlatform(opts: { limit: number; cursor?: string }) {
    const take = opts.limit + 1
    return prismaRead.withdrawal.findMany({
      where: { status: 'PENDING_PLATFORM' },
      orderBy: { requestedAt: 'asc' },
      take,
      ...(opts.cursor
        ? {
            cursor: { id: opts.cursor },
            skip: 1,
          }
        : {}),
    })
  },
}
