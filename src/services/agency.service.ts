import { AgencyTransferChannel, Prisma, SupportTicketType, WalletCurrencyType } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";
import { redisClient, RedisKeys, PAYROLL_SUMMARY_TTL } from "../config/redis";
import { payrollAssignmentRepository } from "../repositories/payrollAssignment.repository";
import { withdrawalService } from "./withdrawal.service";
import {
  mapPaymentMethodFull,
  mapPaymentMethodMaskedForAgent,
} from "../utils/payment-method-mask";
import { cacheRedisService } from "./cacheRedis.service";
import { AppError } from "../middlewares/errorHandler";
import { agencyRepository } from "../repositories/agency.repository";
import { agencyHostRepository } from "../repositories/agencyHost.repository";
import { agencyLeaveApplicationRepository } from "../repositories/agencyLeaveApplication.repository";
import { agencyAgentApplicationRepository } from "../repositories/agencyAgentApplication.repository";
import { supportRepository } from "../repositories/support.repository";
import { rootLogger } from "../utils/rootLogger";
import { displayNameFromUser } from "../utils/profileDisplay";
import { agencyCommissionService } from "./agencyCommission.service";
import { agencyKycService } from "./agencyKyc.service";
import { agencyCoinsellerService } from "./agencyCoinseller.service";

const log = rootLogger.child({ module: "agency.service" });

const TX_TIMEOUT_MS = 20_000;

type HostWithAgencyRow = NonNullable<
  Awaited<ReturnType<typeof agencyHostRepository.getHostWithAgency>>
>;

export function mapHostAgencyMeBlock(
  hostRow: HostWithAgencyRow,
  pendingLeave: { id: string; autoApproveAt: Date } | null,
) {
  return {
    agencyPublicId: hostRow.agency.defaultPublicId.toString(),
    agencyDisplayName: hostRow.agency.displayName,
    avatarUrl: hostRow.agency.user?.avatarUrl ?? null,
    joinedAt: hostRow.joinedAt.toISOString(),
    pendingLeaveApplication: pendingLeave
      ? {
          id: pendingLeave.id,
          autoApproveAt: pendingLeave.autoApproveAt.toISOString(),
        }
      : undefined,
  };
}

