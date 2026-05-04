import { SupportTicketType } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";
import { RedisKeys } from "../config/redis";
import { cacheRedisService } from "./cacheRedis.service";
import { AppError } from "../middlewares/errorHandler";
import { agencyRepository } from "../repositories/agency.repository";
import { agencyHostRepository } from "../repositories/agencyHost.repository";
import { agencyLeaveApplicationRepository } from "../repositories/agencyLeaveApplication.repository";
import { supportRepository } from "../repositories/support.repository";
import { rootLogger } from "../utils/rootLogger";
import { displayNameFromUser } from "../utils/profileDisplay";
import { agencyCommissionService } from "./agencyCommission.service";

const log = rootLogger.child({ module: "agency.service" });

const TX_TIMEOUT_MS = 20_000;

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
   * Promote applicant to agent after CS review; closes ticket.
   * Idempotent if agency row already exists.
   */
  async createAgencyFromTicket(params: {
    adminUserId: string;
    applicantUserId: string;
    ticketId: bigint;
  }) {
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
        "createAgencyFromTicket: agency already exists, no-op",
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
        await tx.supportTicket.update({
          where: { id: params.ticketId },
          data: {
            status: "CLOSED",
            closedAt: now,
            closedByUserId: params.adminUserId,
            updatedAt: now,
          },
        });
        return ag;
      },
      { isolationLevel: "Serializable", timeout: TX_TIMEOUT_MS },
    );

    await agencyService.bustCachesForAgency(
      agency.userId,
      agency.defaultPublicId,
    );
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
    const [owned, hostRow] = await Promise.all([
      agencyRepository.getAgencyByUserId(userId),
      agencyHostRepository.getHostWithAgency(userId),
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
      hostMembership: hostRow,
      pendingJoinInbox: pendingJoin,
      pendingLeaveInbox: pendingLeave,
    };
  },

  /** Compact agency slice for `GET /users/me`. */
  async buildMeAgencyBlock(userId: string) {
    const [owned, hostRow, pendingLeave] = await Promise.all([
      agencyRepository.getAgencyByUserId(userId),
      agencyHostRepository.getHostWithAgency(userId),
      agencyLeaveApplicationRepository.getPendingForHost(userId),
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
            totalHostsCount: owned.totalHostsCount,
            currentLevel: owned.currentLevel,
            payrollEnabled: owned.payrollEnabled,
            paused: owned.pausedAt != null,
            ...commissionExtras,
          }
        : undefined,
      asHost: hostRow
        ? {
            agencyPublicId: hostRow.agency.defaultPublicId.toString(),
            agencyDisplayName: hostRow.agency.displayName,
            joinedAt: hostRow.joinedAt.toISOString(),
            pendingLeaveApplication: pendingLeave
              ? {
                  id: pendingLeave.id,
                  autoApproveAt: pendingLeave.autoApproveAt.toISOString(),
                }
              : undefined,
          }
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
};

async function meServiceInvalidateSafe(userId: string) {
  try {
    const { meService } = await import("./me.service");
    await meService.invalidateUserCaches(userId);
  } catch {
    /* ignore */
  }
}
