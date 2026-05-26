import { prisma, prismaRead } from "../config/database";

export const liveSessionRepository = {
  async createSession(data: {
    hostUserId: string;
    agencyUserId: string;
    roomId: string;
    startedAt: Date;
  }) {
    return prisma.hostLiveSession.create({ data: { ...data, status: "ACTIVE" } });
  },

  async endSession(
    hostUserId: string,
    roomId: string,
    endedAt: Date,
    durationSeconds: bigint,
    status: "ENDED" | "INTERRUPTED" = "ENDED",
  ) {
    const session = await prisma.hostLiveSession.findFirst({
      where: { hostUserId, roomId, status: "ACTIVE" },
    });
    if (!session) return null;

    return prisma.hostLiveSession.update({
      where: { id: session.id },
      data: { endedAt, durationSeconds, status },
    });
  },

  async findStaleActiveSessions(cutoffDate: Date) {
    return prismaRead.hostLiveSession.findMany({
      where: { status: "ACTIVE", startedAt: { lt: cutoffDate } },
      select: {
        id: true,
        hostUserId: true,
        agencyUserId: true,
        startedAt: true,
        roomId: true,
      },
    });
  },

  async interruptSession(id: string, endedAt: Date, durationSeconds: bigint) {
    return prisma.hostLiveSession.update({
      where: { id },
      data: { endedAt, durationSeconds, status: "INTERRUPTED" },
    });
  },
};
