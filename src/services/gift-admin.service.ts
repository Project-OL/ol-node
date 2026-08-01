import { giftAdminRepository, giftCategoryRepository } from '../repositories/gift-admin.repository'
import { giftRepository } from '../repositories/gift.repository'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { toGiftSlug } from '../utils/gift-slug'
import { giftService } from './gift.service'
import type { GiftWithCategoryAndTags } from '../repositories/gift-admin.repository'

function pctChange(today: number, yesterday: number): number | null {
  if (yesterday === 0) {
    if (today === 0) return 0
    return null
  }
  return Math.round(((today - yesterday) / yesterday) * 10000) / 100
}

function mapGiftAdminRow(g: GiftWithCategoryAndTags, timesSent: number) {
  return {
    id: g.id,
    name: g.name,
    code: g.code,
    displayImageUrl: g.displayImageUrl,
    effectUrl: g.effectUrl,
    category: g.category
      ? { id: g.category.id, name: g.category.name, slug: g.category.slug }
      : null,
    coinCost: g.coinCost,
    displayOrder: g.displayOrder,
    vipOnly: g.vipOnly,
    timesSent,
    status: g.isActive ? ('active' as const) : ('disabled' as const),
    createdAt: g.createdAt.toISOString(),
  }
}

async function ensureUniqueCode(base: string): Promise<string> {
  let code = toGiftSlug(base)
  let suffix = 0
  while (await giftAdminRepository.findByCode(code)) {
    suffix += 1
    code = toGiftSlug(`${base}_${suffix}`)
  }
  return code
}

async function ensureUniqueCategorySlug(base: string): Promise<string> {
  let slug = toGiftSlug(base)
  let suffix = 0
  while (await giftCategoryRepository.findBySlug(slug)) {
    suffix += 1
    slug = toGiftSlug(`${base}_${suffix}`)
  }
  return slug
}

export const giftAdminService = {
  async getAnalytics() {
    const bounds = await giftAdminRepository.getAnalyticsBounds()
    const [counts, sends, revenue, mostSentGifts] = await Promise.all([
      giftAdminRepository.getGiftCounts(),
      giftAdminRepository.getSendCounts(bounds.todayStart),
      giftAdminRepository.getRevenueAggregates(bounds),
      giftAdminRepository.getMostSentGifts(5),
    ])

    return {
      ...counts,
      ...sends,
      totalGiftRevenueAllTime: revenue.totalGiftRevenueAllTime,
      todayGiftRevenue: revenue.todayGiftRevenue,
      todayGiftRevenueChangePercent: pctChange(
        revenue.todayGiftRevenue,
        revenue.yesterdayGiftRevenue,
      ),
      monthGiftRevenue: revenue.monthGiftRevenue,
      mostSentGifts,
    }
  },

  async listGifts(query: {
    categoryId?: string
    status: 'active' | 'disabled' | 'all'
    minPrice?: number
    maxPrice?: number
    search?: string
    page: number
    limit: number
  }) {
    if (query.categoryId) {
      const cat = await giftCategoryRepository.findById(query.categoryId)
      if (!cat) throw new AppError(404, 'Category not found', 'NOT_FOUND')
    }

    const skip = (query.page - 1) * query.limit
    const { items, total, sendCounts } = await giftAdminRepository.listAdmin({
      ...query,
      skip,
      take: query.limit,
    })

    return {
      items: items.map((g) => mapGiftAdminRow(g, sendCounts.get(g.id) ?? 0)),
      total,
      page: query.page,
      limit: query.limit,
    }
  },

  async createGift(input: {
    name: string
    code?: string
    coinCost: number
    displayImageUrl: string
    effectUrl?: string | null
    categoryId?: string | null
    displayOrder?: number
    vipOnly?: boolean
  }) {
    if (input.categoryId) {
      const cat = await giftCategoryRepository.findById(input.categoryId)
      if (!cat) throw new AppError(404, 'Category not found', 'NOT_FOUND')
    }

    const code = input.code
      ? input.code
      : await ensureUniqueCode(input.name)

    if (input.code && (await giftAdminRepository.findByCode(input.code))) {
      throw new AppError(409, 'Gift code already exists', 'GIFT_CODE_EXISTS')
    }

    const g = await giftAdminRepository.createGift({
      name: input.name,
      code,
      coinCost: input.coinCost,
      displayImageUrl: input.displayImageUrl,
      effectUrl: input.effectUrl ?? null,
      categoryId: input.categoryId ?? null,
      displayOrder: input.displayOrder,
      vipOnly: input.vipOnly ?? false,
    })

    await giftService.invalidateCachesForGift(g)
    return mapGiftAdminRow(g, 0)
  },

  async patchGift(
    giftId: string,
    input: {
      name?: string
      code?: string
      coinCost?: number
      displayImageUrl?: string
      effectUrl?: string | null
      categoryId?: string | null
      displayOrder?: number
      vipOnly?: boolean
      isActive?: boolean
    },
  ) {
    const existing = await giftRepository.findById(giftId)
    if (!existing) throw new AppError(404, 'Gift not found', 'NOT_FOUND')

    if (input.categoryId) {
      const cat = await giftCategoryRepository.findById(input.categoryId)
      if (!cat) throw new AppError(404, 'Category not found', 'NOT_FOUND')
    }

    if (input.code && input.code !== existing.code) {
      const dup = await giftAdminRepository.findByCode(input.code)
      if (dup && dup.id !== giftId) {
        throw new AppError(409, 'Gift code already exists', 'GIFT_CODE_EXISTS')
      }
    }

    const g = await giftAdminRepository.updateGift(giftId, input)
    const timesSent = await prismaRead.giftTransaction.count({ where: { giftId } })

    await giftService.invalidateCachesForGift(g)
    return mapGiftAdminRow(g, timesSent)
  },

  async deleteGift(giftId: string) {
    const existing = await giftRepository.findById(giftId)
    if (!existing) throw new AppError(404, 'Gift not found', 'NOT_FOUND')

    const g = await giftAdminRepository.updateGift(giftId, { isActive: false })
    await giftService.invalidateCachesForGift(g)
    return mapGiftAdminRow(g, 0)
  },
}

