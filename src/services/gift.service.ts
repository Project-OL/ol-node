import { redisClient, RedisKeys } from '../config/redis'
import { GIFT_LIST_CACHE_TTL } from '../config/redis'
import { giftRepository, type GiftWithTags } from '../repositories/gift.repository'
import { AppError } from '../middlewares/errorHandler'
import { giftGalleryService } from './gift-gallery.service'

async function invalidateGiftCaches(affectedTags: string[]) {
  try {
    await redisClient.del(RedisKeys.giftList())
    for (const tag of affectedTags) {
      await redisClient.del(RedisKeys.giftByTag(tag))
    }
    await giftGalleryService.invalidateActiveMonthCaches()
  } catch {
    // best-effort
  }
}

async function invalidateAllGiftListCaches() {
  try {
    await redisClient.del(RedisKeys.giftList())
    const pattern = 'gifts:tag:*'
    let cursor = '0'
    do {
      const [next, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      cursor = next
      if (keys.length > 0) {
        await redisClient.del(...keys)
      }
    } while (cursor !== '0')
    await giftGalleryService.invalidateActiveMonthCaches()
  } catch {
    // best-effort
  }
}

export const giftService = {
  async listPublic(query: { tag?: string; page: number; limit: number }) {
    const skip = (query.page - 1) * query.limit
    const cacheKey = query.tag ? RedisKeys.giftByTag(query.tag) : RedisKeys.giftList()

    try {
      const raw = await redisClient.get(cacheKey)
      if (raw) {
        return JSON.parse(raw) as {
          items: unknown[]
          total: number
          page: number
          limit: number
        }
      }
    } catch {
      // cold path
    }

    const { items, total } = await giftRepository.listActivePaged({
      tag: query.tag,
      skip,
      take: query.limit,
    })

    const payload = {
      items: items.map((g: GiftWithTags) => ({
        id: g.id,
        name: g.name,
        code: g.code,
        coinCost: g.coinCost,
        displayImageUrl: g.displayImageUrl,
        effectUrl: g.effectUrl,
        displayOrder: g.displayOrder,
        vipOnly: g.vipOnly,
        tags: g.tags.map((t: { tag: string }) => t.tag),
      })),
      total,
      page: query.page,
      limit: query.limit,
    }

    try {
      await redisClient.set(cacheKey, JSON.stringify(payload), 'EX', GIFT_LIST_CACHE_TTL)
    } catch {
      // ignore
    }

    return payload
  },

  async create(input: {
    name: string
    coinCost: number
    displayImageUrl: string
    effectUrl?: string
    tags?: string[]
  }) {
    const tags = input.tags ?? []
    const g = await giftRepository.createWithTags({
      name: input.name,
      coinCost: input.coinCost,
      displayImageUrl: input.displayImageUrl,
      effectUrl: input.effectUrl ?? null,
      tags,
    })
    await invalidateGiftCaches(tags)
    return g
  },

  async patch(
    giftId: string,
    input: {
      name?: string
      coinCost?: number
      displayImageUrl?: string
      effectUrl?: string | null
      isActive?: boolean
      tags?: string[]
    },
  ) {
    const existing = await giftRepository.findById(giftId)
    if (!existing) throw new AppError(404, 'Gift not found', 'NOT_FOUND')

    const oldTags = existing.tags.map((t: { tag: string }) => t.tag)
    const g = await giftRepository.updateWithTags(giftId, input)
    const newTags = input.tags ?? oldTags
    await invalidateGiftCaches([...new Set([...oldTags, ...newTags])])
    return g
  },

  async softDelete(giftId: string) {
    const existing = await giftRepository.findById(giftId)
    if (!existing) throw new AppError(404, 'Gift not found', 'NOT_FOUND')
    const g = await giftRepository.softDelete(giftId)
    await invalidateGiftCaches(existing.tags.map((t: { tag: string }) => t.tag))
    return g
  },

  async invalidateCachesForGift(g: GiftWithTags) {
    await invalidateGiftCaches(g.tags.map((t) => t.tag))
  },

  async invalidateAllGiftCaches() {
    await invalidateAllGiftListCaches()
  },
}
