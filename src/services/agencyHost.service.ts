import {
  AgencyHostHistoryReason,
  PointTxType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../config/database";
import { AppError } from "../middlewares/errorHandler";
import { agencyRepository } from "../repositories/agency.repository";
import { agencyApplicationRepository } from "../repositories/agencyApplication.repository";
import { agencyHostRepository } from "../repositories/agencyHost.repository";
import { agencyLeaveApplicationRepository } from "../repositories/agencyLeaveApplication.repository";
import {
  enqueueLeaveAutoApprove,
  removeLeaveAutoApproveJob,
} from "../queues/agency.queue";
import { agencyService } from "./agency.service";
import { pointWalletService } from "./point-wallet.service";
import { walletService } from "./wallet.service";

const TX_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 30 * DAY_MS;
const REMOVAL_TENURE_MS = 7 * DAY_MS;
const REMOVAL_INACTIVE_MS = 30 * DAY_MS;
const IMMEDIATE_LEAVE_MS = 24 * DAY_MS;
const LATE_APPROVE_MS = 14 * DAY_MS;
const AUTO_APPROVE_MS = 7 * DAY_MS;

function nextAllowedFrom(ts: Date): Date {
  return new Date(ts.getTime() + COOLDOWN_MS);
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
  });
  if (!row || row.agencyUserId !== agencyUserId) {
    return;
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
  );

  await agencyHostRepository.removeHost(hostUserId, tx);
  await tx.user.update({
    where: { id: hostUserId },
    data: { currentAgencyId: null },
  });
  await agencyRepository.incrementHostCount(agencyUserId, -1, tx);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

