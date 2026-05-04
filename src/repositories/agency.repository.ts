import type { Prisma } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";

export const agencyRepository = {
  async createAgency(
    data: { userId: string; defaultPublicId: bigint; displayName: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agency.create({
      data: {
        userId: data.userId,
        defaultPublicId: data.defaultPublicId,
        displayName: data.displayName,
      },
    });
  },

  async getAgencyByUserId(userId: string) {
    return prismaRead.agency.findUnique({
      where: { userId },
    });
  },

  async getAgencyByPublicId(publicId: bigint) {
    return prismaRead.agency.findUnique({
      where: { defaultPublicId: publicId },
    });
  },

  async setPause(
    userId: string,
    data: { pausedAt: Date | null; pausedUntil: Date | null },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agency.update({
      where: { userId },
      data: {
        pausedAt: data.pausedAt,
        pausedUntil: data.pausedUntil,
      },
    });
  },

  async setPayrollEnabled(
    userId: string,
    payrollEnabled: boolean,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    return client.agency.update({
      where: { userId },
      data: { payrollEnabled },
    });
  },

  async incrementHostCount(
    userId: string,
    delta: number,
    tx: Prisma.TransactionClient,
  ) {
    return tx.agency.update({
      where: { userId },
      data: {
        totalHostsCount: { increment: delta },
      },
    });
  },

  async updateDisplayAndLevels(
    userId: string,
    data: {
      displayName?: string;
      currentLevel?: string;
      lifetimeHostEarningsPoints?: bigint;
      currentWindowTotalPoints?: bigint;
      lastLevelRecomputedAt?: Date | null;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    return client.agency.update({
      where: { userId },
      data,
    });
  },

  /**
   * Phase 1: sort by totalHostsCount desc, tie-break defaultPublicId desc.
   * Cursor: opaque offset string (see agencyRanking.service).
   */
  async listForRanking(params: { limit: number; skip: number }) {
    return prismaRead.agency.findMany({
      orderBy: [
        { totalHostsCount: "desc" },
        { defaultPublicId: "desc" },
      ],
      skip: params.skip,
      take: params.limit + 1,
      select: {
        userId: true,
        defaultPublicId: true,
        displayName: true,
        totalHostsCount: true,
        lifetimeHostEarningsPoints: true,
        currentLevel: true,
        pausedAt: true,
        pausedUntil: true,
      },
    });
  },
};
