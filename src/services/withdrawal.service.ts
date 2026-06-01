import { randomUUID } from "crypto";
import {
  Prisma,
  WithdrawalStatus,
  PointTxType,
  WalletCurrencyType,
  LedgerDirection,
} from "@prisma/client";
import { prisma, prismaRead } from "../config/database";
import {
  redisClient,
  RedisKeys,
  PAYROLL_CONFIG_TTL,
  PAYROLL_SUMMARY_TTL,
} from "../config/redis";
import {
  resolveCommissionPeriod,
  commissionPeriodToLedgerBounds,
  utcDateString,
} from "../utils/datetime";
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
import {
  mapPaymentMethodForAgent,
  mapPaymentMethodMaskedForHost,
} from "../utils/payment-method-mask";
import {
  formatDuration,
} from "../utils/withdrawal-formatters";
import type { DisputeWithdrawalInput } from "../models/withdrawal.schemas";

const INTERACTIVE_TX_MS = 25_000;
const DISPUTE_EVIDENCE_PRESIGN_TTL = 600;

async function bustPayrollSummaryCache(agencyUserId: string) {
  await redisClient.del(RedisKeys.payrollSummary(agencyUserId));
  // Period-scoped summary caches (payroll:summary:{id}:{periodKey}).
  try {
    const keys = await redisClient.keys(
      `${RedisKeys.payrollSummary(agencyUserId)}:*`,
    );
    if (keys.length > 0) await redisClient.del(...keys);
  } catch {
    /* ignore — caches expire within 30s */
  }
}

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
    const { start, end } = resolveCommissionPeriod(periodParams);
    const periodKey =
      periodParams.from && periodParams.to
        ? `${periodParams.from}_${periodParams.to}`
        : String(periodParams.periodDays ?? 30);

    const cacheKey = RedisKeys.payrollSummaryPeriod(agencyUserId, periodKey);
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached) as Record<string, unknown>;

    const { from, toExclusive } = commissionPeriodToLedgerBounds(start, end);

    const wallet = await walletRepository.getOrCreate(
      agencyUserId,
      WalletCurrencyType.POINT,
    );

    const [agency, rewardSummary, tabCounts, periodEntries, completedAssignments] =
      await Promise.all([
        prismaRead.agency.findUnique({
          where: { userId: agencyUserId },
          select: { payrollEnabled: true, pausedAt: true },
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
              in: [
                PointTxType.PAYROLL_HOST_PAYOUT,
                PointTxType.PAYROLL_PROCESSING_REWARD,
              ],
            },
            createdAt: { gte: from, lt: toExclusive },
          },
          select: { txType: true, amount: true, refId: true },
        }),
        prismaRead.withdrawalPayrollAssignment.findMany({
          where: {
            agencyUserId,
            status: "COMPLETED",
            completedAt: { gte: from, lt: toExclusive },
            withdrawal: { status: { not: WithdrawalStatus.FAILED } },
          },
          select: { withdrawal: { select: { hostPayoutUsd: true } } },
        }),
      ]);

    if (!agency) throw new AppError(404, "Agency not found", "NOT_FOUND");

    // Exclude ledger credits whose withdrawal was reversed (FAILED).
    const refIds = [
      ...new Set(periodEntries.map((e) => e.refId).filter((r): r is string => !!r)),
    ];
    const reversed = refIds.length
      ? await prismaRead.withdrawal.findMany({
          where: { id: { in: refIds }, status: WithdrawalStatus.FAILED },
          select: { id: true },
        })
      : [];
    const reversedSet = new Set(reversed.map((r) => r.id));

    let hostPayoutPoints = 0n;
    let rewardPoints = 0n;
    for (const e of periodEntries) {
      if (e.refId && reversedSet.has(e.refId)) continue;
      if (e.txType === PointTxType.PAYROLL_HOST_PAYOUT) {
        hostPayoutPoints += e.amount;
      } else if (e.txType === PointTxType.PAYROLL_PROCESSING_REWARD) {
        rewardPoints += e.amount;
      }
    }

    let usd = new Prisma.Decimal(0);
    for (const a of completedAssignments) {
      if (a.withdrawal.hostPayoutUsd) usd = usd.add(a.withdrawal.hostPayoutUsd);
    }

    const result = {
      takeOrderEnabled: agency.payrollEnabled && !agency.pausedAt,
      payrollEnabled: agency.payrollEnabled,
      isPaused: !!agency.pausedAt,
      totalRewardPoints: (rewardSummary._sum.amount ?? 0n).toString(),
      tabCounts,
      pendingCount: tabCounts.pending,
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
    };

    await redisClient.setex(cacheKey, PAYROLL_SUMMARY_TTL, JSON.stringify(result));
    return result;
  },

  async createWithdrawal(
    userId: string,
    params: {
      grossPoints: bigint;
      paymentMethodId: string;
      idempotencyKey: string;
      notes?: string;
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

    // Multiple open withdrawals are allowed (v2). Spending is capped by the
    // host's AVAILABLE points (totalPoints − unconfirmedPoints), enforced inside
    // the Serializable transaction below.

    const config = await withdrawalService.getPayrollConfig();
    const amounts = calculateWithdrawalAmounts(params.grossPoints, config);

    const withdrawalId = randomUUID();
    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.POINT,
    );

    await prisma.$transaction(
      async (tx) => {
        // Lock the POINT wallet row first so the availability check and escrow
        // increment are serialized against concurrent withdrawal creation.
        await walletRepository.lockForUpdate(tx, wallet.id);
        const walletRow = await tx.wallet.findUniqueOrThrow({
          where: { id: wallet.id },
          select: { unconfirmedPoints: true },
        });
        const last = await tx.pointLedgerEntry.findFirst({
          where: { walletId: wallet.id },
          orderBy: { createdAt: "desc" },
          select: { balanceAfter: true },
        });
        const totalPoints = last?.balanceAfter ?? 0n;
        const unconfirmed = walletRow.unconfirmedPoints ?? 0n;
        const available = totalPoints - unconfirmed;
        if (available < params.grossPoints) {
          throw new AppError(
            400,
            "Insufficient available points",
            "INSUFFICIENT_POINTS",
            {
              balance: available.toString(),
              required: params.grossPoints.toString(),
              unconfirmed: unconfirmed.toString(),
            },
          );
        }

        // Soft escrow: marks points in-flight without reducing the ledger sum.
        await pointWalletService.escrow(
          userId,
          params.grossPoints,
          PointTxType.WITHDRAWAL_ESCROW,
          tx,
          {
            idempotencyKey: `withdrawal-escrow:${withdrawalId}`,
            refId: withdrawalId,
            description: "Withdrawal escrow",
          },
        );

        await tx.wallet.update({
          where: { id: wallet.id },
          data: { unconfirmedPoints: { increment: params.grossPoints } },
        });

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
            notes: params.notes ?? null,
            withdrawalVersion: 2,
          },
          tx,
        );

        await userPaymentMethodRepository.touchLastUsed(method.id, userId, tx);
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_MS },
    );

    await redisClient.del(RedisKeys.userPaymentMethods(userId));
    // totalPoints (ledger sum) is unchanged by soft escrow; bust to force a
    // recompute, and bust the unconfirmed cache (now higher).
    await walletService.adjustPointBalanceCache(userId, 0n);
    await walletService.bustUnconfirmedCache(userId);

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
      const assignment = await prismaRead.withdrawalPayrollAssignment.findUnique({
        where: { id: assignmentIdOut },
        select: { agencyUserId: true },
      });
      if (assignment) await bustPayrollSummaryCache(assignment.agencyUserId);
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
    await bustPayrollSummaryCache(agentUserId);
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
  ): Promise<{ agentRewardPoints: string; hostPayoutPoints: string }> {
    const now = new Date();
    const prefix = `payroll/proofs/${assignmentId}/`;
    if (!params.proofS3Key.startsWith(prefix)) {
      throw new AppError(400, "Invalid proof key", "INVALID_PROOF_KEY");
    }

    let rewardOut = "0";
    let hostPayoutOut = "0";
    let hostUserIdOut = "";
    let settledEscrow = false;

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

        const grossPoints = a.withdrawal.amountPoints;
        const platformFeePoints = a.withdrawal.platformFeePoints ?? 0n;
        const hostPayoutPoints = grossPoints - platformFeePoints;
        const reward = a.withdrawal.agentRewardPoints ?? 0n;
        const isV2 = a.withdrawal.withdrawalVersion === 2;
        const hostUserId = a.withdrawal.userId;

        rewardOut = reward.toString();
        hostPayoutOut = hostPayoutPoints.toString();
        hostUserIdOut = hostUserId;
        settledEscrow = isV2;

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

        // Step 1 (v2 only): settle escrow — REAL debit consuming the escrowed
        // points from the host wallet, then release the unconfirmed counter.
        // v1 (legacy) withdrawals already debited the points at create time.
        if (isV2) {
          await pointWalletService.debit(
            hostUserId,
            grossPoints,
            PointTxType.WITHDRAWAL_ESCROW_SETTLED,
            tx,
            {
              idempotencyKey: `withdrawal-settled:${assignmentId}`,
              refId: a.withdrawalId,
              counterpartyId: agentUserId,
              description: "Withdrawal escrow settled",
              availabilityCheck: false,
            },
          );
          await tx.wallet.update({
            where: {
              userId_currencyType: {
                userId: hostUserId,
                currencyType: WalletCurrencyType.POINT,
              },
            },
            data: { unconfirmedPoints: { decrement: grossPoints } },
          });
        }

        // Step 2: credit agent hostPayoutPoints (new in v2 flow).
        if (hostPayoutPoints > 0n) {
          await pointWalletService.creditInTransaction(
            agentUserId,
            hostPayoutPoints,
            PointTxType.PAYROLL_HOST_PAYOUT,
            tx,
            {
              idempotencyKey: `payroll-host-payout:${assignmentId}`,
              refId: a.withdrawalId,
              counterpartyId: hostUserId,
              description: "Payroll host payout",
              applyLivestreamLevel: false,
            },
          );
        }

        // Step 3: credit agent processing reward (existing).
        if (reward > 0n) {
          await pointWalletService.creditInTransaction(
            agentUserId,
            reward,
            PointTxType.PAYROLL_PROCESSING_REWARD,
            tx,
            {
              idempotencyKey: `payroll-reward:${assignmentId}`,
              refId: a.withdrawalId,
              counterpartyId: hostUserId,
              description: "Payroll processing reward",
              applyLivestreamLevel: false,
            },
          );
        }
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_MS },
    );

    await removePayrollSla(assignmentId);
    await bustPayrollSummaryCache(agentUserId);
    await walletService.adjustPointBalanceCache(agentUserId, 0n);
    if (settledEscrow && hostUserIdOut) {
      await walletService.adjustPointBalanceCache(hostUserIdOut, 0n);
      await walletService.bustUnconfirmedCache(hostUserIdOut);
    }

    console.info(
      `[withdrawal] Payroll complete assignment=${assignmentId} agent=${agentUserId} — host notify stub`,
    );

    return { agentRewardPoints: rewardOut, hostPayoutPoints: hostPayoutOut };
  },

  async createDisputeEvidenceUploadUrl(
    withdrawalId: string,
    userId: string,
    mimeType: string,
  ): Promise<{ uploadUrl: string; s3Key: string; expiresInSec: number }> {
    const row = await prismaRead.withdrawal.findFirst({
      where: { id: withdrawalId, userId },
      select: { status: true },
    });
    if (!row) throw new AppError(404, "Withdrawal not found", "NOT_FOUND");
    if (row.status !== "PAID" && row.status !== "DISPUTED") {
      throw new AppError(
        400,
        "Evidence upload only allowed for PAID or DISPUTED withdrawals",
        "INVALID_STATE",
      );
    }

    const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
    const s3Key = `withdrawal/disputes/${userId}/${withdrawalId}/${Date.now()}.${ext}`;
    const uploadUrl = await storageService.getPresignedPutUrl(
      s3Key,
      mimeType,
      DISPUTE_EVIDENCE_PRESIGN_TTL,
    );
    return {
      uploadUrl,
      s3Key,
      expiresInSec: DISPUTE_EVIDENCE_PRESIGN_TTL,
    };
  },

  async disputeWithdrawal(
    hostUserId: string,
    withdrawalId: string,
    input: DisputeWithdrawalInput,
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

    const evidenceUrl = input.evidenceS3Key
      ? storageService.getPublicUrl(input.evidenceS3Key)
      : undefined;

    const ticket = await supportService.createTicket(hostUserId, {
      type: "REPORT_COMPLAINTS",
      subType: "WITHDRAWAL_DISPUTE",
      description: `Withdrawal dispute for ID: ${withdrawalId}. ${input.description}`,
      imageUrl: evidenceUrl,
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
        evidenceS3Key: input.evidenceS3Key,
      },
    });

    return { ticketId: ticket.publicId };
  },

  /** @deprecated use disputeWithdrawal */
  async raiseDispute(
    hostUserId: string,
    withdrawalId: string,
    description?: string,
  ) {
    return withdrawalService.disputeWithdrawal(hostUserId, withdrawalId, {
      description: description ?? "Withdrawal dispute",
    });
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
    // v2 allows cancelling open (escrowed) withdrawals in addition to reversing
    // settled (PAID/DISPUTED) ones.
    const REVERSIBLE: WithdrawalStatus[] = [
      "PAID",
      "DISPUTED",
      "PENDING",
      "PENDING_PLATFORM",
    ];
    if (!REVERSIBLE.includes(w.status)) {
      throw new AppError(400, "Withdrawal cannot be reversed", "INVALID_STATE");
    }

    const isV2 = w.withdrawalVersion === 2;
    // A real ledger debit reduced totalPoints when: v1 (debited at create) OR a
    // v2 escrow was settled (status reached PAID/DISPUTED). Only then must a
    // WITHDRAWAL_REFUND credit restore the balance.
    const wasSettled = w.status === "PAID" || w.status === "DISPUTED";
    const realDebitHappened = !isV2 || wasSettled;

    const completed =
      await payrollAssignmentRepository.findCompletedForWithdrawal(withdrawalId);
    const agencyUserId = completed?.agencyUserId ?? null;
    const hostPayoutPoints = w.amountPoints - (w.platformFeePoints ?? 0n);
    const agentReward = w.agentRewardPoints ?? 0n;

    // Open (still-pending) assignment must be cancelled so an agent can't
    // complete a reversed withdrawal.
    const openAssignment = await prismaRead.withdrawalPayrollAssignment.findFirst(
      { where: { withdrawalId, status: "PENDING" } },
    );

    await prisma.$transaction(
      async (tx) => {
        if (realDebitHappened) {
          // Restore the points that were really debited from the ledger sum.
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
        }

        if (isV2 && !wasSettled) {
          // Soft escrow still locked — release the unconfirmed counter only.
          // No WITHDRAWAL_REFUND: the ledger sum was never reduced.
          await tx.wallet.update({
            where: {
              userId_currencyType: {
                userId: w.userId,
                currencyType: WalletCurrencyType.POINT,
              },
            },
            data: { unconfirmedPoints: { decrement: w.amountPoints } },
          });
        }

        // Claw back agent host-payout credit (v2 completion only).
        if (agencyUserId && completed && hostPayoutPoints > 0n) {
          const payoutKey = `payroll-host-payout:${completed.id}`;
          const existingPayout =
            await pointLedgerRepository.findByIdempotencyKey(tx, payoutKey);
          if (existingPayout) {
            await pointWalletService.debit(
              agencyUserId,
              hostPayoutPoints,
              PointTxType.ADJUSTMENT,
              tx,
              {
                idempotencyKey: `payroll-host-payout-reversal:${completed.id}`,
                description: `Payroll host payout reversal for withdrawal ${withdrawalId}`,
                availabilityCheck: false,
              },
            );
          }
        }

        // Claw back agent processing reward (existing).
        if (agencyUserId && completed && agentReward > 0n) {
          const rewardKey = `payroll-reward:${completed.id}`;
          const existing = await pointLedgerRepository.findByIdempotencyKey(
            tx,
            rewardKey,
          );
          if (existing) {
            await pointWalletService.debit(
              agencyUserId,
              agentReward,
              PointTxType.ADJUSTMENT,
              tx,
              {
                idempotencyKey: `payroll-reward-reversal:${completed.id}`,
                description: `Payroll reward reversal for withdrawal ${withdrawalId}`,
                availabilityCheck: false,
              },
            );
          }
        }

        if (openAssignment) {
          await payrollAssignmentRepository.updateStatus(
            {
              id: openAssignment.id,
              status: "EXPIRED",
              rejectionReason: `Withdrawal reversed: ${reason}`,
            },
            tx,
          );
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

    if (openAssignment) {
      await removePayrollSla(openAssignment.id);
      await bustPayrollSummaryCache(openAssignment.agencyUserId);
    }

    await walletService.adjustPointBalanceCache(w.userId, 0n);
    await walletService.bustUnconfirmedCache(w.userId);
    if (agencyUserId) {
      await walletService.adjustPointBalanceCache(agencyUserId, 0n);
      await bustPayrollSummaryCache(agencyUserId);
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
    return withdrawalService.getWithdrawalDetail(id, userId);
  },

  async getWithdrawalDetail(withdrawalId: string, userId: string) {
    const row = await withdrawalRepository.findWithdrawalDetailForHost(
      withdrawalId,
      userId,
    );
    if (!row) throw new AppError(404, "Withdrawal not found", "NOT_FOUND");

    const config = await withdrawalService.getPayrollConfig();

    const timeTakenSeconds =
      row.status === "PAID" && row.processedAt
        ? Math.round((row.processedAt.getTime() - row.requestedAt.getTime()) / 1000)
        : null;

    const localCurrencyAmount =
      row.hostPayoutUsd !== null
        ? Number(row.hostPayoutUsd) * Number(config.inrPerUsd)
        : null;

    const maskedMethod = row.paymentMethod
      ? mapPaymentMethodMaskedForHost(row.paymentMethod)
      : null;

    return {
      id: row.id,
      status: row.status,
      grossPoints: row.amountPoints.toString(),
      grossUsd: (Number(row.amountPoints) / 10_000).toFixed(2),
      hostPayoutPoints: (
        Number(row.amountPoints) - Number(row.platformFeePoints ?? 0)
      ).toString(),
      hostPayoutUsd: row.hostPayoutUsd?.toString() ?? null,
      platformFeePoints: row.platformFeePoints?.toString() ?? null,
      agentRewardPoints: row.agentRewardPoints?.toString() ?? null,
      notes: row.notes ?? null,
      timeTakenSeconds,
      timeTakenFormatted:
        timeTakenSeconds != null ? formatDuration(timeTakenSeconds) : null,
      localCurrencyAmount: localCurrencyAmount?.toFixed(2) ?? null,
      localCurrencyCode: "INR",
      paymentMethod: maskedMethod,
      requestedAt: row.requestedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      disputeTicketId: row.disputeTicketId ?? null,
      assignmentCount: row.assignmentCount,
      payoutRef: row.payoutRef ?? null,
    };
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

  async getAgentPayrollInbox(
    agencyUserId: string,
    status: "PENDING" | "COMPLETED",
    cursor: string | undefined,
    limit: number,
  ) {
    const rows = await payrollAssignmentRepository.findInboxByStatus(
      agencyUserId,
      status,
      cursor,
      limit,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;
    const config = await withdrawalService.getPayrollConfig();

    const tabCounts = await payrollAssignmentRepository.countInboxByStatus(
      agencyUserId,
    );

    return {
      items: page.map((a) => {
        const hostPayoutUsd = Number(a.withdrawal.hostPayoutUsd ?? 0);
        return {
          id: a.id,
          status: a.status,
          expiresAt: a.expiresAt.toISOString(),
          slaRemainingSeconds: Math.max(
            0,
            Math.round((a.expiresAt.getTime() - Date.now()) / 1000),
          ),
          grossPoints: a.withdrawal.amountPoints.toString(),
          hostPayoutUsd: a.withdrawal.hostPayoutUsd?.toString() ?? null,
          localCurrencyAmount: (hostPayoutUsd * Number(config.inrPerUsd)).toFixed(
            2,
          ),
          localCurrencyCode: "INR",
          agentRewardPoints: a.withdrawal.agentRewardPoints?.toString() ?? "0",
          paymentMethod: mapPaymentMethodForAgent(
            a.withdrawal.paymentMethod,
            a.status,
            a.expiresAt,
          ),
        };
      }),
      nextCursor: nextCursor ?? null,
      total: status === "PENDING" ? tabCounts.pending : tabCounts.completed,
    };
  },

  async getPayrollInbox(
    agencyUserId: string,
    opts: { status?: string; limit: number; cursor?: string },
  ) {
    const status =
      opts.status === "COMPLETED" ? "COMPLETED" : ("PENDING" as const);
    return withdrawalService.getAgentPayrollInbox(
      agencyUserId,
      status,
      opts.cursor,
      opts.limit,
    );
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