export const agencyHostService = {
  async applyToAgency(
    hostUserId: string,
    agencyPublicId: string,
    message?: string | null,
  ) {
    let agencyPid: bigint;
    try {
      agencyPid = BigInt(agencyPublicId.trim());
    } catch {
      throw new AppError(400, "Invalid agency id", "INVALID_AGENCY_ID");
    }

    const agency = await agencyRepository.getAgencyByPublicId(agencyPid);
    if (!agency) {
      throw new AppError(404, "Agency not found", "AGENCY_NOT_FOUND");
    }

    if (agency.userId === hostUserId) {
      throw new AppError(403, "Cannot apply to your own agency", "INVALID_APPLICANT");
    }

    await agencyService.enforcePauseGate(agency.userId);

    const hostUser = await prisma.user.findUnique({
      where: { id: hostUserId },
      select: {
        id: true,
        currentAgencyId: true,
        isAgent: true,
      },
    });
    if (!hostUser) {
      throw new AppError(404, "User not found", "USER_NOT_FOUND");
    }
    if (hostUser.isAgent) {
      throw new AppError(403, "Agents cannot apply as hosts", "INVALID_APPLICANT");
    }
    if (hostUser.currentAgencyId) {
      throw new AppError(409, "Already in an agency", "ALREADY_IN_AGENCY");
    }

    const pendingApp = await agencyApplicationRepository.getPendingForHost(hostUserId);
    if (pendingApp) {
      throw new AppError(409, "Application pending", "APPLICATION_PENDING");
    }

    const recentExit = await agencyHostRepository.getRecentExitForHost(hostUserId);
    if (recentExit && Date.now() - recentExit.exitedAt.getTime() < COOLDOWN_MS) {
      throw new AppError(429, "Agency application cooldown", "AGENCY_APPLICATION_COOLDOWN", {
        nextAllowedAt: nextAllowedFrom(recentExit.exitedAt).toISOString(),
      });
    }

    const recentReject = await agencyHostRepository.findLatestRejectedApplication(hostUserId);
    if (
      recentReject?.resolvedAt &&
      Date.now() - recentReject.resolvedAt.getTime() < COOLDOWN_MS
    ) {
      throw new AppError(429, "Agency application cooldown", "AGENCY_APPLICATION_COOLDOWN", {
        nextAllowedAt: nextAllowedFrom(recentReject.resolvedAt).toISOString(),
      });
    }

    try {
      await prisma.$transaction(
        async (tx) => {
          await agencyApplicationRepository.createApplication(
            {
              agencyUserId: agency.userId,
              hostUserId,
              message: message ?? undefined,
            },
            tx,
          );
        },
        { isolationLevel: "Serializable", timeout: TX_MS },
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new AppError(409, "Application pending", "APPLICATION_PENDING");
      }
      throw e;
    }

    await agencyService.onAgencyMutation(agency.userId);
    return { ok: true as const };
  },

  async cancelApplication(hostUserId: string, applicationId: string) {
    const app = await agencyApplicationRepository.getApplicationById(applicationId);
    if (!app || app.hostUserId !== hostUserId) {
      throw new AppError(404, "Application not found", "NOT_FOUND");
    }
    if (app.status !== "PENDING") {
      throw new AppError(409, "Cannot cancel", "INVALID_STATE");
    }
    await prisma.$transaction(
      async (tx) => {
        await agencyApplicationRepository.deletePending(applicationId, hostUserId, tx);
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );
    await agencyService.onAgencyMutation(app.agencyUserId);
    return { ok: true as const };
  },

  async acceptApplication(agentUserId: string, applicationId: string) {
    await prisma.$transaction(
      async (tx) => {
        const app = await tx.agencyHostApplication.findUnique({
          where: { id: applicationId },
        });
        if (!app || app.agencyUserId !== agentUserId) {
          throw new AppError(404, "Application not found", "NOT_FOUND");
        }
        if (app.status !== "PENDING") {
          throw new AppError(409, "Invalid application state", "INVALID_STATE");
        }

        const host = await tx.user.findUnique({
          where: { id: app.hostUserId },
          select: {
            id: true,
            currentAgencyId: true,
            isAgent: true,
          },
        });
        if (!host) {
          throw new AppError(404, "Host not found", "USER_NOT_FOUND");
        }
        if (host.currentAgencyId) {
          throw new AppError(409, "Host joined another agency", "CONFLICT");
        }

        await agencyApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: "ACCEPTED",
            resolvedByUserId: agentUserId,
          },
          tx,
        );

        await agencyHostRepository.insertHost(
          { agencyUserId: agentUserId, hostUserId: app.hostUserId },
          tx,
        );
        await tx.user.update({
          where: { id: app.hostUserId },
          data: { currentAgencyId: agentUserId },
        });
        await agencyRepository.incrementHostCount(agentUserId, 1, tx);
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );

    const app = await agencyApplicationRepository.getApplicationById(applicationId);
    if (app) await agencyService.onAgencyMutation(app.agencyUserId);
    return { ok: true as const };
  },

  async rejectApplication(
    agentUserId: string,
    applicationId: string,
    _reason?: string | null,
  ) {
    await prisma.$transaction(
      async (tx) => {
        const app = await tx.agencyHostApplication.findUnique({
          where: { id: applicationId },
        });
        if (!app || app.agencyUserId !== agentUserId) {
          throw new AppError(404, "Application not found", "NOT_FOUND");
        }
        if (app.status !== "PENDING") {
          throw new AppError(409, "Invalid application state", "INVALID_STATE");
        }
        await agencyApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: "REJECTED",
            resolvedByUserId: agentUserId,
          },
          tx,
        );
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );

    const app = await agencyApplicationRepository.getApplicationById(applicationId);
    if (app) await agencyService.onAgencyMutation(app.agencyUserId);
    return { ok: true as const };
  },

  async applyToLeave(hostUserId: string, reason?: string | null) {
    const membership = await agencyHostRepository.getHost(hostUserId);
    if (!membership) {
      throw new AppError(404, "Not a host in any agency", "NOT_IN_AGENCY");
    }

    await agencyService.enforcePauseGate(membership.agencyUserId);

    const pending = await agencyLeaveApplicationRepository.getPendingForHost(hostUserId);
    if (pending) {
      throw new AppError(409, "Leave application pending", "APPLICATION_PENDING");
    }

    const lastResolved =
      await agencyHostRepository.findLatestResolvedLeaveApplication(hostUserId);
    if (
      lastResolved?.resolvedAt &&
      Date.now() - lastResolved.resolvedAt.getTime() < COOLDOWN_MS
    ) {
      throw new AppError(429, "Leave cooldown", "LEAVE_COOLDOWN", {
        nextAllowedAt: nextAllowedFrom(lastResolved.resolvedAt).toISOString(),
      });
    }

    const joinedMs = Date.now() - membership.joinedAt.getTime();
    if (joinedMs < IMMEDIATE_LEAVE_MS) {
      await prisma.$transaction(
        async (tx) => {
          await finalizeAgencyHostExit(
            membership.agencyUserId,
            hostUserId,
            "LEAVE_AUTO_APPROVED",
            tx,
            { immediateWithin24h: true },
          );
        },
        { isolationLevel: "Serializable", timeout: TX_MS },
      );
      await agencyService.onAgencyMutation(membership.agencyUserId);
      return { ok: true as const, immediate: true as const };
    }

    const autoAt = new Date(Date.now() + AUTO_APPROVE_MS);
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
        );
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );

    await enqueueLeaveAutoApprove(created.id, autoAt);
    await agencyService.onAgencyMutation(membership.agencyUserId);
    return {
      ok: true as const,
      immediate: false as const,
      applicationId: created.id,
      autoApproveAt: autoAt.toISOString(),
    };
  },

  async cancelLeaveApplication(hostUserId: string, applicationId: string) {
    const row = await agencyLeaveApplicationRepository.getById(applicationId);
    if (!row || row.hostUserId !== hostUserId) {
      throw new AppError(404, "Leave application not found", "NOT_FOUND");
    }
    if (row.status !== "PENDING") {
      throw new AppError(409, "Cannot cancel", "INVALID_STATE");
    }
    await removeLeaveAutoApproveJob(applicationId);
    await prisma.$transaction(
      async (tx) => {
        await agencyLeaveApplicationRepository.deletePending(
          applicationId,
          hostUserId,
          tx,
        );
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );
    await agencyService.onAgencyMutation(row.agencyUserId);
    return { ok: true as const };
  },

  async acceptLeaveApplication(agentUserId: string, applicationId: string) {
    await removeLeaveAutoApproveJob(applicationId);
    await prisma.$transaction(
      async (tx) => {
        const row = await tx.agencyLeaveApplication.findUnique({
          where: { id: applicationId },
        });
        if (!row || row.agencyUserId !== agentUserId) {
          throw new AppError(404, "Leave application not found", "NOT_FOUND");
        }
        if (row.status !== "PENDING") {
          throw new AppError(409, "Invalid state", "INVALID_STATE");
        }
        await agencyLeaveApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: "APPROVED",
            resolvedByUserId: agentUserId,
          },
          tx,
        );
        await finalizeAgencyHostExit(
          row.agencyUserId,
          row.hostUserId,
          "LEAVE_APPROVED",
          tx,
        );
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );
    const row = await agencyLeaveApplicationRepository.getById(applicationId);
    if (row) await agencyService.onAgencyMutation(row.agencyUserId);
    return { ok: true as const };
  },

  async rejectLeaveApplication(
    agentUserId: string,
    applicationId: string,
    _reason?: string | null,
  ) {
    const lateUntil = new Date(Date.now() + LATE_APPROVE_MS);
    await prisma.$transaction(
      async (tx) => {
        const row = await tx.agencyLeaveApplication.findUnique({
          where: { id: applicationId },
        });
        if (!row || row.agencyUserId !== agentUserId) {
          throw new AppError(404, "Leave application not found", "NOT_FOUND");
        }
        if (row.status !== "PENDING") {
          throw new AppError(409, "Invalid state", "INVALID_STATE");
        }
        await tx.agencyLeaveApplication.update({
          where: { id: applicationId },
          data: {
            status: "REJECTED",
            resolvedAt: new Date(),
            resolvedByUserId: agentUserId,
            lateApproveUntil: lateUntil,
          },
        });
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );
    const row = await agencyLeaveApplicationRepository.getById(applicationId);
    if (row) await agencyService.onAgencyMutation(row.agencyUserId);
    return { ok: true as const, lateApproveUntil: lateUntil.toISOString() };
  },

  async lateAcceptLeaveApplication(agentUserId: string, applicationId: string) {
    await prisma.$transaction(
      async (tx) => {
        const row = await tx.agencyLeaveApplication.findUnique({
          where: { id: applicationId },
        });
        if (!row || row.agencyUserId !== agentUserId) {
          throw new AppError(404, "Leave application not found", "NOT_FOUND");
        }
        if (row.status !== "REJECTED") {
          throw new AppError(409, "Invalid state", "INVALID_STATE");
        }
        if (
          !row.lateApproveUntil ||
          Date.now() > row.lateApproveUntil.getTime()
        ) {
          throw new AppError(403, "Late accept window expired", "LATE_ACCEPT_EXPIRED");
        }
        await agencyLeaveApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: "LATE_APPROVED",
            resolvedByUserId: agentUserId,
          },
          tx,
        );
        await finalizeAgencyHostExit(
          row.agencyUserId,
          row.hostUserId,
          "LEAVE_LATE_APPROVED",
          tx,
        );
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );
    await removeLeaveAutoApproveJob(applicationId);
    const row = await agencyLeaveApplicationRepository.getById(applicationId);
    if (row) await agencyService.onAgencyMutation(row.agencyUserId);
    return { ok: true as const };
  },

  async removeHost(agentUserId: string, hostUserId: string) {
    const membership = await agencyHostRepository.getHost(hostUserId);
    if (!membership || membership.agencyUserId !== agentUserId) {
      throw new AppError(404, "Host not in your agency", "NOT_FOUND");
    }

    const hostUser = await prisma.user.findUnique({
      where: { id: hostUserId },
      select: { status: true, lastActiveAt: true },
    });
    if (!hostUser) {
      throw new AppError(404, "User not found", "USER_NOT_FOUND");
    }

    let reason: AgencyHostHistoryReason | null = null;
    if (hostUser.status === "suspended") {
      reason = "REMOVED_SUSPENDED";
    } else {
      const tenureOk =
        Date.now() - membership.joinedAt.getTime() >= REMOVAL_TENURE_MS;
      const lastActive = hostUser.lastActiveAt;
      const inactiveOk =
        lastActive == null ||
        Date.now() - lastActive.getTime() >= REMOVAL_INACTIVE_MS;
      if (tenureOk && inactiveOk) {
        reason = "REMOVED_INACTIVE";
      }
    }

    if (!reason) {
      throw new AppError(
        403,
        "Removal not permitted",
        "REMOVAL_NOT_PERMITTED",
        {
          reason: "Host must be suspended, or in agency >7d with lastActiveAt >30d ago",
        },
      );
    }

    await prisma.$transaction(
      async (tx) => {
        await finalizeAgencyHostExit(agentUserId, hostUserId, reason!, tx);
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );
    await agencyService.onAgencyMutation(agentUserId);
    return { ok: true as const };
  },

  async forceExitFromCS(params: {
    hostUserId: string;
    ticketId: bigint;
    deductPoints?: bigint;
    pauseAgency?: boolean;
    csUserId: string;
  }) {
    const membership = await agencyHostRepository.getHost(params.hostUserId);
    if (!membership) {
      throw new AppError(404, "Host not in an agency", "NOT_IN_AGENCY");
    }

    const agencyUserId = membership.agencyUserId;
    const idemBase = `agency-force-exit:${params.ticketId.toString()}`;

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
              description: "Agency force exit (CS)",
              refId: params.ticketId.toString(),
            },
          );
        }

        if (params.pauseAgency) {
          await agencyRepository.setPause(
            agencyUserId,
            { pausedAt: new Date(), pausedUntil: null },
            tx,
          );
        }

        await finalizeAgencyHostExit(
          agencyUserId,
          params.hostUserId,
          "CS_FORCE_EXIT",
          tx,
          { ticketId: params.ticketId.toString(), csUserId: params.csUserId },
        );
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );

    if (params.deductPoints != null && params.deductPoints > 0n) {
      await walletService.adjustPointBalanceCache(params.hostUserId, -params.deductPoints);
    }
    await agencyService.onAgencyMutation(agencyUserId);
    return { ok: true as const };
  },

  async processAutoApproveJob(applicationId: string) {
    await prisma.$transaction(
      async (tx) => {
        const row = await tx.agencyLeaveApplication.findUnique({
          where: { id: applicationId },
        });
        if (!row || row.status !== "PENDING") {
          return;
        }
        await agencyLeaveApplicationRepository.updateStatus(
          {
            id: applicationId,
            status: "AUTO_APPROVED",
            resolvedByUserId: null,
          },
          tx,
        );
        await finalizeAgencyHostExit(
          row.agencyUserId,
          row.hostUserId,
          "LEAVE_AUTO_APPROVED",
          tx,
        );
      },
      { isolationLevel: "Serializable", timeout: TX_MS },
    );
    const row = await agencyLeaveApplicationRepository.getById(applicationId);
    if (row) await agencyService.onAgencyMutation(row.agencyUserId);
  },

  async handleAgentAccountDeletion(agentUserId: string, tx: Prisma.TransactionClient) {
    const hostIds = await tx.agencyHost.findMany({
      where: { agencyUserId: agentUserId },
      select: { hostUserId: true },
    });
    for (const h of hostIds) {
      await finalizeAgencyHostExit(
        agentUserId,
        h.hostUserId,
        "AGENT_DELETED",
        tx,
      );
    }
    await tx.agency.deleteMany({ where: { userId: agentUserId } });
    await tx.user.update({
      where: { id: agentUserId },
      data: { isAgent: false },
    });
  },

  async handleHostAccountDeletion(hostUserId: string, tx: Prisma.TransactionClient) {
    const membership = await tx.agencyHost.findUnique({
      where: { hostUserId },
    });
    if (!membership) return;
    await finalizeAgencyHostExit(
      membership.agencyUserId,
      hostUserId,
      "HOST_DELETED",
      tx,
    );
  },
};
