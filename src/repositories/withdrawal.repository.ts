import type { Prisma, WithdrawalStatus } from "@prisma/client";
import { prismaRead } from "../config/database";

const PENDING_STATUSES: WithdrawalStatus[] = [
  "PENDING",
  "PROCESSING",
  "PENDING_PLATFORM",
];

export const withdrawalRepository = {
  async create(
    data: {
      id: string;
      walletId: string;
      userId: string;
      amountPoints: bigint;
      amountFiatCents?: bigint | null;
      currency?: string;
      status: WithdrawalStatus;
      paymentMethodId: string;
      hostPayoutUsd: Prisma.Decimal;
      platformFeePoints: bigint;
      agentRewardPoints: bigint;
      idempotencyKey: string;
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
        currency: data.currency ?? "USD",
        status: data.status,
        paymentMethodId: data.paymentMethodId,
        hostPayoutUsd: data.hostPayoutUsd,
        platformFeePoints: data.platformFeePoints,
        agentRewardPoints: data.agentRewardPoints,
        idempotencyKey: data.idempotencyKey,
      },
    });
  },

  getById(id: string) {
    return prismaRead.withdrawal.findUnique({ where: { id } });
  },

  getByIdForUser(id: string, userId: string) {
    return prismaRead.withdrawal.findFirst({
      where: { id, userId },
    });
  },

  async listForUser(
    userId: string,
    opts: { limit: number; cursor?: string },
  ) {
    const take = opts.limit + 1;
    const rows = await prismaRead.withdrawal.findMany({
      where: { userId },
      orderBy: { requestedAt: "desc" },
      take,
      ...(opts.cursor
        ? {
            cursor: { id: opts.cursor },
            skip: 1,
          }
        : {}),
    });
    return rows;
  },

  async updateStatus(
    data: {
      id: string;
      status: WithdrawalStatus;
      payoutRef?: string | null;
      processedAt?: Date | null;
      failReason?: string | null;
      disputeTicketId?: string | null;
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
        ...(data.disputeTicketId !== undefined
          ? { disputeTicketId: data.disputeTicketId }
          : {}),
      },
    });
  },

  async incrementAssignmentCount(id: string, tx: Prisma.TransactionClient) {
    return tx.withdrawal.update({
      where: { id },
      data: { assignmentCount: { increment: 1 } },
    });
  },

  async hasPendingWithdrawal(userId: string): Promise<boolean> {
    const n = await prismaRead.withdrawal.count({
      where: {
        userId,
        status: { in: PENDING_STATUSES },
      },
    });
    return n > 0;
  },

  async hasPendingWithdrawalUsingMethod(
    userId: string,
    paymentMethodId: string,
  ): Promise<boolean> {
    const n = await prismaRead.withdrawal.count({
      where: {
        userId,
        paymentMethodId,
        status: { in: PENDING_STATUSES },
      },
    });
    return n > 0;
  },

  /**
   * Round-robin pick (FOR UPDATE SKIP LOCKED). Updates last_payroll_assigned_at in same tx.
   */
  async getNextEligibleAgency(
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id FROM agencies
      WHERE payroll_enabled = true AND paused_at IS NULL
      ORDER BY last_payroll_assigned_at ASC NULLS FIRST, user_id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (!rows.length) return null;
    const uid = rows[0].user_id;
    await tx.agency.update({
      where: { userId: uid },
      data: { lastPayrollAssignedAt: new Date() },
    });
    return uid;
  },

  async touchAgencyPayrollTimestamp(
    agencyUserId: string,
    tx: Prisma.TransactionClient,
  ) {
    await tx.agency.update({
      where: { userId: agencyUserId },
      data: { lastPayrollAssignedAt: new Date() },
    });
  },

  listOverdueSlaAssignments(now: Date, limit: number) {
    return prismaRead.withdrawalPayrollAssignment.findMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: now },
      },
      take: limit,
      orderBy: { expiresAt: "asc" },
    });
  },

  listPendingPlatform(opts: { limit: number; cursor?: string }) {
    const take = opts.limit + 1;
    return prismaRead.withdrawal.findMany({
      where: { status: "PENDING_PLATFORM" },
      orderBy: { requestedAt: "asc" },
      take,
      ...(opts.cursor
        ? {
            cursor: { id: opts.cursor },
            skip: 1,
          }
        : {}),
    });
  },
};
