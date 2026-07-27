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
  /** Singleton config row (id=1), created on first read with schema defaults. */
  async getOrCreateConfig(): Promise<CustomGiftConfig> {
    return prisma.customGiftConfig.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    })
  },

  updateConfig(data: {
    coinCost?: bigint
    coinCost1Month?: bigint
    coinCost3Months?: bigint
    enabled?: boolean
    description?: string | null
    updatedByAdminId: string
  }): Promise<CustomGiftConfig> {
    return prisma.customGiftConfig.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
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
