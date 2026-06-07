import type { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

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
    })
  },

  async getAgencyByUserId(userId: string) {
    return prismaRead.agency.findUnique({
      where: { userId },
    })
  },

  /**
   * Resolve an agency by any externally visible numeric id:
   * - `agencies.default_public_id` (canonical agency id)
   * - agency owner's `public_id`, `default_public_id`, or `current_vip_public_id`
   */
  async getAgencyByPublicId(publicId: bigint) {
    const byDefault = await prismaRead.agency.findUnique({
      where: { defaultPublicId: publicId },
    })
    if (byDefault) return byDefault

    const owner = await prismaRead.user.findFirst({
      where: {
        isAgent: true,
        OR: [{ publicId }, { defaultPublicId: publicId }, { currentVipPublicId: publicId }],
      },
      select: { id: true },
    })
    if (!owner) return null

    return prismaRead.agency.findUnique({
      where: { userId: owner.id },
    })
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
    })
  },

  async setPayrollEnabled(userId: string, payrollEnabled: boolean, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    return client.agency.update({
      where: { userId },
      data: { payrollEnabled },
    })
  },

  async incrementHostCount(userId: string, delta: number, tx: Prisma.TransactionClient) {
    return tx.agency.update({
      where: { userId },
      data: {
        totalHostsCount: { increment: delta },
      },
    })
  },

  async updateDisplayAndLevels(
    userId: string,
    data: {
      displayName?: string
      currentLevel?: string
      lifetimeHostEarningsPoints?: bigint
      currentWindowTotalPoints?: bigint
      lastLevelRecomputedAt?: Date | null
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma
    return client.agency.update({
      where: { userId },
      data,
    })
  },

  /**
   * Phase 1: sort by totalHostsCount desc, tie-break defaultPublicId desc.
   * Cursor: opaque offset string (see agencyRanking.service).
   */
  async listForRanking(params: { limit: number; skip: number }) {
    return prismaRead.agency.findMany({
      orderBy: [{ totalHostsCount: 'desc' }, { defaultPublicId: 'desc' }],
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
    })
  },
}