export const giftCategoryService = {
  async list() {
    const rows = await giftCategoryRepository.listAll()
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      displayOrder: c.displayOrder,
      status: c.isActive ? ('active' as const) : ('hidden' as const),
      giftCount: c.giftCount,
      createdAt: c.createdAt.toISOString(),
    }))
  },

  async create(input: { name: string; slug?: string; displayOrder?: number }) {
    const slug = input.slug ?? (await ensureUniqueCategorySlug(input.name))
    if (input.slug && (await giftCategoryRepository.findBySlug(input.slug))) {
      throw new AppError(409, 'Category slug already exists', 'CATEGORY_SLUG_EXISTS')
    }

    const displayOrder =
      input.displayOrder ??
      (await giftCategoryRepository.maxDisplayOrder()) + 1

    const c = await giftCategoryRepository.create({
      name: input.name,
      slug,
      displayOrder,
    })

    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      displayOrder: c.displayOrder,
      status: 'active' as const,
      giftCount: 0,
      createdAt: c.createdAt.toISOString(),
    }
  },

  async update(
    categoryId: string,
    input: {
      name?: string
      slug?: string
      displayOrder?: number
      isActive?: boolean
    },
  ) {
    const existing = await giftCategoryRepository.findById(categoryId)
    if (!existing) throw new AppError(404, 'Category not found', 'NOT_FOUND')

    if (input.slug && input.slug !== existing.slug) {
      const dup = await giftCategoryRepository.findBySlug(input.slug)
      if (dup && dup.id !== categoryId) {
        throw new AppError(409, 'Category slug already exists', 'CATEGORY_SLUG_EXISTS')
      }
    }

    const c = await giftCategoryRepository.update(categoryId, input)

    let giftsDisabled = 0
    if (input.isActive === false) {
      giftsDisabled = await giftCategoryRepository.disableGiftsInCategory(categoryId)
    }

    await giftService.invalidateAllGiftCaches()

    const giftCount = await giftCategoryRepository.countGifts(categoryId)
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      displayOrder: c.displayOrder,
      status: c.isActive ? ('active' as const) : ('hidden' as const),
      giftCount,
      createdAt: c.createdAt.toISOString(),
      ...(input.isActive === false ? { giftsDisabled } : {}),
    }
  },

  async reorder(orderedIds: string[]) {
    await giftCategoryRepository.reorder(orderedIds)
    await giftService.invalidateAllGiftCaches()
    return this.list()
  },

  async delete(categoryId: string) {
    const existing = await giftCategoryRepository.findById(categoryId)
    if (!existing) throw new AppError(404, 'Category not found', 'NOT_FOUND')

    const giftCount = await giftCategoryRepository.countGifts(categoryId)
    if (giftCount > 0) {
      throw new AppError(
        409,
        'Category has gifts assigned; move or delete gifts first',
        'CATEGORY_NOT_EMPTY',
      )
    }

    await giftCategoryRepository.delete(categoryId)
    await giftService.invalidateAllGiftCaches()
  },
}
