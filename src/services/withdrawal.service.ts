import { randomUUID } from "crypto";
import {
  Prisma,
  WithdrawalStatus,
  PointTxType,
  WalletCurrencyType,
} from "@prisma/client";
import { prisma, prismaRead } from "../config/database";
import { redisClient, RedisKeys, PAYROLL_CONFIG_TTL } from "../config/redis";
import { AppError } from "../middlewares/errorHandler";
import { walletRepository } from "../repositories/wallet.repository";
import { withdrawalRepository } from "../repositories/withdrawal.repository";
import { payrollAssignmentRepository } from "../repositories/payrollAssignment.repository";
import { userPaymentMethodRepository } from "../repositories/userPaymentMethod.repository";
import { pointLedgerRepository } from "../repositories/point-ledger.repository";
import { pointWalletService } from "./point-wallet.service";
import { walletService } from "./wallet.service";
import { auditService } from "./audit.service";
import { supportService } from "./support.service";
import { storageService } from "./storage.service";
import { enqueuePayrollSla, removePayrollSla } from "../queues/payroll.queue";
import { s3Bucket } from "../config/s3";

const INTERACTIVE_TX_MS = 25_000;

export type PayrollConfigSnapshot = {
  id: number;
  platformFeeRateBp: number;
  agentRewardRateBp: number;
  serviceFeeUsd: number;
  minWithdrawalUsd: number;
  maxWithdrawalUsd: number;
  slaHours: number;
  maxAssignmentAttempts: number;
  inrPerUsd: number;
};

function decNum(d: Prisma.Decimal): number {
  return new Prisma.Decimal(d.toString()).toNumber();
}

/**
 * Pure fee math for Vitest + runtime. Uses BigInt for point splits; USD outputs use Decimal→number at boundaries only.
 */
export function calculateWithdrawalAmounts(
  grossPoints: bigint,
  config: PayrollConfigSnapshot,
): {
  platformFeePoints: bigint;
  agentRewardPoints: bigint;
  hostPayoutPoints: bigint;
  hostPayoutUsd: Prisma.Decimal;
  serviceFeeUsd: number;
  hostNetUsd: number;
} {
  if (grossPoints <= 0n) {
    throw new AppError(400, "Amount must be positive", "INVALID_AMOUNT");
  }

  const grossUsd = Number(grossPoints) / 10000;
  if (grossUsd < config.minWithdrawalUsd - 1e-9) {
    throw new AppError(
      400,
      "Below minimum withdrawal amount",
      "BELOW_MIN_WITHDRAWAL",
    );
  }
  if (grossUsd > config.maxWithdrawalUsd + 1e-9) {
    throw new AppError(
      400,
      "Above maximum withdrawal amount",
      "ABOVE_MAX_WITHDRAWAL",
    );
  }

  const platformFeePoints =
    (grossPoints * BigInt(config.platformFeeRateBp)) / 10000n;
  const agentRewardPoints =
    (grossPoints * BigInt(config.agentRewardRateBp)) / 10000n;
  const hostPayoutPoints = grossPoints - platformFeePoints;

  const hostPayoutUsd = new Prisma.Decimal(hostPayoutPoints.toString()).div(
    new Prisma.Decimal(10000),
  );

  const serviceFeeUsd = config.serviceFeeUsd;
  const hostNetUsd = hostPayoutUsd.toNumber() - serviceFeeUsd;

  return {
    platformFeePoints,
    agentRewardPoints,
    hostPayoutPoints,
    hostPayoutUsd,
    serviceFeeUsd,
    hostNetUsd,
  };
}

/** Alias for tests / PR checklist naming. */
export const calculateAmounts = calculateWithdrawalAmounts;

