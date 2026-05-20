import type { AgencyTransferChannel } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";

export type CoinsellerSettingsInput = {
  transferChannel?: AgencyTransferChannel;
  whatsappNumber?: string | null;
  autoReply?: string | null;
};

export type PriceImageInput = {
  priceImageS3Key: string;
  priceImageS3Bucket: string;
};

export const agencyCoinsellerRepository = {
  async upsertSettings(agencyUserId: string, data: CoinsellerSettingsInput) {
    return prisma.agencyCoinseller.upsert({
      where: { agencyUserId },
      create: { agencyUserId, ...data },
      update: data,
    });
  },

  async setPriceImage(agencyUserId: string, img: PriceImageInput) {
    return prisma.agencyCoinseller.upsert({
      where: { agencyUserId },
      create: { agencyUserId, ...img },
      update: img,
    });
  },

  async clearPriceImage(agencyUserId: string) {
    const row = await prismaRead.agencyCoinseller.findUnique({ where: { agencyUserId } });
    if (!row) return null;
    return prisma.agencyCoinseller.update({
      where: { agencyUserId },
      data: { priceImageS3Key: null, priceImageS3Bucket: null },
    });
  },

  async findByAgencyUserId(agencyUserId: string) {
    return prismaRead.agencyCoinseller.findUnique({ where: { agencyUserId } });
  },

  async findManyByAgencyUserIds(agencyUserIds: string[]) {
    if (agencyUserIds.length === 0) return [];
    return prismaRead.agencyCoinseller.findMany({
      where: { agencyUserId: { in: agencyUserIds } },
    });
  },
};
