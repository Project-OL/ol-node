import { prismaRead } from '../config/database'
import type { Prisma, StoreItem, StoreItemCategory } from '@prisma/client'

export type StoreAdminListParams = {
  category?: StoreItemCategory
  status?: 'active' | 'disabled' | 'all'
  minPrice?: number
  maxPrice?: number
  search?: string
  skip: number
  take: number
}

const ALL_CATEGORIES: StoreItemCategory[] = ['RIDE', 'AVATAR_FRAME', 'CHAT_BUBBLE', 'PROFILE_CARD']

export const storeAdminRepository = {
  async getTodayStart(): Promise<Date> {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
  },

  async getItemCounts() {
    const [totalStoreItems, activeStoreItems, disabledStoreItems] = await Promise.all([
      prismaRead.storeItem.count(),
      prismaRead.storeItem.count({ where: { isActive: true } }),
      prismaRead.storeItem.count({ where: { isActive: false } }),
    ])
    return { totalStoreItems, activeStoreItems, disabledStoreItems }
  },

  async getPurchasesToday(todayStart: Date) {
    return prismaRead.userStoreItem.count({
      where: { createdAt: { gte: todayStart } },
    })
  },

  async getItemsPerType() {
    const grouped = await prismaRead.storeItem.groupBy({
      by: ['category'],
      _count: { _all: true },
    })
    const byCategory = new Map(grouped.map((g) => [g.category, g._count._all]))
    return ALL_CATEGORIES.map((category) => ({
      category,
      count: byCategory.get(category) ?? 0,
    }))
  },

  async getPurchaseCounts(storeItemIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    if (storeItemIds.length === 0) return counts

    const grouped = await prismaRead.userStoreItem.groupBy({
      by: ['storeItemId'],
      where: { storeItemId: { in: storeItemIds } },
      _count: { _all: true },
    })
    for (const row of grouped) {
      counts.set(row.storeItemId, row._count._all)
    }
    return counts
  },

  async listAdmin(params: StoreAdminListParams): Promise<{ items: StoreItem[]; total: number }> {
    const where: Prisma.StoreItemWhereInput = {}

    if (params.status === 'active') where.isActive = true
    else if (params.status === 'disabled') where.isActive = false

    if (params.category) where.category = params.category

    if (params.minPrice != null || params.maxPrice != null) {
      where.coinCost = {
        ...(params.minPrice != null ? { gte: params.minPrice } : {}),
        ...(params.maxPrice != null ? { lte: params.maxPrice } : {}),
      }
    }

    if (params.search) {
      const q = params.search.trim()
      const or: Prisma.StoreItemWhereInput[] = [{ name: { contains: q, mode: 'insensitive' } }]
      if (/^[0-9a-f-]{36}$/i.test(q)) {
        or.push({ id: q })
      }
      where.OR = or
    }

    const [items, total] = await Promise.all([
      prismaRead.storeItem.findMany({
        where,
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: params.skip,
        take: params.take,
      }),
      prismaRead.storeItem.count({ where }),
    ])

    return { items, total }
  },
}