async function loadPayrollConfigRow(): Promise<PayrollConfigSnapshot> {
  const row = await prismaRead.payrollConfig.findUnique({ where: { id: 1 } });
  if (!row) {
    throw new AppError(500, "Payroll config missing", "CONFIG_ERROR");
  }
  return {
    id: row.id,
    platformFeeRateBp: row.platformFeeRateBp,
    agentRewardRateBp: row.agentRewardRateBp,
    serviceFeeUsd: decNum(row.serviceFeeUsd),
    minWithdrawalUsd: decNum(row.minWithdrawalUsd),
    maxWithdrawalUsd: decNum(row.maxWithdrawalUsd),
    slaHours: row.slaHours,
    maxAssignmentAttempts: row.maxAssignmentAttempts,
    inrPerUsd: decNum(row.inrPerUsd),
  };
}

export const withdrawalService = {
  async getPayrollConfig(): Promise<PayrollConfigSnapshot> {
    const key = RedisKeys.payrollConfig();
    const hit = await redisClient.get(key);
    if (hit) return JSON.parse(hit) as PayrollConfigSnapshot;
    const snap = await loadPayrollConfigRow();
    await redisClient.setex(key, PAYROLL_CONFIG_TTL, JSON.stringify(snap));
    return snap;
  },

  async bustPayrollConfigCache() {
    await redisClient.del(RedisKeys.payrollConfig());
  },

  calculateAmounts(grossPoints: bigint, config: PayrollConfigSnapshot) {
    return calculateWithdrawalAmounts(grossPoints, config);
  },

  async createWithdrawal(
    userId: string,
    params: {
      grossPoints: bigint;
      paymentMethodId: string;
      idempotencyKey: string;
    },
  ) {
    const idem = `withdrawal-create:${userId}:${params.idempotencyKey}`;
    const cached = await walletService.getCachedIdemResponse(idem);
    if (cached) return cached;

    const acquired = await walletService.acquireIdemKey(idem);
    if (!acquired) {
      throw new AppError(409, "Already processing", "IDEM_CONFLICT");
    }

    const method = await userPaymentMethodRepository.findById(
      params.paymentMethodId,
      userId,
    );
    if (!method) {
      throw new AppError(404, "Payment method not found", "NOT_FOUND");
    }

    if (await withdrawalRepository.hasPendingWithdrawal(userId)) {
      throw new AppError(
        409,
        "A withdrawal is already in progress",
        "WITHDRAWAL_IN_PROGRESS",
      );
    }

    const config = await withdrawalService.getPayrollConfig();
    const amounts = calculateWithdrawalAmounts(params.grossPoints, config);

    const withdrawalId = randomUUID();
    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.POINT,
    );

    await prisma.$transaction(
      async (tx) => {
        await pointWalletService.debit(
          userId,
          params.grossPoints,
          PointTxType.WITHDRAWAL,
          tx,
          {
            idempotencyKey: `withdrawal-debit:${withdrawalId}`,
            description: "Withdrawal request",
          },
        );

        await withdrawalRepository.create(
          {
            id: withdrawalId,
            walletId: wallet.id,
            userId,
            amountPoints: params.grossPoints,
            status: "PENDING",
            paymentMethodId: method.id,
            hostPayoutUsd: amounts.hostPayoutUsd,
            platformFeePoints: amounts.platformFeePoints,
            agentRewardPoints: amounts.agentRewardPoints,
            idempotencyKey: `withdrawal:${userId}:${withdrawalId}`,
          },
          tx,
        );
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_MS },
    );

    await walletService.adjustPointBalanceCache(userId, -params.grossPoints);

    await withdrawalService.assignToAgency(withdrawalId);

    const refreshed = await prismaRead.withdrawal.findUniqueOrThrow({
      where: { id: withdrawalId },
    });

    const response = {
      withdrawalId: refreshed.id,
      status: refreshed.status,
      grossPoints: refreshed.amountPoints.toString(),
      hostPayoutUsd: refreshed.hostPayoutUsd?.toString() ?? null,
    };
    await walletService.resolveIdemKey(idem, response);
    return response;
  },

  async assignToAgency(
    withdrawalId: string,
    opts?: {
      overrideAgencyUserId?: string;
      /** Admin manual assign may exceed automatic attempt cap. */
      allowBeyondAssignmentCap?: boolean;
    },
  ) {
    let assignmentIdOut: string | null = null;
    let expiresAtOut: Date | null = null;

    await prisma.$transaction(
      async (tx) => {
        const w = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
        if (!w) return;
        if (w.status !== "PENDING" && w.status !== "PENDING_PLATFORM") return;

        const cfgCap = await tx.payrollConfig.findUnique({ where: { id: 1 } });
        const maxAttempts = cfgCap?.maxAssignmentAttempts ?? 5;
        const attemptCount = w.assignmentCount ?? 0;
        if (
          attemptCount >= maxAttempts &&
          !opts?.overrideAgencyUserId &&
          !opts?.allowBeyondAssignmentCap
        ) {
          if (w.status !== WithdrawalStatus.PENDING_PLATFORM) {
            await withdrawalRepository.updateStatus(
              { id: withdrawalId, status: "PENDING_PLATFORM" },
              tx,
            );
            auditService.log({
              actionType: "WITHDRAWAL_ASSIGNMENTS_EXHAUSTED",
              actionStatus: "success",
              actionDetails: { withdrawalId, assignmentCount: attemptCount },
            });
          }
          return;
        }

        let agencyUserId: string | null = null;
        if (opts?.overrideAgencyUserId) {
          const ag = await tx.agency.findFirst({
            where: {
              userId: opts.overrideAgencyUserId,
              payrollEnabled: true,
              pausedAt: null,
            },
          });
          if (ag) {
            agencyUserId = ag.userId;
            await withdrawalRepository.touchAgencyPayrollTimestamp(
              agencyUserId,
              tx,
            );
          }
        } else {
          agencyUserId = await withdrawalRepository.getNextEligibleAgency(tx);
        }

        if (!agencyUserId) {
          await withdrawalRepository.updateStatus(
            { id: withdrawalId, status: "PENDING_PLATFORM" },
            tx,
          );
          auditService.log({
            actionType: "WITHDRAWAL_NO_AGENCY",
            actionStatus: "success",
            actionDetails: { withdrawalId },
          });
          return;
        }

        const cfg = await tx.payrollConfig.findUnique({ where: { id: 1 } });
        const slaHours = cfg?.slaHours ?? 2;
        const expiresAt = new Date(Date.now() + slaHours * 3600 * 1000);

        const assignmentNumber = w.assignmentCount + 1;
        const assignmentId = randomUUID();

        await payrollAssignmentRepository.create(
          {
            id: assignmentId,
            withdrawalId,
            agencyUserId,
            expiresAt,
            assignmentNumber,
          },
          tx,
        );

        await withdrawalRepository.updateStatus(
          { id: withdrawalId, status: "PENDING" },
          tx,
        );

        assignmentIdOut = assignmentId;
        expiresAtOut = expiresAt;
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_MS },
    );

    if (assignmentIdOut && expiresAtOut) {
      await enqueuePayrollSla(assignmentIdOut, expiresAtOut);
    }
  },

  async processSlaExpiry(job: { assignmentId: string }) {
    const now = new Date();
    const assignment = await prismaRead.withdrawalPayrollAssignment.findUnique({
      where: { id: job.assignmentId },
    });
    if (!assignment) return;
    if (assignment.status !== "PENDING" || assignment.expiresAt > now) return;

    let withdrawalId = assignment.withdrawalId;
    let shouldReassign = false;

    await prisma.$transaction(
      async (tx) => {
        const a = await tx.withdrawalPayrollAssignment.findUnique({
          where: { id: job.assignmentId },
        });
        if (!a || a.status !== "PENDING" || a.expiresAt > now) return;

        await payrollAssignmentRepository.updateStatus(
          { id: a.id, status: "EXPIRED" },
          tx,
        );

        const wAfter = await withdrawalRepository.incrementAssignmentCount(
          a.withdrawalId,
          tx,
        );

        const cfg = await tx.payrollConfig.findUnique({ where: { id: 1 } });
        const max = cfg?.maxAssignmentAttempts ?? 5;

        if (wAfter.assignmentCount >= max) {
          await withdrawalRepository.updateStatus(
            { id: a.withdrawalId, status: "PENDING_PLATFORM" },
            tx,
          );
          auditService.log({
            actionType: "WITHDRAWAL_ASSIGNMENTS_EXHAUSTED",
            actionStatus: "success",
            actionDetails: { withdrawalId: a.withdrawalId },
          });
          return;
        }

        withdrawalId = a.withdrawalId;
        shouldReassign = true;
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_MS },
    );

    await removePayrollSla(job.assignmentId);
    if (shouldReassign) {
      await withdrawalService.assignToAgency(withdrawalId);
    }
  },

  async agentRejectPayroll(
    agentUserId: string,
    assignmentId: string,
    reason?: string,
  ) {
    let withdrawalId: string | null = null;
    const now = new Date();

    await prisma.$transaction(
      async (tx) => {
        const a = await tx.withdrawalPayrollAssignment.findFirst({
          where: { id: assignmentId, agencyUserId: agentUserId },
        });
        if (!a) {
          throw new AppError(404, "Assignment not found", "NOT_FOUND");
        }
        if (a.status !== "PENDING" || a.expiresAt <= now) {
          throw new AppError(400, "Assignment cannot be rejected", "INVALID_STATE");
        }

        await payrollAssignmentRepository.updateStatus(
          {
            id: assignmentId,
            status: "REJECTED",
            rejectedAt: now,
            rejectionReason: reason ?? null,
          },
          tx,
        );

        const wAfter = await withdrawalRepository.incrementAssignmentCount(
          a.withdrawalId,
          tx,
        );

        const cfg = await tx.payrollConfig.findUnique({ where: { id: 1 } });
        const max = cfg?.maxAssignmentAttempts ?? 5;

        if (wAfter.assignmentCount >= max) {
          await withdrawalRepository.updateStatus(
            { id: a.withdrawalId, status: "PENDING_PLATFORM" },
            tx,
          );
          auditService.log({
            actionType: "WITHDRAWAL_ASSIGNMENTS_EXHAUSTED",
            actionStatus: "success",
            actionDetails: { withdrawalId: a.withdrawalId },
          });
          withdrawalId = null;
        } else {
          withdrawalId = a.withdrawalId;
        }
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_MS },
    );

    await removePayrollSla(assignmentId);
    if (withdrawalId) await withdrawalService.assignToAgency(withdrawalId);
  },

  async getPresignedProofUrl(
    agentUserId: string,
    assignmentId: string,
    mimeType: string,
  ) {
    const now = new Date();
    const a = await prismaRead.withdrawalPayrollAssignment.findFirst({
      where: { id: assignmentId, agencyUserId: agentUserId },
    });
    if (!a) throw new AppError(404, "Assignment not found", "NOT_FOUND");
    if (a.status !== "PENDING" || a.expiresAt <= now) {
      throw new AppError(400, "Proof upload not allowed", "INVALID_STATE");
    }

    const key = `payroll/proofs/${assignmentId}/${agentUserId}`;
    const uploadUrl = await storageService.getPresignedPutUrl(key, mimeType, 600);
    return {
      uploadUrl,
      s3Key: key,
      s3Bucket: s3Bucket ?? "",
    };
  },

  async agentCompletePayroll(
    agentUserId: string,
    assignmentId: string,
    params: { proofS3Key: string; proofS3Bucket: string },
  ) {
    const now = new Date();
    const prefix = `payroll/proofs/${assignmentId}/`;
    if (!params.proofS3Key.startsWith(prefix)) {
      throw new AppError(400, "Invalid proof key", "INVALID_PROOF_KEY");
    }

    await prisma.$transaction(
      async (tx) => {
        const a = await tx.withdrawalPayrollAssignment.findFirst({
          where: { id: assignmentId, agencyUserId: agentUserId },
          include: { withdrawal: true },
        });
        if (!a) throw new AppError(404, "Assignment not found", "NOT_FOUND");
        if (a.status !== "PENDING") {
          throw new AppError(400, "Assignment not active", "INVALID_STATE");
        }
        if (a.expiresAt <= now) {
          throw new AppError(400, "SLA expired", "SLA_EXPIRED");
        }

        const reward = a.withdrawal.agentRewardPoints ?? 0n;
        const withdrawalUserId = a.withdrawal.userId;

        await payrollAssignmentRepository.updateStatus(
          {
            id: assignmentId,
            status: "COMPLETED",
            proofS3Key: params.proofS3Key,
            proofS3Bucket: params.proofS3Bucket,
            completedAt: now,
          },
          tx,
        );

        await withdrawalRepository.updateStatus(
          {
            id: a.withdrawalId,
            status: "PAID",
            payoutRef: params.proofS3Key,
            processedAt: now,
          },
          tx,
        );

        if (reward > 0n) {
          await pointWalletService.creditInTransaction(
            agentUserId,
            reward,
            PointTxType.PAYROLL_PROCESSING_REWARD,
            tx,
            {
              idempotencyKey: `payroll-reward:${assignmentId}`,
              refId: a.withdrawalId,
              counterpartyId: withdrawalUserId,
              description: "Payroll processing reward",
              applyLivestreamLevel: false,
            },
          );
        }
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_MS },
    );

    await removePayrollSla(assignmentId);
    await walletService.adjustPointBalanceCache(agentUserId, 0n);

    console.info(
      `[withdrawal] Payroll complete assignment=${assignmentId} agent=${agentUserId} — host notify stub`,
    );
  },

  async raiseDispute(
    hostUserId: string,
    withdrawalId: string,
    description?: string,
  ) {
    const w = await prismaRead.withdrawal.findFirst({
      where: { id: withdrawalId, userId: hostUserId },
    });
    if (!w) throw new AppError(404, "Withdrawal not found", "NOT_FOUND");
    if (w.status !== "PAID") {
      throw new AppError(400, "Withdrawal is not paid", "INVALID_STATE");
    }
    if (w.disputeTicketId) {
      throw new AppError(409, "Dispute already raised", "DISPUTE_ALREADY_RAISED");
    }
    if (!w.processedAt) {
      throw new AppError(400, "Missing processed timestamp", "INVALID_STATE");
    }

    const windowEnd = new Date(w.processedAt);
    windowEnd.setDate(windowEnd.getDate() + 30);
    if (new Date() > windowEnd) {
      throw new AppError(
        400,
        "Dispute window expired",
        "DISPUTE_WINDOW_EXPIRED",
      );
    }

    const completed =
      await payrollAssignmentRepository.findCompletedForWithdrawal(withdrawalId);

    const ticket = await supportService.createTicket(hostUserId, {
      type: "REPORT_COMPLAINTS",
      subType: "WITHDRAWAL_DISPUTE",
      description: `Withdrawal dispute for ID: ${withdrawalId}. ${description ?? ""}`,
      imageUrl: undefined,
    });

    await prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.DISPUTED,
        disputeTicketId: ticket.publicId,
      },
    });

    auditService.log({
      userId: hostUserId,
      actionType: "WITHDRAWAL_DISPUTE_RAISED",
      actionStatus: "success",
      actionDetails: {
        withdrawalId,
        ticketPublicId: ticket.publicId,
        agencyUserId: completed?.agencyUserId,
        proofS3Key: completed?.proofS3Key,
      },
    });

    return { ticketId: ticket.publicId };
  },

  async adminReverseWithdrawal(
    adminUserId: string,
    withdrawalId: string,
    reason: string,
  ) {
    const w = await prismaRead.withdrawal.findUnique({
      where: { id: withdrawalId },
    });
    if (!w) throw new AppError(404, "Withdrawal not found", "NOT_FOUND");
    if (w.status === "FAILED") {
      return w;
    }
    if (w.status !== "PAID" && w.status !== "DISPUTED") {
      throw new AppError(400, "Withdrawal cannot be reversed", "INVALID_STATE");
    }

    const completed =
      await payrollAssignmentRepository.findCompletedForWithdrawal(withdrawalId);
    const agencyUserId = completed?.agencyUserId ?? null;

    await prisma.$transaction(
      async (tx) => {
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
        );

        if (agencyUserId && (w.agentRewardPoints ?? 0n) > 0n) {
          const rewardKey = `payroll-reward:${completed!.id}`;
          const existing = await pointLedgerRepository.findByIdempotencyKey(
            tx,
            rewardKey,
          );
          if (existing) {
            await pointWalletService.debit(
              agencyUserId,
              w.agentRewardPoints!,
              PointTxType.ADJUSTMENT,
              tx,
              {
                idempotencyKey: `payroll-reward-reversal:${completed!.id}`,
                description: `Payroll reward reversal for withdrawal ${withdrawalId}`,
              },
            );
          }
        }

        await withdrawalRepository.updateStatus(
          {
            id: withdrawalId,
            status: "FAILED",
            failReason: reason,
          },
          tx,
        );
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_MS },
    );

    await walletService.adjustPointBalanceCache(w.userId, 0n);
    if (agencyUserId) {
      await walletService.adjustPointBalanceCache(agencyUserId, 0n);
    }

    auditService.log({
      userId: adminUserId,
      actionType: "WITHDRAWAL_REVERSED",
      actionStatus: "success",
      actionDetails: { withdrawalId, reason, adminUserId },
    });

    return prismaRead.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  },

  async getWithdrawalHistory(
    userId: string,
    opts: { limit: number; cursor?: string },
  ) {
    const rows = await withdrawalRepository.listForUser(userId, opts);
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;
    return {
      items: page.map(withdrawalService.serializeWithdrawal),
      nextCursor,
      hasMore,
    };
  },

  async getWithdrawalById(userId: string, id: string) {
    const w = await withdrawalRepository.getByIdForUser(id, userId);
    if (!w) throw new AppError(404, "Withdrawal not found", "NOT_FOUND");
    return withdrawalService.serializeWithdrawal(w);
  },

  serializeWithdrawal(w: {
    id: string;
    amountPoints: bigint;
    status: WithdrawalStatus;
    requestedAt: Date;
    processedAt: Date | null;
    hostPayoutUsd: Prisma.Decimal | null;
    platformFeePoints: bigint | null;
    agentRewardPoints: bigint | null;
    assignmentCount: number;
    disputeTicketId: string | null;
    paymentMethodId: string | null;
    failReason?: string | null;
  }) {
    return {
      id: w.id,
      grossPoints: w.amountPoints.toString(),
      status: w.status,
      requestedAt: w.requestedAt.toISOString(),
      processedAt: w.processedAt?.toISOString() ?? null,
      hostPayoutUsd: w.hostPayoutUsd?.toString() ?? null,
      platformFeePoints: w.platformFeePoints?.toString() ?? null,
      agentRewardPoints: w.agentRewardPoints?.toString() ?? null,
      assignmentCount: w.assignmentCount,
      disputeTicketId: w.disputeTicketId,
      paymentMethodId: w.paymentMethodId,
      failReason: w.failReason ?? null,
    };
  },

  async getPayrollInbox(
    agencyUserId: string,
    opts: { status?: string; limit: number; cursor?: string },
  ) {
    const rows = await payrollAssignmentRepository.listForAgent(agencyUserId, opts);
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;
    return {
      items: page.map((r) => ({
        assignmentId: r.id,
        withdrawalId: r.withdrawalId,
        status: r.status,
        assignedAt: r.assignedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        withdrawal: r.withdrawal,
      })),
      nextCursor,
      hasMore,
    };
  },

  async getPayrollAssignmentDetailForAgent(
    agencyUserId: string,
    assignmentId: string,
  ) {
    const row =
      await payrollAssignmentRepository.getByIdWithWithdrawalAndMethod(
        assignmentId,
        agencyUserId,
        new Date(),
      );
    if (!row) throw new AppError(404, "Assignment not found", "NOT_FOUND");
    return row;
  },
};
