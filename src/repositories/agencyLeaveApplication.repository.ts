import type {
  AgencyLeaveApplicationStatus,
  Prisma,
} from "@prisma/client";
import { prismaRead } from "../config/database";

export const agencyLeaveApplicationRepository = {
  async create(
    data: {
      agencyUserId: string;
      hostUserId: string;
      reason?: string | null;
      autoApproveAt: Date;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agencyLeaveApplication.create({
      data: {
        agencyUserId: data.agencyUserId,
        hostUserId: data.hostUserId,
        status: "PENDING",
        reason: data.reason ?? undefined,
        autoApproveAt: data.autoApproveAt,
      },
    });
  },

  async getById(id: string) {
    return prismaRead.agencyLeaveApplication.findUnique({
      where: { id },
    });
  },

  async getPendingForHost(hostUserId: string) {
    return prismaRead.agencyLeaveApplication.findFirst({
      where: { hostUserId, status: "PENDING" },
    });
  },

  async listInbox(
    agencyUserId: string,
    params: {
      status?: AgencyLeaveApplicationStatus;
      limit: number;
      cursor?: string | null;
    },
  ) {
    let cursor: { createdAt: Date; id: string } | null = null;
    if (params.cursor) {
      const parts = params.cursor.split("|");
      if (parts.length === 2 && parts[0] && parts[1]) {
        cursor = { createdAt: new Date(parts[0]), id: parts[1] };
      }
    }

    const where: Prisma.AgencyLeaveApplicationWhereInput = {
      agencyUserId,
      ...(params.status ? { status: params.status } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              {
                createdAt: cursor.createdAt,
                id: { lt: cursor.id },
              },
            ],
          }
        : {}),
    };

    return prismaRead.agencyLeaveApplication.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: params.limit + 1,
    });
  },

  async updateStatus(
    params: {
      id: string;
      status: AgencyLeaveApplicationStatus;
      resolvedByUserId?: string | null;
      resolvedAt?: Date | null;
      lateApproveUntil?: Date | null;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agencyLeaveApplication.update({
      where: { id: params.id },
      data: {
        status: params.status,
        resolvedAt: params.resolvedAt ?? new Date(),
        resolvedByUserId: params.resolvedByUserId ?? undefined,
        lateApproveUntil: params.lateApproveUntil,
      },
    });
  },

  /** Host withdraws a PENDING leave request (keeps row for audit). */
  async cancelPending(id: string, hostUserId: string, tx: Prisma.TransactionClient) {
    return tx.agencyLeaveApplication.updateMany({
      where: { id, hostUserId, status: "PENDING" },
      data: {
        status: "CANCELLED",
        resolvedAt: new Date(),
        resolvedByUserId: null,
      },
    });
  },

  /** Safety-net: pending rows whose auto-approve time has passed. */
  async getOverdueAutoApprovals(now: Date, limit: number) {
    return prismaRead.agencyLeaveApplication.findMany({
      where: {
        status: "PENDING",
        autoApproveAt: { lte: now },
      },
      take: limit,
      select: { id: true },
    });
  },
};
