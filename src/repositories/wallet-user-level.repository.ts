import { prisma, prismaRead } from "../config/database";
import { LevelType } from "@prisma/client";

export const walletUserLevelRepository = {
  async getOrCreate(userId: string, levelType: LevelType) {
    return prisma.walletUserLevel.upsert({
      where: { userId_levelType: { userId, levelType } },
      create: { userId, levelType, currentLevel: 1, cumulativeTotal: 0n },
      update: {},
    });
  },

  async getByUser(userId: string, levelType: LevelType) {
    return prismaRead.walletUserLevel.findUnique({
      where: { userId_levelType: { userId, levelType } },
    });
  },

  async getConfigs(levelType: LevelType) {
    return prismaRead.walletLevelConfig.findMany({
      where: { levelType, isActive: true },
      orderBy: { level: "asc" },
    });
  },

  async getAllConfigs() {
    return prismaRead.walletLevelConfig.findMany({
      where: { isActive: true },
      orderBy: [{ levelType: "asc" }, { level: "asc" }],
    });
  },
};
