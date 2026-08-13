import { prisma } from '../config/database'
import type { Prisma } from '@prisma/client'

const adminSectionInclude = {
  gifts: {
    orderBy: { sortOrder: 'asc' as const },
    include: { gift: true },
  },
  _count: { select: { gifts: true } },
} as const

export type AdminGallerySection = Prisma.GiftGallerySectionGetPayload<{
  include: typeof adminSectionInclude
}>

export const giftGalleryAdminRepository = {
  async getOrCreateGallery(year: number, month: number) {
    return prisma.giftGallery.upsert({
      where: { year_month: { year, month } },
      create: { year, month },
      update: {},
    })
  },

  async listSections(galleryId: string): Promise<AdminGallerySection[]> {
    return prisma.giftGallerySection.findMany({
      where: { galleryId },
      include: adminSectionInclude,
      orderBy: { sortOrder: 'asc' },
    })
  },

  async findSectionById(sectionId: string): Promise<AdminGallerySection | null> {
    return prisma.giftGallerySection.findUnique({
      where: { id: sectionId },
      include: adminSectionInclude,
    })
  },

  async createSection(data: {
    galleryId: string
    title: string
    sortOrder?: number
    enabledAt?: Date | null
  }) {
    let sortOrder = data.sortOrder
    if (sortOrder === undefined) {
      const max = await prisma.giftGallerySection.findFirst({
        where: { galleryId: data.galleryId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      })
      sortOrder = (max?.sortOrder ?? -1) + 1
    }
    return prisma.giftGallerySection.create({
      data: {
        galleryId: data.galleryId,
        title: data.title,
        sortOrder,
        enabledAt: data.enabledAt ?? null,
      },
      include: adminSectionInclude,
    })
  },

  async updateSection(
    sectionId: string,
    data: {
      title?: string
      sortOrder?: number
      isActive?: boolean
      enabledAt?: Date | null
    },
  ) {
    return prisma.giftGallerySection.update({
      where: { id: sectionId },
      data,
      include: adminSectionInclude,
    })
  },

  async deleteSection(sectionId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.giftGallerySectionItem.deleteMany({ where: { sectionId } })
      return tx.giftGallerySection.delete({ where: { id: sectionId } })
    })
  },

  async reorderSections(galleryId: string, orderedIds: string[]) {
    return prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.giftGallerySection.update({
          where: { id, galleryId },
          data: { sortOrder: index },
        }),
      ),
    )
  },

  async addGiftsToSection(sectionId: string, giftIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const section = await tx.giftGallerySection.findUnique({
        where: { id: sectionId },
        include: {
          gifts: { orderBy: { sortOrder: 'desc' }, take: 1, select: { sortOrder: true } },
        },
      })
      if (!section) return null

      let nextOrder = (section.gifts[0]?.sortOrder ?? -1) + 1
      const created = []
      for (const giftId of giftIds) {
        try {
          const row = await tx.giftGallerySectionItem.create({
            data: { sectionId, giftId, sortOrder: nextOrder },
            include: { gift: true },
          })
          created.push(row)
          nextOrder += 1
        } catch (e: unknown) {
          const err = e as { code?: string }
          if (err?.code === 'P2002') continue
          throw e
        }
      }
      return created
    })
  },

  async removeGiftsFromSection(sectionId: string, giftIds: string[]) {
    const existing = await prisma.giftGallerySectionItem.findMany({
      where: { sectionId, giftId: { in: giftIds } },
      select: { id: true, giftId: true },
    })
    if (existing.length === 0) return existing

    await prisma.giftGallerySectionItem.deleteMany({
      where: { sectionId, giftId: { in: giftIds } },
    })
    return existing
  },
}
