import { prisma, prismaRead } from '../config/database'

export type HostRevenueShareRow = {
  id: number
  giftReceiveBp: number
  subscriptionBp: number
  guardianPurchaseBp: number
  videoCallHostShareBp: number
  luckyHostShareBp: number
  luckyTargetRtpBp: number
  updatedAt: Date
  updatedByAdminId: string | null
}

export const hostRevenueShareConfigRepository = {
  async getOrCreate(): Promise<HostRevenueShareRow> {
    const existing = await prismaRead.hostRevenueShareConfig.findUnique({ where: { id: 1 } })
    if (existing) return existing
    return prisma.hostRevenueShareConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        giftReceiveBp: 6000,
        subscriptionBp: 7500,
        guardianPurchaseBp: 7500,
        videoCallHostShareBp: 6000,
        luckyHostShareBp: 400,
        luckyTargetRtpBp: 9200,
      },
      update: {},
    })
  },

  async update(data: {
    giftReceiveBp?: number
    subscriptionBp?: number
    guardianPurchaseBp?: number
    videoCallHostShareBp?: number
    luckyHostShareBp?: number
    luckyTargetRtpBp?: number
    updatedByAdminId: string
  }): Promise<HostRevenueShareRow> {
    await this.getOrCreate()
    return prisma.hostRevenueShareConfig.update({
      where: { id: 1 },
      data: {
        ...(data.giftReceiveBp != null ? { giftReceiveBp: data.giftReceiveBp } : {}),
        ...(data.subscriptionBp != null ? { subscriptionBp: data.subscriptionBp } : {}),
        ...(data.guardianPurchaseBp != null ? { guardianPurchaseBp: data.guardianPurchaseBp } : {}),
        ...(data.videoCallHostShareBp != null
          ? { videoCallHostShareBp: data.videoCallHostShareBp }
          : {}),
        ...(data.luckyHostShareBp != null ? { luckyHostShareBp: data.luckyHostShareBp } : {}),
        ...(data.luckyTargetRtpBp != null ? { luckyTargetRtpBp: data.luckyTargetRtpBp } : {}),
        updatedByAdminId: data.updatedByAdminId,
      },
    })
  },
}
