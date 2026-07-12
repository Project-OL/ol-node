import { prisma, prismaRead } from '../config/database'
import type { GiftCategory, Prisma } from '@prisma/client'

export const giftCategoryRepository = {
  async findById(id: string): Promise<GiftCategory | null> {
    return prismaRead.giftCategory.findUnique({ where: { id } })
  },

  async findBySlug(slug: string): Promise<GiftCategory | null> {
    return prismaRead.giftCategory.findUnique({ where: { slug } })
  },

  async listAll() {
    const rows = await prismaRead.giftCategory.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { gifts: true } } },
    })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      displayOrder: r.displayOrder,
      isActive: r.isActive,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      giftCount: r._count.gifts,
    }))
  },

  async create(data: { name: string; slug: string; displayOrder?: number }) {
    return prisma.giftCategory.create({
      data: {
        name: data.name,
        slug: data.slug,
        displayOrder: data.displayOrder ?? 0,
      },
    })
  },

  async update(
    id: string,
    data: {
      name?: string
      slug?: string
      displayOrder?: number
      isActive?: boolean
    },
  ) {
    return prisma.giftCategory.update({
      where: { id },
      data,
    })
  },

  async delete(id: string) {
    return prisma.giftCategory.delete({ where: { id } })
  },

  async countGifts(categoryId: string): Promise<number> {
    return prismaRead.gift.count({ where: { categoryId } })
  },

  async reorder(orderedIds: string[]) {
    return prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.giftCategory.update({
          where: { id },
          data: { displayOrder: index },
        }),
      ),
    )
  },

  async maxDisplayOrder(): Promise<number> {
    const row = await prismaRead.giftCategory.findFirst({
      orderBy: { displayOrder: 'desc' },
      select: { displayOrder: true },
    })
    return row?.displayOrder ?? 0
  },
}

export type GiftAdminListParams = {
  categoryId?: string
  status?: 'active' | 'disabled' | 'all'
  minPrice?: number
  maxPrice?: number
  search?: string
  skip: number
  take: number
}

export type GiftWithCategoryAndTags = Prisma.GiftGetPayload<{
  include: { category: true; tags: true }
}>

