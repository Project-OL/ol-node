import { prisma, prismaRead } from "../config/database";

export const giftGalleryRepository = {
  async findByHostYearMonth(hostUserId: string, year: number, month: number) {
    return prismaRead.giftGallery.findUnique({
      where: {
        hostUserId_year_month: { hostUserId, year, month },
      },
      include: {
        sections: {
          orderBy: { sortOrder: "asc" },
          include: {
            gifts: {
              orderBy: { sortOrder: "asc" },
              include: {
                gift: true,
              },
            },
          },
        },
        progress: {
          include: {
            firstGifter: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });
  },

  async countProgressForGallery(galleryId: string) {
    return prismaRead.giftGalleryProgress.count({
      where: { galleryId },
    });
  },

  async countSectionItemsForGallery(galleryId: string) {
    return prismaRead.giftGallerySectionItem.count({
      where: { section: { galleryId } },
    });
  },

  /**
   * Whether `giftId` appears in any section of this host's gallery for year/month.
   */
  async isGiftInGallery(
    hostUserId: string,
    year: number,
    month: number,
    giftId: string,
  ): Promise<{ galleryId: string } | null> {
    const row = await prismaRead.giftGallerySectionItem.findFirst({
      where: {
        giftId,
        section: {
          gallery: { hostUserId, year, month },
        },
      },
      select: {
        section: { select: { galleryId: true } },
      },
    });
    if (!row) return null;
    return { galleryId: row.section.galleryId };
  },

  async replaceGallerySections(params: {
    hostUserId: string;
    year: number;
    month: number;
    sections: Array<{ title: string; sortOrder: number; giftIds: string[] }>;
  }) {
    return prisma.$transaction(
      async (tx) => {
        const gallery = await tx.giftGallery.upsert({
          where: {
            hostUserId_year_month: {
              hostUserId: params.hostUserId,
              year: params.year,
              month: params.month,
            },
          },
          create: {
            hostUserId: params.hostUserId,
            year: params.year,
            month: params.month,
          },
          update: {},
        });

        await tx.giftGallerySection.deleteMany({
          where: { galleryId: gallery.id },
        });

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
          });
        }

        return gallery.id;
      },
      { isolationLevel: "Serializable" },
    );
  },
};
