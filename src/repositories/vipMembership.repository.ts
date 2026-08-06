import type { Prisma, VipMembershipTier } from '@prisma/client'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'

export const vipMembershipRepository = {
  async getMembershipState(userId: string) {
    const u = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { vipSubscriptionExpiresAt: true },
    })
    const exp = u?.vipSubscriptionExpiresAt ?? null
    const now = new Date()
    const isActive = exp != null && exp.getTime() > now.getTime()
    return { isActive, expiresAt: exp }
  },

  async getMembershipStateBulk(userIds: string[]) {
    const m = new Map<string, { isActive: boolean; expiresAt: Date | null }>()
    for (const id of userIds) {
      m.set(id, { isActive: false, expiresAt: null })
    }
    if (userIds.length === 0) return m
    const rows = await prismaRead.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, vipSubscriptionExpiresAt: true },
    })
    const now = Date.now()
    for (const r of rows) {
      const exp = r.vipSubscriptionExpiresAt
      const isActive = exp != null && exp.getTime() > now
      m.set(r.id, { isActive, expiresAt: exp })
    }
    return m
  },

  async updateMembershipState(
    args: {
      userId: string
      expiresAt: Date
      setStartAt: Date | undefined
      active: boolean
    },
    tx: Prisma.TransactionClient,
  ) {
    await tx.user.update({
      where: { id: args.userId },
      data: {
        vipSubscriptionExpiresAt: args.expiresAt,
        vipSubscriptionActive: args.active,
        ...(args.setStartAt ? { vipSubscriptionStartAt: args.setStartAt } : {}),
      },
    })
  },

  async insertPurchase(
    row: {
      userId: string
      tier: VipMembershipTier
      periodDays: number
      coinCost: bigint
      ledgerEntryId: string
      expiresAtBefore: Date | null
      expiresAtAfter: Date
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.vipMembershipPurchase.create({
      data: {
        userId: row.userId,
        tier: row.tier,
        periodDays: row.periodDays,
        coinCost: row.coinCost,
        ledgerEntryId: row.ledgerEntryId,
        expiresAtBefore: row.expiresAtBefore,
        expiresAtAfter: row.expiresAtAfter,
      },
    })
  },

  async findPurchaseByLedgerEntryId(ledgerEntryId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prismaRead
    return client.vipMembershipPurchase.findUnique({
      where: { ledgerEntryId },
    })
  },

  async insertDailyClaim(
    row: {
      userId: string
      claimDate: Date
      coinAmount: bigint
      ledgerEntryId: string
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.vipDailyClaim.create({
      data: {
        userId: row.userId,
        claimDate: row.claimDate,
        coinAmount: row.coinAmount,
        ledgerEntryId: row.ledgerEntryId,
      },
    })
  },

  async getDailyClaim(userId: string, claimDate: Date) {
    return prismaRead.vipDailyClaim.findUnique({
      where: {
        userId_claimDate: { userId, claimDate },
      },
    })
  },

  async getLastDailyClaim(userId: string) {
    return prismaRead.vipDailyClaim.findFirst({
      where: { userId },
      orderBy: { claimDate: 'desc' },
      select: { claimDate: true, claimedAt: true },
    })
  },

  async getDailyClaimHistory(
    userId: string,
    opts: { limit: number; cursorClaimDate?: string | null },
  ) {
    const cursorDate = opts.cursorClaimDate
      ? (() => {
          const d = new Date(`${opts.cursorClaimDate}T00:00:00.000Z`)
          return Number.isNaN(d.getTime()) ? null : d
        })()
      : null

    const rows = await prismaRead.vipDailyClaim.findMany({
      where: {
        userId,
        ...(cursorDate ? { claimDate: { lt: cursorDate } } : {}),
      },
      orderBy: { claimDate: 'desc' },
      take: opts.limit + 1,
      select: {
        claimDate: true,
        coinAmount: true,
        ledgerEntryId: true,
        claimedAt: true,
      },
    })

    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last
      ? last.claimDate.toISOString().slice(0, 10)
      : undefined

    return { items: page, nextCursor, hasMore }
  },

  async countPurchases(userId: string) {
    return prismaRead.vipMembershipPurchase.count({ where: { userId } })
  },

  async countDailyClaims(userId: string) {
    return prismaRead.vipDailyClaim.count({ where: { userId } })
  },

  async getMembershipRow(userId: string) {
    return prismaRead.user.findUnique({
      where: { id: userId },
      select: {
        vipSubscriptionActive: true,
        vipSubscriptionStartAt: true,
        vipSubscriptionExpiresAt: true,
        currentVipPublicId: true,
        vipPublicIdExpiresAt: true,
      },
    })
  },

  async getRecentPurchases(userId: string, opts: { limit: number; cursor?: string | null }) {
    const cursorRow = opts.cursor
      ? await prismaRead.vipMembershipPurchase.findFirst({
          where: { id: opts.cursor, userId },
          select: { createdAt: true, id: true },
        })
      : null

    const rows = await prismaRead.vipMembershipPurchase.findMany({
      where: {
        userId,
        ...(cursorRow
          ? {
              OR: [
                { createdAt: { lt: cursorRow.createdAt } },
                {
                  createdAt: cursorRow.createdAt,
                  id: { lt: cursorRow.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
    })

    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined

    return { items: page, nextCursor, hasMore }
  },

  async getLatestTier(userId: string) {
    const row = await prismaRead.vipMembershipPurchase.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { tier: true },
    })
    return row?.tier ?? null
  },

  async incrementQuotaUsage(
    args: {
      userId: string
      date: Date
      type: string
      max: number
    },
    tx: Prisma.TransactionClient,
  ) {
    const updated = await tx.vipDailyQuota.upsert({
      where: {
        userId_quotaDate_quotaType: {
          userId: args.userId,
          quotaDate: args.date,
          quotaType: args.type,
        },
      },
      create: {
        userId: args.userId,
        quotaDate: args.date,
        quotaType: args.type,
        used: 1,
        maxAllowed: args.max,
      },
      update: { used: { increment: 1 } },
    })
    if (updated.used > updated.maxAllowed) {
      throw new AppError(400, 'VIP quota exceeded', 'VIP_QUOTA_EXCEEDED')
    }
    return updated
  },
}