export const giftAdminRepository = {
  async getAnalyticsBounds() {
    const now = new Date()
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    )
    const yesterdayStart = new Date(todayStart.getTime() - 86_400_000)
    const year = now.getUTCFullYear()
    const month = now.getUTCMonth() + 1
    const monthStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0))
    const monthEndExclusive = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0))
    return { todayStart, yesterdayStart, monthStart, monthEndExclusive }
  },

  async getGiftCounts() {
    const [totalGifts, totalActiveGifts, totalDisabledGifts] = await Promise.all([
      prismaRead.gift.count(),
      prismaRead.gift.count({ where: { isActive: true } }),
      prismaRead.gift.count({ where: { isActive: false } }),
    ])
    return { totalGifts, totalActiveGifts, totalDisabledGifts }
  },

  async getSendCounts(todayStart: Date) {
    const [totalGiftsSentAllTime, totalGiftsSentToday] = await Promise.all([
      prismaRead.giftTransaction.count(),
      prismaRead.giftTransaction.count({ where: { createdAt: { gte: todayStart } } }),
    ])
    return { totalGiftsSentAllTime, totalGiftsSentToday }
  },

  async getRevenueAggregates(bounds: {
    todayStart: Date
    yesterdayStart: Date
    monthStart: Date
    monthEndExclusive: Date
  }) {
    const [allTime, today, yesterday, month] = await Promise.all([
      prismaRead.giftTransaction.aggregate({ _sum: { coinCost: true } }),
      prismaRead.giftTransaction.aggregate({
        where: { createdAt: { gte: bounds.todayStart } },
        _sum: { coinCost: true },
      }),
      prismaRead.giftTransaction.aggregate({
        where: { createdAt: { gte: bounds.yesterdayStart, lt: bounds.todayStart } },
        _sum: { coinCost: true },
      }),
      prismaRead.giftTransaction.aggregate({
        where: {
          createdAt: { gte: bounds.monthStart, lt: bounds.monthEndExclusive },
        },
        _sum: { coinCost: true },
      }),
    ])
    return {
      totalGiftRevenueAllTime: allTime._sum.coinCost ?? 0,
      todayGiftRevenue: today._sum.coinCost ?? 0,
      yesterdayGiftRevenue: yesterday._sum.coinCost ?? 0,
      monthGiftRevenue: month._sum.coinCost ?? 0,
    }
  },

  async getMostSentGifts(limit: number) {
    const grouped = await prismaRead.giftTransaction.groupBy({
      by: ['giftId'],
      _count: { _all: true },
      _sum: { coinCost: true },
      orderBy: { _count: { giftId: 'desc' } },
      take: limit,
    })
    if (grouped.length === 0) return []

    const giftIds = grouped.map((g) => g.giftId)
    const gifts = await prismaRead.gift.findMany({
      where: { id: { in: giftIds } },
      select: {
        id: true,
        name: true,
        code: true,
        displayImageUrl: true,
        coinCost: true,
      },
    })
    const giftById = new Map(gifts.map((g) => [g.id, g]))

    return grouped
      .map((g) => {
        const gift = giftById.get(g.giftId)
        if (!gift) return null
        return {
          giftId: gift.id,
          name: gift.name,
          code: gift.code,
          displayImageUrl: gift.displayImageUrl,
          coinCost: gift.coinCost,
          timesSent: g._count._all,
          revenue: g._sum.coinCost ?? 0,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
  },

  async listAdmin(params: GiftAdminListParams): Promise<{
    items: GiftWithCategoryAndTags[]
    total: number
    sendCounts: Map<string, number>
  }> {
    const where: Prisma.GiftWhereInput = {}

    if (params.status === 'active') where.isActive = true
    else if (params.status === 'disabled') where.isActive = false

    if (params.categoryId) where.categoryId = params.categoryId

    if (params.minPrice != null || params.maxPrice != null) {
      where.coinCost = {
        ...(params.minPrice != null ? { gte: params.minPrice } : {}),
        ...(params.maxPrice != null ? { lte: params.maxPrice } : {}),
      }
    }

    if (params.search) {
      const q = params.search.trim()
      const or: Prisma.GiftWhereInput[] = [
        { name: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
      ]
      if (/^[0-9a-f-]{36}$/i.test(q)) {
        or.push({ id: q })
      }
      where.OR = or
    }

    const [items, total] = await Promise.all([
      prismaRead.gift.findMany({
        where,
        include: { category: true, tags: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
        skip: params.skip,
        take: params.take,
      }),
      prismaRead.gift.count({ where }),
    ])

    const giftIds = items.map((g) => g.id)
    const sendCounts = new Map<string, number>()
    if (giftIds.length > 0) {
      const grouped = await prismaRead.giftTransaction.groupBy({
        by: ['giftId'],
        where: { giftId: { in: giftIds } },
        _count: { _all: true },
      })
      for (const row of grouped) {
        sendCounts.set(row.giftId, row._count._all)
      }
    }

    return { items, total, sendCounts }
  },

  async findByCode(code: string) {
    return prismaRead.gift.findUnique({ where: { code } })
  },

  async createGift(data: {
    name: string
    code: string
    coinCost: number
    displayImageUrl: string
    effectUrl?: string | null
    displayOrder?: number
    vipOnly?: boolean
    categoryId?: string | null
    tags?: string[]
  }) {
    return prisma.gift.create({
      data: {
        name: data.name,
        code: data.code,
        coinCost: data.coinCost,
        displayImageUrl: data.displayImageUrl,
        effectUrl: data.effectUrl ?? null,
        displayOrder: data.displayOrder ?? 0,
        vipOnly: data.vipOnly ?? false,
        categoryId: data.categoryId ?? null,
        tags: data.tags?.length
          ? { create: data.tags.map((tag) => ({ tag })) }
          : undefined,
      },
      include: { category: true, tags: true },
    })
  },

  async updateGift(
    id: string,
    data: {
      name?: string
      code?: string
      coinCost?: number
      displayImageUrl?: string
      effectUrl?: string | null
      displayOrder?: number
      vipOnly?: boolean
      isActive?: boolean
      categoryId?: string | null
      tags?: string[]
    },
  ) {
    return prisma.$transaction(async (tx) => {
      if (data.tags) {
        await tx.giftTag.deleteMany({ where: { giftId: id } })
      }
      return tx.gift.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.code !== undefined ? { code: data.code } : {}),
          ...(data.coinCost !== undefined ? { coinCost: data.coinCost } : {}),
          ...(data.displayImageUrl !== undefined
            ? { displayImageUrl: data.displayImageUrl }
            : {}),
          ...(data.effectUrl !== undefined ? { effectUrl: data.effectUrl } : {}),
          ...(data.displayOrder !== undefined ? { displayOrder: data.displayOrder } : {}),
          ...(data.vipOnly !== undefined ? { vipOnly: data.vipOnly } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
          ...(data.tags
            ? { tags: { create: data.tags.map((tag) => ({ tag })) } }
            : {}),
        },
        include: { category: true, tags: true },
      })
    })
  },
}
