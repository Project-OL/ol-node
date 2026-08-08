import { prisma, prismaRead } from '../config/database'
import type {
  CustomGiftConfig,
  CustomGiftRequest,
  CustomGiftRequestStatus,
  Prisma,
} from '@prisma/client'

const GIFT_SELECT = {
  select: { id: true, name: true, code: true, displayImageUrl: true, coinCost: true },
} as const

const USER_SELECT = {
  select: {
    id: true,
    username: true,
    publicId: true,
    firstName: true,
    lastName: true,
    avatarUrl: true,
    country: true,
  },
} as const

export type CustomGiftRequestWithGift = Prisma.CustomGiftRequestGetPayload<{
  include: { gift: typeof GIFT_SELECT }
}>

export type CustomGiftRequestWithUserAndGift = Prisma.CustomGiftRequestGetPayload<{
  include: { gift: typeof GIFT_SELECT; user: typeof USER_SELECT }
}>

export const customGiftRepository = {
  /** Singleton config row (id=1). Ensures BigInt price columns are never null (DB drift-safe). */
  async getOrCreateConfig(): Promise<CustomGiftConfig> {
    const DEFAULT_1M = 100_000n
    const DEFAULT_3M = 200_000n

    const rows = await prisma.$queryRaw<
      Array<{
        id: number
        coin_cost: bigint | null
        coin_cost_1_month: bigint | null
        coin_cost_3_months: bigint | null
      }>
    >`
      SELECT id, coin_cost, coin_cost_1_month, coin_cost_3_months
      FROM custom_gift_config
      WHERE id = 1
    `

    if (rows.length === 0) {
      return prisma.customGiftConfig.create({
        data: {
          id: 1,
          coinCost: DEFAULT_1M,
          coinCost1Month: DEFAULT_1M,
          coinCost3Months: DEFAULT_3M,
          enabled: true,
        },
      })
    }

    const row = rows[0]!
    if (row.coin_cost == null || row.coin_cost_1_month == null || row.coin_cost_3_months == null) {
      const coinCost = row.coin_cost ?? DEFAULT_1M
      const coinCost1Month = row.coin_cost_1_month ?? coinCost
      const coinCost3Months = row.coin_cost_3_months ?? DEFAULT_3M
      await prisma.$executeRaw`
        UPDATE custom_gift_config
        SET
          coin_cost = ${coinCost},
          coin_cost_1_month = ${coinCost1Month},
          coin_cost_3_months = ${coinCost3Months},
          updated_at = NOW()
        WHERE id = 1
      `
    }

    return prisma.customGiftConfig.findUniqueOrThrow({ where: { id: 1 } })
  },

  updateConfig(data: {
    coinCost?: bigint
    coinCost1Month?: bigint
    coinCost3Months?: bigint
    enabled?: boolean
    description?: string | null
    updatedByAdminId: string
  }): Promise<CustomGiftConfig> {
    const DEFAULT_1M = 100_000n
    const DEFAULT_3M = 200_000n
    const oneMonth = data.coinCost1Month ?? data.coinCost ?? DEFAULT_1M
    return prisma.customGiftConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        coinCost: oneMonth,
        coinCost1Month: oneMonth,
        coinCost3Months: data.coinCost3Months ?? DEFAULT_3M,
        enabled: data.enabled ?? true,
        description: data.description ?? null,
        updatedByAdminId: data.updatedByAdminId,
      },
      update: data,
    })
  },

  findPendingByUserId(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomGiftRequest | null> {
    const db = tx ?? prisma
    return db.customGiftRequest.findFirst({ where: { userId, status: 'PENDING' } })
  },

  findByLedgerEntryId(
    ledgerEntryId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomGiftRequest | null> {
    const db = tx ?? prisma
    return db.customGiftRequest.findUnique({ where: { ledgerEntryId } })
  },

  create(
    data: {
      userId: string
      whatsappNumber: string
      note?: string
      validityDays?: number
      coinCost: bigint
      ledgerEntryId: string
    },
    tx?: Prisma.TransactionClient,
  ): Promise<CustomGiftRequest> {
    const db = tx ?? prisma
    return db.customGiftRequest.create({ data })
  },

  findByIdWithGift(id: string): Promise<CustomGiftRequestWithGift | null> {
    return prisma.customGiftRequest.findUnique({
      where: { id },
      include: { gift: GIFT_SELECT },
    })
  },

  findByIdWithUserAndGift(id: string): Promise<CustomGiftRequestWithUserAndGift | null> {
    return prisma.customGiftRequest.findUnique({
      where: { id },
      include: { gift: GIFT_SELECT, user: USER_SELECT },
    })
  },

  listByUser(params: {
    userId: string
    status?: CustomGiftRequestStatus
    limit: number
    cursor?: string
  }): Promise<CustomGiftRequestWithGift[]> {
    return prismaRead.customGiftRequest.findMany({
      where: {
        userId: params.userId,
        ...(params.status ? { status: params.status } : {}),
      },
      include: { gift: GIFT_SELECT },
      orderBy: { createdAt: 'desc' },
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    })
  },

  async adminList(params: {
    status?: CustomGiftRequestStatus
    userId?: string
    page: number
    limit: number
  }): Promise<{ items: CustomGiftRequestWithUserAndGift[]; total: number }> {
    const where: Prisma.CustomGiftRequestWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
    }
    const [items, total] = await Promise.all([
      prismaRead.customGiftRequest.findMany({
        where,
        include: { gift: GIFT_SELECT, user: USER_SELECT },
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prismaRead.customGiftRequest.count({ where }),
    ])
    return { items, total }
  },

  /**
   * Transition PENDING → resolved atomically; returns 0 rows updated when the
   * request was already resolved (caller maps that to 409).
   */
  resolvePending(
    id: string,
    data: {
      status: Extract<CustomGiftRequestStatus, 'COMPLETED' | 'FAILED'>
      giftId?: string
      adminNote?: string
      failureReason?: string
      refunded?: boolean
      refundLedgerEntryId?: string
      resolvedByAdminId: string
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = tx ?? prisma
    return db.customGiftRequest
      .updateMany({
        where: { id, status: 'PENDING' },
        data: { ...data, resolvedAt: new Date() },
      })
      .then((r) => r.count)
  },

  countByStatus(): Promise<{ status: CustomGiftRequestStatus; count: number }[]> {
    return prismaRead.customGiftRequest
      .groupBy({ by: ['status'], _count: { _all: true } })
      .then((rows) => rows.map((r) => ({ status: r.status, count: r._count._all })))
  },
}
