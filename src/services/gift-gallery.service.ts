import { redisClient, RedisKeys, GALLERY_HOST_TTL, GALLERY_TEMPLATE_TTL } from '../config/redis'
import { giftGalleryRepository } from '../repositories/gift-gallery.repository'
import { giftRepository } from '../repositories/gift.repository'
import { AppError } from '../middlewares/errorHandler'
import { getActivePeriod, getMonthEndIso } from '../utils/galleryPeriod'
import type { GlobalGalleryWithSections } from '../repositories/gift-gallery.repository'

export type GalleryResponse = {
  galleryId: string | null
  hostUserId: string
  year: number
  month: number
  monthEndAt: string
  secondsRemaining: number
  isFullGallery: boolean
  receivedItems: number
  totalItems: number
  sections: Array<{
    id: string
    name: string
    sortOrder: number
    totalGifts: number
    receivedGifts: number
    gifts: Array<{
      itemId: string
      giftId: string
      name: string
      imageUrl: string
      coinCost: number
      received: boolean
      receivedAt: string | null
      firstGifter: {
        userId: string
        publicId: string
        username: string
        firstName: string | null
        lastName: string | null
        avatarUrl: string | null
      } | null
    }>
  }>
}

export type GalleryCompletionSummary = {
  isFullGallery: boolean
  receivedItems: number
  totalItems: number
  monthEndAt: string
  secondsRemaining: number
}

export type GiftGalleryCheckItem = {
  itemId: string
  giftId: string
  name: string
  imageUrl: string
  coinCost: number
  receivedAt: string | null
  firstSender: {
    userId: string
    publicId: string
    avatarUrl: string | null
  } | null
}

function firstGifterDto(p: {
  firstGifter: {
    id: string
    publicId: bigint
    username: string
    firstName: string | null
    lastName: string | null
    avatarUrl: string | null
  }
}) {
  return {
    userId: p.firstGifter.id,
    publicId: p.firstGifter.publicId.toString(),
    username: p.firstGifter.username,
    firstName: p.firstGifter.firstName,
    lastName: p.firstGifter.lastName,
    avatarUrl: p.firstGifter.avatarUrl,
  }
}

function buildMergedResponse(
  hostUserId: string,
  gallery: GlobalGalleryWithSections,
  progressRows: Awaited<ReturnType<typeof giftGalleryRepository.findHostProgress>>,
  monthEndAt: string,
  secondsRemaining: number,
): GalleryResponse {
  const progressByItemId = new Map(
    progressRows.map((p) => [
      p.giftGallerySectionItemId,
      {
        receivedAt: p.receivedAt.toISOString(),
        firstGifter: firstGifterDto(p),
      },
    ]),
  )

  let totalItems = 0
  const sections = gallery.sections.map((s) => {
    const gifts = s.gifts.map((gi) => {
      totalItems += 1
      const prog = progressByItemId.get(gi.id)
      return {
        itemId: gi.id,
        giftId: gi.gift.id,
        name: gi.gift.name,
        imageUrl: gi.gift.displayImageUrl,
        coinCost: gi.gift.coinCost,
        received: !!prog,
        receivedAt: prog?.receivedAt ?? null,
        firstGifter: prog?.firstGifter ?? null,
      }
    })
    const receivedGifts = gifts.filter((x) => x.received).length
    return {
      id: s.id,
      name: s.title,
      sortOrder: s.sortOrder,
      totalGifts: gifts.length,
      receivedGifts,
      gifts,
    }
  })

  const receivedItems = progressRows.length
  const isFullGallery = totalItems > 0 && receivedItems >= totalItems

  return {
    galleryId: gallery.id,
    hostUserId,
    year: gallery.year,
    month: gallery.month,
    monthEndAt,
    secondsRemaining,
    isFullGallery,
    receivedItems,
    totalItems,
    sections,
  }
}

async function loadGlobalGalleryForCache(
  year: number,
  month: number,
): Promise<GlobalGalleryWithSections | null> {
  const templateKey = RedisKeys.giftGalleryTemplate(year, month)
  try {
    const raw = await redisClient.get(templateKey)
    if (raw) {
      return JSON.parse(raw) as GlobalGalleryWithSections
    }
  } catch {
    // fall through
  }

  const gallery = await giftGalleryRepository.findGlobalGallery(year, month)
  if (gallery) {
    try {
      await redisClient.set(templateKey, JSON.stringify(gallery), 'EX', GALLERY_TEMPLATE_TTL)
    } catch {
      // ignore
    }
  }
  return gallery
}

