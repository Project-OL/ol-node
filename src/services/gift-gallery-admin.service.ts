import { prismaRead } from '../config/database'
import { giftGalleryAdminRepository } from '../repositories/gift-gallery-admin.repository'
import { giftRepository } from '../repositories/gift.repository'
import { AppError } from '../middlewares/errorHandler'
import { getActivePeriod } from '../utils/galleryPeriod'
import { giftGalleryService } from './gift-gallery.service'
import type { AdminGallerySection } from '../repositories/gift-gallery-admin.repository'

function resolvePeriod(year?: number, month?: number) {
  if (year != null && month != null) return { year, month }
  const active = getActivePeriod()
  return { year: active.year, month: active.month }
}

async function galleryPeriodForSection(section: { galleryId: string }) {
  const gallery = await prismaRead.giftGallery.findUnique({
    where: { id: section.galleryId },
    select: { year: true, month: true },
  })
  if (!gallery) throw new AppError(404, 'Gallery not found', 'NOT_FOUND')
  return gallery
}

function mapSection(s: AdminGallerySection) {
  return {
    id: s.id,
    name: s.title,
    displayOrder: s.sortOrder,
    status: s.isActive ? ('active' as const) : ('hidden' as const),
    enabledAt: s.enabledAt?.toISOString() ?? null,
    giftCount: s._count.gifts,
    gifts: s.gifts.map((gi) => ({
      itemId: gi.id,
      giftId: gi.gift.id,
      name: gi.gift.name,
      code: gi.gift.code,
      displayImageUrl: gi.gift.displayImageUrl,
      coinCost: gi.gift.coinCost,
      sortOrder: gi.sortOrder,
    })),
  }
}

export const giftGalleryAdminService = {
  async listCategories(year?: number, month?: number) {
    const period = resolvePeriod(year, month)
    const gallery = await giftGalleryAdminRepository.getOrCreateGallery(
      period.year,
      period.month,
    )
    const sections = await giftGalleryAdminRepository.listSections(gallery.id)
    return {
      galleryId: gallery.id,
      year: period.year,
      month: period.month,
      categories: sections.map(mapSection),
    }
  },

  async createCategory(input: {
    name: string
    displayOrder?: number
    enabledAt?: string | null
    year?: number
    month?: number
  }) {
    const period = resolvePeriod(input.year, input.month)
    const gallery = await giftGalleryAdminRepository.getOrCreateGallery(
      period.year,
      period.month,
    )
    const section = await giftGalleryAdminRepository.createSection({
      galleryId: gallery.id,
      title: input.name,
      sortOrder: input.displayOrder,
      enabledAt: input.enabledAt ? new Date(input.enabledAt) : null,
    })
    await giftGalleryService.invalidateMonthCaches(period.year, period.month)
    return mapSection(section)
  },

  async updateCategory(
    sectionId: string,
    input: {
      name?: string
      displayOrder?: number
      isActive?: boolean
      enabledAt?: string | null
    },
  ) {
    const existing = await giftGalleryAdminRepository.findSectionById(sectionId)
    if (!existing) throw new AppError(404, 'Gallery category not found', 'NOT_FOUND')

    const section = await giftGalleryAdminRepository.updateSection(sectionId, {
      ...(input.name !== undefined ? { title: input.name } : {}),
      ...(input.displayOrder !== undefined ? { sortOrder: input.displayOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.enabledAt !== undefined
        ? { enabledAt: input.enabledAt ? new Date(input.enabledAt) : null }
        : {}),
    })

    const { year, month } = await galleryPeriodForSection(existing)
    await giftGalleryService.invalidateMonthCaches(year, month)
    return mapSection(section)
  },

  async reorderCategories(orderedIds: string[], year?: number, month?: number) {
    const period = resolvePeriod(year, month)
    const gallery = await giftGalleryAdminRepository.getOrCreateGallery(
      period.year,
      period.month,
    )
    await giftGalleryAdminRepository.reorderSections(gallery.id, orderedIds)
    await giftGalleryService.invalidateMonthCaches(period.year, period.month)
    return this.listCategories(period.year, period.month)
  },

  async deleteCategory(sectionId: string) {
    const existing = await giftGalleryAdminRepository.findSectionById(sectionId)
    if (!existing) throw new AppError(404, 'Gallery category not found', 'NOT_FOUND')

    const { year, month } = await galleryPeriodForSection(existing)
    await giftGalleryAdminRepository.deleteSection(sectionId)
    await giftGalleryService.invalidateMonthCaches(year, month)
  },

  async addGiftsToCategory(sectionId: string, giftIds: string[]) {
    const existing = await giftGalleryAdminRepository.findSectionById(sectionId)
    if (!existing) throw new AppError(404, 'Gallery category not found', 'NOT_FOUND')

    try {
      await giftRepository.assertAllActiveGiftIds(giftIds)
    } catch {
      throw new AppError(400, 'One or more gifts are missing or inactive', 'INVALID_GIFT_IDS')
    }

    const created = await giftGalleryAdminRepository.addGiftsToSection(sectionId, giftIds)
    if (!created) throw new AppError(404, 'Gallery category not found', 'NOT_FOUND')

    const { year, month } = await galleryPeriodForSection(existing)
    await giftGalleryService.invalidateMonthCaches(year, month)

    return {
      sectionId,
      added: created.map((gi) => ({
        itemId: gi.id,
        giftId: gi.gift.id,
        name: gi.gift.name,
        code: gi.gift.code,
        sortOrder: gi.sortOrder,
      })),
    }
  },
}
