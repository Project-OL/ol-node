import type { StoreItem } from '@prisma/client'
import { storeAdminRepository } from '../repositories/store-admin.repository'
import { storeService } from './store.service'

function mapStoreAdminRow(item: StoreItem, purchaseCount: number) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    displayImageUrl: item.displayImageUrl,
    effectUrl: item.effectUrl,
    validityDays: item.validityDays,
    coinCost: item.coinCost,
    purchaseCount,
    sortOrder: item.sortOrder,
    status: item.isActive ? ('active' as const) : ('disabled' as const),
    createdAt: item.createdAt.toISOString(),
  }
}

export const storeAdminService = {
  async getAnalytics() {
    const todayStart = await storeAdminRepository.getTodayStart()
    const [counts, totalPurchasesToday, itemsPerType] = await Promise.all([
      storeAdminRepository.getItemCounts(),
      storeAdminRepository.getPurchasesToday(todayStart),
      storeAdminRepository.getItemsPerType(),
    ])

    const totalItemTypes = itemsPerType.filter((row) => row.count > 0).length

    return {
      ...counts,
      totalPurchasesToday,
      totalItemTypes,
      itemsPerType,
    }
  },

  async listItems(query: {
    category?: import('@prisma/client').StoreItemCategory
    status: 'active' | 'disabled' | 'all'
    minPrice?: number
    maxPrice?: number
    search?: string
    page: number
    limit: number
  }) {
    const skip = (query.page - 1) * query.limit
    const { items, total } = await storeAdminRepository.listAdmin({
      ...query,
      skip,
      take: query.limit,
    })

    const purchaseCounts = await storeAdminRepository.getPurchaseCounts(items.map((i) => i.id))

    return {
      items: items.map((item) => mapStoreAdminRow(item, purchaseCounts.get(item.id) ?? 0)),
      total,
      page: query.page,
      limit: query.limit,
    }
  },

  mapStoreItemRow(item: StoreItem, purchaseCount = 0) {
    return mapStoreAdminRow(item, purchaseCount)
  },

  async getUserStoreSummary(userId: string) {
    const [owned, wearing] = await Promise.all([
      storeService.listOwnedItems(userId, { limit: 100 }),
      storeService.getActiveItemsForUser(userId),
    ])

    return {
      ownedItems: owned.items,
      ownedRarePublicIds: owned.ownedRarePublicIds,
      wearingItems: wearing,
    }
  },

  async getUserStoreSummaries(userIds: string[]) {
    const entries = await Promise.all(
      userIds.map(async (userId) => {
        const summary = await this.getUserStoreSummary(userId)
        return [userId, summary] as const
      }),
    )
    return new Map(entries)
  },
}
