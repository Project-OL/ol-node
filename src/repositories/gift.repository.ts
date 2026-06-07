import { prisma, prismaRead } from '../config/database'
import { Prisma } from '@prisma/client'

export type GiftWithTags = Prisma.GiftGetPayload<{ include: { tags: true } }>

export const giftRepository = {
  async findById(id: string): Promise<GiftWithTags | null> {
    return prismaRead.gift.findUnique({
      where: { id },
      include: { tags: true },
    })
  },

  async listActivePaged(params: {
    tag?: string
    skip: number
    take: number
  }): Promise<{ items: GiftWithTags[]; total: number }> {
    const where: Prisma.GiftWhereInput = {
      isActive: true,
      ...(params.tag ? { tags: { some: { tag: params.tag } } } : {}),
    }

    const [items, total] = await Promise.all([
      prismaRead.gift.findMany({
        where,
        include: { tags: true },
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      prismaRead.gift.count({ where }),
    ])

    return { items, total }
  },

  async createWithTags(data: {
    name: string
    coinCost: number
    displayImageUrl: string
    effectUrl?: string | null
    tags: string[]
  }) {
    return prisma.gift.create({
      data: {
        name: data.name,
        coinCost: data.coinCost,
        displayImageUrl: data.displayImageUrl,
        effectUrl: data.effectUrl ?? null,
        tags: {
          create: data.tags.map((tag) => ({ tag })),
        },
      },
      include: { tags: true },
    })
  },

  async updateWithTags(
    id: string,
    data: {
      name?: string
      coinCost?: number
      displayImageUrl?: string
      effectUrl?: string | null
      isActive?: boolean
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
          ...(data.coinCost !== undefined ? { coinCost: data.coinCost } : {}),
          ...(data.displayImageUrl !== undefined ? { displayImageUrl: data.displayImageUrl } : {}),
          ...(data.effectUrl !== undefined ? { effectUrl: data.effectUrl } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          ...(data.tags
            ? {
                tags: {
                  create: data.tags.map((tag) => ({ tag })),
                },
              }
            : {}),
        },
        include: { tags: true },
      })
    })
  },

  async softDelete(id: string) {
    return prisma.gift.update({
      where: { id },
      data: { isActive: false },
      include: { tags: true },
    })
  },

  async assertAllActiveGiftIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const distinct = [...new Set(ids)]
    const count = await prismaRead.gift.count({
      where: { id: { in: distinct }, isActive: true },
    })
    if (count !== distinct.length) {
      throw new Error('INVALID_GIFT_IDS')
    }
  },
}