export const giftGalleryService = {
  async upsertGallery(params: {
    year: number
    month: number
    sections: Array<{ title: string; sortOrder: number; giftIds: string[] }>
  }) {
    const allIds = params.sections.flatMap((s) => s.giftIds)
    try {
      await giftRepository.assertAllActiveGiftIds(allIds)
    } catch {
      throw new AppError(400, 'One or more gifts are missing or inactive', 'INVALID_GIFT_IDS')
    }

    const gallery = await giftGalleryRepository.upsertGlobalGallery({
      year: params.year,
      month: params.month,
      sections: params.sections,
    })

    try {
      await redisClient.del(RedisKeys.giftGalleryTemplate(params.year, params.month))
    } catch {
      // ignore
    }

    return gallery
  },

  async getGalleryForHost(hostUserId: string): Promise<GalleryResponse> {
    const { year, month, secondsRemaining } = getActivePeriod()
    const monthEndAt = getMonthEndIso()
    const hostKey = RedisKeys.giftGalleryHost(hostUserId, year, month)

    try {
      const raw = await redisClient.get(hostKey)
      if (raw) {
        return JSON.parse(raw) as GalleryResponse
      }
    } catch {
      // cold path
    }

    const gallery = await loadGlobalGalleryForCache(year, month)

    if (!gallery) {
      const empty: GalleryResponse = {
        galleryId: null,
        hostUserId,
        year,
        month,
        monthEndAt,
        secondsRemaining,
        isFullGallery: false,
        receivedItems: 0,
        totalItems: 0,
        sections: [],
      }
      try {
        await redisClient.set(hostKey, JSON.stringify(empty), 'EX', GALLERY_HOST_TTL)
      } catch {
        // ignore
      }
      return empty
    }

    const progressRows = await giftGalleryRepository.findHostProgress(gallery.id, hostUserId)
    const payload = buildMergedResponse(
      hostUserId,
      gallery,
      progressRows,
      monthEndAt,
      secondsRemaining,
    )
    try {
      await redisClient.set(hostKey, JSON.stringify(payload), 'EX', GALLERY_HOST_TTL)
    } catch {
      // ignore
    }
    return payload
  },

  async checkIsFull(hostUserId: string): Promise<{
    isFullGallery: boolean
    secondsRemaining: number
    receivedGifts: GiftGalleryCheckItem[]
    remainingGifts: GiftGalleryCheckItem[]
  }> {
    const full = await this.getGalleryForHost(hostUserId)
    const all = full.sections.flatMap((s) => s.gifts)
    const toItem = (g: (typeof all)[number]): GiftGalleryCheckItem => ({
      itemId: g.itemId,
      giftId: g.giftId,
      name: g.name,
      imageUrl: g.imageUrl,
      coinCost: g.coinCost,
      receivedAt: g.receivedAt,
      firstSender: g.firstGifter
        ? {
            userId: g.firstGifter.userId,
            publicId: g.firstGifter.publicId,
            avatarUrl: g.firstGifter.avatarUrl,
          }
        : null,
    })
    return {
      isFullGallery: full.isFullGallery,
      secondsRemaining: full.secondsRemaining,
      receivedGifts: all.filter((g) => g.received).map(toItem),
      remainingGifts: all.filter((g) => !g.received).map(toItem),
    }
  },

  async getCompletionSummaryForUser(hostUserId: string): Promise<GalleryCompletionSummary> {
    const { year, month, secondsRemaining } = getActivePeriod()
    const monthEndAt = getMonthEndIso()
    const hostKey = RedisKeys.giftGalleryHost(hostUserId, year, month)
    try {
      const raw = await redisClient.get(hostKey)
      if (raw) {
        const p = JSON.parse(raw) as GalleryResponse
        if (
          typeof p.receivedItems === 'number' &&
          typeof p.totalItems === 'number' &&
          typeof p.isFullGallery === 'boolean'
        ) {
          return {
            isFullGallery: p.isFullGallery,
            receivedItems: p.receivedItems,
            totalItems: p.totalItems,
            monthEndAt,
            secondsRemaining,
          }
        }
      }
    } catch {
      // fall through
    }

    const gallery = await giftGalleryRepository.findGlobalGallery(year, month)
    if (!gallery) {
      return {
        isFullGallery: false,
        receivedItems: 0,
        totalItems: 0,
        monthEndAt,
        secondsRemaining,
      }
    }
    const s = await giftGalleryRepository.getHostCompletionSummary(gallery.id, hostUserId)
    return {
      isFullGallery: s.isFullGallery,
      receivedItems: s.receivedItems,
      totalItems: s.totalItems,
      monthEndAt,
      secondsRemaining,
    }
  },

  async recordGiftProgress(params: {
    hostUserId: string
    giftId: string
    senderId: string
  }): Promise<{ created: boolean; galleryNowFull: boolean }> {
    const { year, month } = getActivePeriod()
    const gallery = await giftGalleryRepository.findGlobalGallery(year, month)
    if (!gallery) {
      return { created: false, galleryNowFull: false }
    }

    const item = await giftGalleryRepository.findSectionItemForGalleryGift(
      gallery.id,
      params.giftId,
    )
    if (!item) {
      return { created: false, galleryNowFull: false }
    }

    const { created } = await giftGalleryRepository.upsertProgress({
      galleryId: gallery.id,
      hostUserId: params.hostUserId,
      giftId: params.giftId,
      giftGallerySectionItemId: item.id,
      firstGifterId: params.senderId,
    })

    let galleryNowFull = false
    if (created) {
      try {
        await redisClient.del(RedisKeys.giftGalleryHost(params.hostUserId, year, month))
      } catch {
        // ignore
      }
      const s = await giftGalleryRepository.getHostCompletionSummary(gallery.id, params.hostUserId)
      galleryNowFull = s.isFullGallery
    }

    return { created, galleryNowFull }
  },

  /** Invalidate merged host gallery cache (e.g. after admin template change is rare; gift send uses recordGiftProgress). */
  async invalidateHostMonthCache(hostUserId: string, year: number, month: number): Promise<void> {
    try {
      await redisClient.del(RedisKeys.giftGalleryHost(hostUserId, year, month))
    } catch {
      // ignore
    }
  },
}