export const agencyService = {
  async bustCachesForAgency(userId: string, defaultPublicId: bigint) {
    await cacheRedisService.del(
      RedisKeys.agencyMe(userId),
      RedisKeys.agencyByPublicId(defaultPublicId.toString()),
    );
  },

  async bustRankingCache() {
    const redis = (await import("../config/redis")).redisClient;
    const pattern = "agency:ranking:*";
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  },

  /**
   * Legacy: promote via support ticket + close ticket. Kept for rollback / scripts; HTTP uses
   * {@link agencyService.createAgencyFromApplication}.
   */
  async createAgencyFromTicket_deprecated(params: {
    adminUserId: string;
    applicantUserId: string;
    ticketId: bigint;
  }) {
    await agencyKycService.validateKycComplete(params.applicantUserId);
    const ticket = await supportRepository.findTicketById(params.ticketId);
    if (!ticket) {
      throw new AppError(404, "Ticket not found", "TICKET_NOT_FOUND");
    }
    if (ticket.userId !== params.applicantUserId) {
      throw new AppError(403, "Ticket does not belong to user", "TICKET_USER_MISMATCH");
    }
    if (ticket.type !== SupportTicketType.BUSINESS_COOPERATION) {
      throw new AppError(400, "Invalid ticket type for agency", "INVALID_TICKET_TYPE");
    }
    if (ticket.subType !== "AGENCY_APPLICATION") {
      throw new AppError(400, "Invalid ticket subtype for agency", "INVALID_TICKET_SUBTYPE");
    }

    const existing = await agencyRepository.getAgencyByUserId(params.applicantUserId);
    if (existing) {
      log.info(
        { userId: params.applicantUserId },
        "createAgencyFromTicket_deprecated: agency already exists, no-op",
      );
      return { agency: existing, created: false as const };
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
    });
    if (!userRow) {
      throw new AppError(404, "User not found", "USER_NOT_FOUND");
    }

    const displayName = displayNameFromUser(userRow as never);

    const now = new Date();
    const agency = await prisma.$transaction(
      async (tx) => {
        const ag = await agencyRepository.createAgency(
          {
            userId: userRow.id,
            defaultPublicId: userRow.defaultPublicId,
            displayName: displayName.slice(0, 255),
          },
          tx,
        );
        await tx.user.update({
          where: { id: userRow.id },
          data: { isAgent: true },
        });
        await tx.wallet.create({
          data: {
            userId: userRow.id,
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
        });
        await tx.supportTicket.update({
          where: { id: params.ticketId },
          data: {
            status: "CLOSED",
            closedAt: now,
            closedByUserId: params.adminUserId,
            updatedAt: now,
          },
        });
        await seedCoinsellerWhatsappFromKyc(tx, userRow.id);
        return ag;
      },
      { isolationLevel: "Serializable", timeout: TX_TIMEOUT_MS },
    );

    await agencyService.bustCachesForAgency(
      agency.userId,
      agency.defaultPublicId,
    );
    await agencyCoinsellerService._bustCache(agency.userId);
    await agencyService.bustRankingCache();
    await meServiceInvalidateSafe(params.applicantUserId);

    return { agency, created: true as const };
  },

  /**
   * Promote applicant to agent from `AgencyAgentApplication` after KYC complete.
   * Idempotent if agency row already exists.
   */
  async createAgencyFromApplication(params: {
    adminUserId: string;
    applicantUserId: string;
    applicationId: string;
  }) {
    const existingAgency = await agencyRepository.getAgencyByUserId(params.applicantUserId);
    if (existingAgency) {
      log.info(
        { userId: params.applicantUserId },
        "createAgencyFromApplication: agency already exists, no-op",
      );
      return { agency: existingAgency, created: false as const };
    }

    const application = await agencyAgentApplicationRepository.findById(params.applicationId);
    if (!application) {
      throw new AppError(404, "Application not found", "APPLICATION_NOT_FOUND");
    }
    if (application.userId !== params.applicantUserId) {
      throw new AppError(403, "Application does not belong to this user", "APPLICATION_USER_MISMATCH");
    }
    if (application.status === "APPROVED") {
      throw new AppError(400, "Application already approved", "ALREADY_APPROVED");
    }
    if (application.status === "REJECTED") {
      throw new AppError(400, "Application was rejected", "APPLICATION_REJECTED");
    }

    await agencyKycService.validateKycComplete(params.applicantUserId);

    const userRow = await prisma.user.findUnique({
      where: { id: params.applicantUserId },
      select: {
        id: true,
        defaultPublicId: true,
        username: true,
        firstName: true,
        lastName: true,
      },
    });
    if (!userRow) {
      throw new AppError(404, "User not found", "USER_NOT_FOUND");
    }

    const displayName = displayNameFromUser(userRow as never);

    const now = new Date();
    const agency = await prisma.$transaction(
      async (tx) => {
        const ag = await agencyRepository.createAgency(
          {
            userId: userRow.id,
            defaultPublicId: userRow.defaultPublicId,
            displayName: displayName.slice(0, 255),
          },
          tx,
        );
        await tx.user.update({
          where: { id: userRow.id },
          data: { isAgent: true },
        });
        await tx.wallet.create({
          data: {
            userId: userRow.id,
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
        });
        await tx.agencyAgentApplication.update({
          where: { id: params.applicationId },
          data: {
            status: "APPROVED",
            reviewedBy: params.adminUserId,
            reviewedAt: now,
          },
        });
        await seedCoinsellerWhatsappFromKyc(tx, userRow.id);
        return ag;
      },
      { isolationLevel: "Serializable", timeout: TX_TIMEOUT_MS },
    );

    await agencyService.bustCachesForAgency(
      agency.userId,
      agency.defaultPublicId,
    );
    await agencyCoinsellerService._bustCache(agency.userId);
    await agencyService.bustRankingCache();
    await meServiceInvalidateSafe(params.applicantUserId);

    return { agency, created: true as const };
  },

  /** Agency row when `userId` is the owner (agent). */
  async getAgencyByOwnerId(userId: string) {
    return agencyRepository.getAgencyByUserId(userId);
  },

  async getAgencyByPublicIdString(publicIdString: string) {
    let pid: bigint;
    try {
      pid = BigInt(publicIdString.trim());
    } catch {
      throw new AppError(400, "Invalid agency public id", "INVALID_AGENCY_ID");
    }
    return agencyRepository.getAgencyByPublicId(pid);
  },

  async getMyAgency(userId: string) {
    const [owned, hostRow, selfProfile] = await Promise.all([
      agencyRepository.getAgencyByUserId(userId),
      agencyHostRepository.getHostWithAgency(userId),
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { avatarUrl: true },
      }),
    ]);

    let pendingJoin = 0;
    let pendingLeave = 0;
    if (owned) {
      ;[pendingJoin, pendingLeave] = await Promise.all([
        prismaRead.agencyHostApplication.count({
          where: { agencyUserId: userId, status: "PENDING" },
        }),
        prismaRead.agencyLeaveApplication.count({
          where: { agencyUserId: userId, status: "PENDING" },
        }),
      ]);
    }

    return {
      owned,
      ownedAvatarUrl: owned ? (selfProfile?.avatarUrl ?? null) : null,
      hostMembership: hostRow,
      pendingJoinInbox: pendingJoin,
      pendingLeaveInbox: pendingLeave,
    };
  },

  /** Compact agency slice for `GET /users/me`. */
  async buildMeAgencyBlock(userId: string) {
    const [owned, hostRow, pendingLeave, selfProfile] = await Promise.all([
      agencyRepository.getAgencyByUserId(userId),
      agencyHostRepository.getHostWithAgency(userId),
      agencyLeaveApplicationRepository.getPendingForHost(userId),
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { avatarUrl: true },
      }),
    ]);

    let role: "AGENT" | "HOST" | "NONE" = "NONE";
    if (owned) role = "AGENT";
    else if (hostRow) role = "HOST";

    const commissionExtras = owned
      ? await agencyCommissionService.buildMeAgentCommissionSummary(userId)
      : undefined;

    return {
      role,
      asAgent: owned
        ? {
            agencyPublicId: owned.defaultPublicId.toString(),
            displayName: owned.displayName,
            avatarUrl: selfProfile?.avatarUrl ?? null,
            totalHostsCount: owned.totalHostsCount,
            currentLevel: owned.currentLevel,
            payrollEnabled: owned.payrollEnabled,
            paused: owned.pausedAt != null,
            ...commissionExtras,
          }
        : undefined,
      asHost: hostRow
        ? mapHostAgencyMeBlock(hostRow, pendingLeave)
        : undefined,
    };
  },

  async pauseAgency(
    userId: string,
    _source: "CS" | "ADMIN",
    tx?: import("@prisma/client").Prisma.TransactionClient,
  ) {
    const now = new Date();
    const run = async (inner: import("@prisma/client").Prisma.TransactionClient) => {
      return agencyRepository.setPause(
        userId,
        { pausedAt: now, pausedUntil: null },
        inner,
      );
    };
    if (tx) return run(tx);
    const updated = await prisma.$transaction(
      async (inner) => run(inner),
      { isolationLevel: "Serializable", timeout: TX_TIMEOUT_MS },
    );
    await cacheRedisService.del(RedisKeys.ctBalance(userId));
    await agencyService.onAgencyMutation(userId);
    return updated;
  },

  async unpauseAgency(userId: string) {
    const updated = await prisma.$transaction(
      async (tx) =>
        agencyRepository.setPause(
          userId,
          { pausedAt: null, pausedUntil: null },
          tx,
        ),
      { isolationLevel: "Serializable", timeout: TX_TIMEOUT_MS },
    );
    await agencyService.onAgencyMutation(userId);
    return updated;
  },

  async setPayrollEnabled(userId: string, enabled: boolean) {
    const updated = await agencyRepository.setPayrollEnabled(userId, enabled);
    await agencyService.onAgencyMutation(userId);
    return updated;
  },

  async onAgencyMutation(userId: string) {
    const ag = await agencyRepository.getAgencyByUserId(userId);
    if (ag) {
      await agencyService.bustCachesForAgency(userId, ag.defaultPublicId);
    }
    await agencyService.bustRankingCache();
  },

  async enforcePauseGate(agencyUserId: string) {
    const ag = await agencyRepository.getAgencyByUserId(agencyUserId);
    if (ag?.pausedAt != null) {
      throw new AppError(403, "Agency is paused", "AGENCY_PAUSED");
    }
  },

  async getPayrollSummary(agencyUserId: string) {
    const cacheKey = RedisKeys.payrollSummary(agencyUserId);
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached) as Record<string, unknown>;

    const [agency, rewardSummary, tabCounts] = await Promise.all([
      prismaRead.agency.findUnique({
        where: { userId: agencyUserId },
        select: { payrollEnabled: true, pausedAt: true },
      }),
      prismaRead.pointLedgerEntry.aggregate({
        where: {
          wallet: { userId: agencyUserId, currencyType: "POINT" },
          txType: "PAYROLL_PROCESSING_REWARD",
          direction: "CREDIT",
        },
        _sum: { amount: true },
      }),
      payrollAssignmentRepository.countInboxByStatus(agencyUserId),
    ]);

    if (!agency) throw new AppError(404, "Agency not found", "NOT_FOUND");

    const result = {
      takeOrderEnabled: agency.payrollEnabled && !agency.pausedAt,
      payrollEnabled: agency.payrollEnabled,
      isPaused: !!agency.pausedAt,
      totalRewardPoints: (rewardSummary._sum.amount ?? BigInt(0)).toString(),
      tabCounts,
    };

    await redisClient.setex(cacheKey, PAYROLL_SUMMARY_TTL, JSON.stringify(result));
    return result;
  },

  async getAssignmentDetail(assignmentId: string, agencyUserId: string) {
    const assignment = await payrollAssignmentRepository.getByIdForAgent(
      assignmentId,
      agencyUserId,
    );
    if (!assignment) throw new AppError(404, "Assignment not found", "NOT_FOUND");

    const config = await withdrawalService.getPayrollConfig();

    const now = new Date();
    const isPendingAndActive =
      assignment.status === "PENDING" && assignment.expiresAt > now;
    const isWaiting = assignment.status === "WAITING";
    const isDisputed = assignment.withdrawal.status === "DISPUTED";

    const hostPayoutUsd = Number(assignment.withdrawal.hostPayoutUsd ?? 0);

    return {
      id: assignment.id,
      status: assignment.status,
      expiresAt: assignment.expiresAt.toISOString(),
      slaRemainingSeconds: Math.max(
        0,
        Math.round((assignment.expiresAt.getTime() - now.getTime()) / 1000),
      ),
      waitingExpiresAt: assignment.waitingExpiresAt?.toISOString() ?? null,
      waitingSecondsRemaining:
        isWaiting && assignment.waitingExpiresAt && !isDisputed
          ? Math.max(
              0,
              Math.round(
                (assignment.waitingExpiresAt.getTime() - now.getTime()) / 1000,
              ),
            )
          : null,
      isDisputed: isWaiting && isDisputed,
      assignmentNumber: assignment.assignmentNumber,
      proofS3Key: assignment.proofS3Key ?? null,
      completedAt: assignment.completedAt?.toISOString() ?? null,
      grossPoints: assignment.withdrawal.amountPoints.toString(),
      hostPayoutPoints: (
        Number(assignment.withdrawal.amountPoints) -
        Number(assignment.withdrawal.platformFeePoints ?? 0)
      ).toString(),
      agentRewardPoints: assignment.withdrawal.agentRewardPoints?.toString() ?? "0",
      hostPayoutUsd: assignment.withdrawal.hostPayoutUsd?.toString() ?? null,
      localCurrencyAmount: (hostPayoutUsd * Number(config.inrPerUsd)).toFixed(2),
      localCurrencyCode: "INR",
      paymentMethod: assignment.withdrawal.paymentMethod
        ? isPendingAndActive
          ? mapPaymentMethodFull(assignment.withdrawal.paymentMethod)
          : mapPaymentMethodMaskedForAgent(assignment.withdrawal.paymentMethod)
        : null,
      requestedAt: assignment.withdrawal.requestedAt.toISOString(),
    };
  },
};

async function seedCoinsellerWhatsappFromKyc(tx: Prisma.TransactionClient, userId: string) {
  const kyc = await tx.agencyApplicationKyc.findUnique({
    where: { userId },
    select: { contactPhone: true },
  });
  if (!kyc?.contactPhone) return;
  await tx.agencyCoinseller.upsert({
    where: { agencyUserId: userId },
    create: {
      agencyUserId: userId,
      whatsappNumber: kyc.contactPhone,
      transferChannel: AgencyTransferChannel.EPAY,
    },
    update: { whatsappNumber: kyc.contactPhone },
  });
}

async function meServiceInvalidateSafe(userId: string) {
  try {
    const { meService } = await import("./me.service");
    await meService.invalidateUserCaches(userId);
  } catch {
    /* ignore */
  }
}
