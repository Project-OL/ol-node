import { prisma, prismaRead } from '../config/database'
import type { GiftGallery, Prisma } from '@prisma/client'

const globalGalleryInclude = {
  sections: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      gifts: {
        orderBy: { sortOrder: 'asc' as const },
        where: { gift: { isActive: true } },
        include: { gift: true },
      },
    },
  },
} as const

export type GlobalGalleryWithSections = Prisma.GiftGalleryGetPayload<{
  include: typeof globalGalleryInclude
}>

export const giftGalleryRepository = {
  async findGlobalGallery(year: number, month: number): Promise<GlobalGalleryWithSections | null> {
    return prismaRead.giftGallery.findUnique({
      where: { year_month: { year, month } },
      include: globalGalleryInclude,
    })
  },

  async findHostProgress(galleryId: string, hostUserId: string) {
    return prismaRead.giftGalleryProgress.findMany({
      where: { galleryId, hostUserId },
      include: {
        firstGifter: {
          select: {
            id: true,
            publicId: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      },
    })
  },

  async findSectionItemForGalleryGift(
    galleryId: string,
    giftId: string,
  ): Promise<{ id: string } | null> {
    const row = await prismaRead.giftGallerySectionItem.findFirst({
      where: {
        giftId,
        section: { galleryId },
      },
      select: { id: true },
    })
    return row
  },

  async getHostCompletionSummary(
    galleryId: string,
    hostUserId: string,
  ): Promise<{ totalItems: number; receivedItems: number; isFullGallery: boolean }> {
    const [totalItems, receivedItems] = await Promise.all([
      prismaRead.giftGallerySectionItem.count({
        where: { section: { galleryId } },
      }),
      prismaRead.giftGalleryProgress.count({
        where: { galleryId, hostUserId },
      }),
    ])
    const isFullGallery = totalItems > 0 && receivedItems >= totalItems
    return { totalItems, receivedItems, isFullGallery }
  },

  /**
   * Insert progress if missing. First gifter wins; returns whether a new row was inserted.
   */
  async upsertProgress(params: {
    galleryId: string
    hostUserId: string
    giftId: string
    giftGallerySectionItemId: string
    firstGifterId: string
  }): Promise<{ created: boolean }> {
    return prisma.$transaction(
      async (tx) => {
        const existing = await tx.giftGalleryProgress.findUnique({
          where: {
            hostUserId_giftGallerySectionItemId: {
              hostUserId: params.hostUserId,
              giftGallerySectionItemId: params.giftGallerySectionItemId,
            },
          },
        })
        if (existing) {
          return { created: false }
        }
        await tx.giftGalleryProgress.create({
          data: {
            galleryId: params.galleryId,
            hostUserId: params.hostUserId,
            giftId: params.giftId,
            giftGallerySectionItemId: params.giftGallerySectionItemId,
            firstGifterId: params.firstGifterId,
          },
        })
        return { created: true }
      },
      { isolationLevel: 'Serializable' },
    )
  },

  async upsertGlobalGallery(params: {
    year: number
    month: number
    sections: Array<{ title: string; sortOrder: number; giftIds: string[] }>
  }): Promise<GiftGallery> {
    return prisma.$transaction(
      async (tx) => {
        const gallery = await tx.giftGallery.upsert({
          where: { year_month: { year: params.year, month: params.month } },
          create: { year: params.year, month: params.month },
          update: {},
        })

        await tx.giftGallerySection.deleteMany({
          where: { galleryId: gallery.id },
        })

        for (const s of params.sections) {
          await tx.giftGallerySection.create({
            data: {
              galleryId: gallery.id,
              title: s.title,
              sortOrder: s.sortOrder,
              gifts: {
                create: s.giftIds.map((giftId, idx) => ({
                  giftId,
                  sortOrder: idx,
                })),
              },
            },
          })
        }

        return gallery
      },
      { isolationLevel: 'Serializable' },
    )
  },
}
