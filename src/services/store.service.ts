import { Prisma, StoreItemCategory } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import {
  RedisKeys,
  STORE_CATALOG_TTL,
  STORE_ITEM_TTL,
  STORE_RARE_IDS_TTL,
  USER_ACTIVE_STORE_TTL,
  USER_STORE_ITEMS_TTL,
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { cacheRedisService } from './cacheRedis.service'
import { storeRepository } from '../repositories/store.repository'
import { followRepository } from '../repositories/follow.repository'
import { coinWalletService } from './coin-wallet.service'
import { walletService } from './wallet.service'
import { enqueueStoreItemExpiry } from '../queues/store-item-expiry.queue'
import type { ActiveStoreItemsMap } from '../models/store.types'

const TX_TIMEOUT_MS = 20_000
const DEFAULT_RARE_ID_VALIDITY_DAYS = 15

type StoreItemSummary = {
  id: string
  name: string
  category: StoreItemCategory
  coinCost: number
  validityDays: number
  displayImageUrl: string
  effectUrl: string | null
}

function toStoreSummary(row: {
  id: string
  name: string
  category: StoreItemCategory
  coinCost: number
  validityDays: number
  displayImageUrl: string
  effectUrl: string | null
}): StoreItemSummary {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    coinCost: row.coinCost,
    validityDays: row.validityDays,
    displayImageUrl: row.displayImageUrl,
    effectUrl: row.effectUrl,
  }
}

function buildEmptyActiveMap(): ActiveStoreItemsMap {
  return {
    RIDE: null,
    AVATAR_FRAME: null,
    CHAT_BUBBLE: null,
    PROFILE_CARD: null,
    rareId: null,
  }
}

export const storeService = {
  async getCatalog(category?: StoreItemCategory): Promise<
    | { categories: Record<StoreItemCategory, StoreItemSummary[]> }
    | { category: StoreItemCategory; items: StoreItemSummary[] }
  > {
    const key = RedisKeys.storeCatalog(category)
    const cached = await cacheRedisService.get<
      | { categories: Record<StoreItemCategory, StoreItemSummary[]> }
      | { category: StoreItemCategory; items: StoreItemSummary[] }
    >(key)
    if (cached) return cached

    const rows = await storeRepository.findAllItems(category)
    if (category) {
      const payload = { category, items: rows.map(toStoreSummary) }
      await cacheRedisService.set(key, payload, STORE_CATALOG_TTL)
      return payload
    }

    const grouped: Record<StoreItemCategory, StoreItemSummary[]> = {
      RIDE: [],
      AVATAR_FRAME: [],
      CHAT_BUBBLE: [],
      PROFILE_CARD: [],
    }
    for (const row of rows) grouped[row.category].push(toStoreSummary(row))
    const payload = { categories: grouped }
    await cacheRedisService.set(key, payload, STORE_CATALOG_TTL)
    return payload
  },

  async getItemDetail(itemId: string): Promise<StoreItemSummary> {
    const key = RedisKeys.storeItem(itemId)
    const cached = await cacheRedisService.get<StoreItemSummary>(key)
    if (cached) return cached

    const item = await storeRepository.findItemById(itemId)
    if (!item || !item.isActive) {
      throw new AppError(404, 'Store item not found', 'STORE_ITEM_NOT_FOUND')
    }
    const payload = toStoreSummary(item)
    await cacheRedisService.set(key, payload, STORE_ITEM_TTL)
    return payload
  },

  async getRareIds(cursor?: string, limit = 20): Promise<{ items: Array<{ publicId: string; priceCredits: number; rarityScore: number }>; nextCursor: string | null }> {
    const key = RedisKeys.storeRareIds()
    if (!cursor) {
      const cached = await cacheRedisService.get<{ items: Array<{ publicId: string; priceCredits: number; rarityScore: number }>; nextCursor: string | null }>(key)
      if (cached) return cached
    }
    const safeLimit = Math.max(1, Math.min(limit, 100))
    const rows = await storeRepository.findAvailableRareIds({ cursor, limit: safeLimit + 1 })
    const hasMore = rows.length > safeLimit
    const page = hasMore ? rows.slice(0, safeLimit) : rows
    const payload = {
      items: page.map((row) => ({
        publicId: row.publicId.toString(),
        priceCredits: row.priceCredits ?? 0,
        rarityScore: row.rarityScore,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.publicId.toString() : null,
    }
    if (!cursor) await cacheRedisService.set(key, payload, STORE_RARE_IDS_TTL)
    return payload
  },

  async purchaseItem(params: {
    buyerId: string
    storeItemId: string
    recipientId: string
    idempotencyKey: string
  }): Promise<{
    userStoreItemId: string
    storeItemId: string
    recipientId: string
    purchasedById: string
    coinsPaid: number
    expiresAt: string
    isGift: boolean
    isApplied: boolean
  }> {
    const isGift = params.recipientId !== params.buyerId
    const item = await storeRepository.findItemById(params.storeItemId)
    if (!item || !item.isActive) {
      throw new AppError(404, 'Store item not found', 'STORE_ITEM_NOT_FOUND')
    }
    if (isGift) {
      const [aToB, bToA] = await Promise.all([
        followRepository.existsFollow(params.buyerId, params.recipientId),
        followRepository.existsFollow(params.recipientId, params.buyerId),
      ])
      if (!aToB && !bToA) {
        throw new AppError(403, 'Gifting requires follower/following relation', 'GIFT_NOT_ALLOWED')
      }
    }

    const expiresAt = new Date(Date.now() + item.validityDays * 24 * 60 * 60 * 1000)
    const created = await prisma.$transaction(
      async (tx) => {
        await coinWalletService.debitForStoreItemPurchase(
          params.buyerId,
          BigInt(item.coinCost),
          {
            recipientId: params.recipientId,
            storeItemId: item.id,
            idempotencyKey: params.idempotencyKey,
          },
          tx,
        )
        const row = await tx.userStoreItem.create({
          data: {
            userId: params.recipientId,
            storeItemId: item.id,
            purchasedById: params.buyerId,
            coinsPaid: item.coinCost,
            expiresAt,
            isApplied: false,
            idempotencyKey: params.idempotencyKey,
          },
        })

        if (!isGift) {
          const existingActive = await tx.userActiveStoreItems.findUnique({
            where: {
              userId_category: {
                userId: params.recipientId,
                category: item.category,
              },
            },
          })
          if (existingActive?.userStoreItemId) {
            await tx.userStoreItem.updateMany({
              where: { id: existingActive.userStoreItemId, userId: params.recipientId },
              data: { isApplied: false },
            })
          }
          await tx.userStoreItem.update({
            where: { id: row.id },
            data: { isApplied: true, activatedAt: new Date() },
          })
          await tx.userActiveStoreItems.upsert({
            where: {
              userId_category: { userId: params.recipientId, category: item.category },
            },
            create: {
              userId: params.recipientId,
              category: item.category,
              userStoreItemId: row.id,
            },
            update: { userStoreItemId: row.id },
          })
        }
        return row
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: TX_TIMEOUT_MS },
    )

    await walletService.adjustCoinBalanceCache(params.buyerId, BigInt(item.coinCost))
    await enqueueStoreItemExpiry(created.id, expiresAt)
    await cacheRedisService.del(
      RedisKeys.userActiveStore(params.recipientId),
      RedisKeys.userStoreItems(params.recipientId),
      RedisKeys.userStoreItems(params.buyerId),
      RedisKeys.storeCatalog(),
      RedisKeys.storeCatalog(item.category),
    )

    return {
      userStoreItemId: created.id,
      storeItemId: created.storeItemId,
      recipientId: created.userId,
      purchasedById: created.purchasedById,
      coinsPaid: created.coinsPaid,
      expiresAt: created.expiresAt.toISOString(),
      isGift,
      isApplied: !isGift,
    }
  },

  async purchaseRareId(params: {
    buyerId: string
    publicId: bigint
    recipientId: string
    idempotencyKey: string
  }): Promise<{ publicId: string; recipientId: string; purchasedById: string; expiresAt: string; isGift: boolean }> {
    const row = await prismaRead.vipPublicId.findUnique({ where: { publicId: params.publicId } })
    if (!row || !row.isAvailable || row.priceCredits == null) {
      throw new AppError(404, 'Rare ID not available', 'RARE_ID_NOT_AVAILABLE')
    }
    const isGift = params.recipientId !== params.buyerId
    if (isGift) {
      const [aToB, bToA] = await Promise.all([
        followRepository.existsFollow(params.buyerId, params.recipientId),
        followRepository.existsFollow(params.recipientId, params.buyerId),
      ])
      if (!aToB && !bToA) {
        throw new AppError(403, 'Gifting requires follower/following relation', 'GIFT_NOT_ALLOWED')
      }
    }

    const existing = await prismaRead.userVipAssignment.findFirst({
      where: {
        userId: params.recipientId,
        publicId: params.publicId,
        isActive: true,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    })
    if (existing) {
      throw new AppError(409, 'Recipient already has this rare ID', 'RARE_ID_ALREADY_OWNED')
    }

    const expiresAt = new Date(Date.now() + DEFAULT_RARE_ID_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
    await prisma.$transaction(
      async (tx) => {
        await coinWalletService.debitForVipPurchase(
          params.buyerId,
          BigInt(row.priceCredits!),
          {
            recipientId: params.recipientId,
            publicId: params.publicId.toString(),
            idempotencyKey: params.idempotencyKey,
          },
          tx,
        )
        const locked = await tx.vipPublicId.findUnique({ where: { publicId: params.publicId } })
        if (!locked || !locked.isAvailable) {
          throw new AppError(409, 'Rare ID no longer available', 'RARE_ID_NOT_AVAILABLE')
        }
        await tx.vipPublicId.update({
          where: { publicId: params.publicId },
          data: {
            isAvailable: false,
            currentOwnerId: params.recipientId,
            purchasedAt: new Date(),
            expiresAt,
          },
        })
        await tx.userVipAssignment.create({
          data: {
            userId: params.recipientId,
            publicId: params.publicId,
            startsAt: new Date(),
            expiresAt,
            isActive: true,
          },
        })
        if (!isGift) {
          await tx.user.update({
            where: { id: params.recipientId },
            data: {
              currentVipPublicId: params.publicId,
              vipPublicIdExpiresAt: expiresAt,
              vipPurchaseAt: new Date(),
            },
          })
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: TX_TIMEOUT_MS },
    )

    await walletService.adjustCoinBalanceCache(params.buyerId, BigInt(row.priceCredits!))
    await cacheRedisService.del(
      RedisKeys.storeRareIds(),
      RedisKeys.userActiveStore(params.recipientId),
      RedisKeys.userStoreItems(params.recipientId),
    )

    return {
      publicId: params.publicId.toString(),
      recipientId: params.recipientId,
      purchasedById: params.buyerId,
      expiresAt: expiresAt.toISOString(),
      isGift,
    }
  },

  async activateOwnedItem(userId: string, userStoreItemId: string): Promise<void> {
    const owned = await storeRepository.findUserStoreItemById(userStoreItemId)
    if (!owned || owned.userId !== userId) {
      throw new AppError(404, 'Store item ownership not found', 'STORE_ITEM_NOT_OWNED')
    }
    if (!owned.isActive || owned.revokedAt) {
      throw new AppError(400, 'Store item is inactive', 'STORE_ITEM_INACTIVE')
    }
    if (owned.expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, 'Store item has expired', 'STORE_ITEM_EXPIRED')
    }
    await storeRepository.activateItem(userId, userStoreItemId, owned.storeItem.category)
    await cacheRedisService.del(RedisKeys.userActiveStore(userId), RedisKeys.userStoreItems(userId))
  },

  async listOwnedItems(
    userId: string,
    opts: { category?: StoreItemCategory; isActive?: boolean; cursor?: string; limit?: number },
  ): Promise<{ items: Array<{ userStoreItemId: string; isApplied: boolean; isActive: boolean; expiresAt: string; purchasedById: string; coinsPaid: number; item: StoreItemSummary }>; nextCursor: string | null }> {
    const safeLimit = Math.max(1, Math.min(opts.limit ?? 20, 50))
    const cacheKey = !opts.cursor
      ? `${RedisKeys.userStoreItems(userId)}:${opts.category ?? 'ALL'}:${opts.isActive ?? 'ALL'}:${safeLimit}`
      : null
    if (cacheKey) {
      const cached = await cacheRedisService.get<{ items: Array<{ userStoreItemId: string; isApplied: boolean; isActive: boolean; expiresAt: string; purchasedById: string; coinsPaid: number; item: StoreItemSummary }>; nextCursor: string | null }>(cacheKey)
      if (cached) return cached
    }
    const rows = await storeRepository.findOwnedItems(userId, {
      category: opts.category,
      isActive: opts.isActive,
      cursor: opts.cursor,
      limit: safeLimit + 1,
    })
    const hasMore = rows.length > safeLimit
    const page = hasMore ? rows.slice(0, safeLimit) : rows
    const payload = {
      items: page.map((row) => ({
        userStoreItemId: row.id,
        isApplied: row.isApplied,
        isActive: row.isActive,
        expiresAt: row.expiresAt.toISOString(),
        purchasedById: row.purchasedById,
        coinsPaid: row.coinsPaid,
        item: toStoreSummary(row.storeItem),
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    }
    if (cacheKey) await cacheRedisService.set(cacheKey, payload, USER_STORE_ITEMS_TTL)
    return payload
  },

  async getActiveItemsForUser(userId: string): Promise<ActiveStoreItemsMap> {
    const key = RedisKeys.userActiveStore(userId)
    const cached = await cacheRedisService.get<ActiveStoreItemsMap>(key)
    if (cached) return cached

    const [activeRows, user] = await Promise.all([
      prismaRead.userActiveStoreItems.findMany({
        where: { userId },
        include: {
          userStoreItem: { include: { storeItem: true } },
        },
      }),
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { currentVipPublicId: true, vipPublicIdExpiresAt: true },
      }),
    ])

    const map = buildEmptyActiveMap()
    for (const row of activeRows) {
      const owned = row.userStoreItem
      if (!owned || !owned.isActive || !owned.isApplied || owned.expiresAt.getTime() <= Date.now()) {
        continue
      }
      map[row.category] = {
        userStoreItemId: owned.id,
        itemId: owned.storeItem.id,
        name: owned.storeItem.name,
        displayImageUrl: owned.storeItem.displayImageUrl,
        effectUrl: owned.storeItem.effectUrl,
        expiresAt: owned.expiresAt.toISOString(),
      }
    }
    if (user?.currentVipPublicId && user.vipPublicIdExpiresAt && user.vipPublicIdExpiresAt > new Date()) {
      map.rareId = user.currentVipPublicId.toString()
    }
    await cacheRedisService.set(key, map, USER_ACTIVE_STORE_TTL)
    return map
  },

  async processExpiryJob(userStoreItemId: string): Promise<void> {
    const result = await storeRepository.expireItem(userStoreItemId)
    if (!result) return
    await cacheRedisService.del(RedisKeys.userActiveStore(result.userId), RedisKeys.userStoreItems(result.userId))
  },

  async createStoreItem(data: {
    name: string
    description?: string
    category: StoreItemCategory
    coinCost: number
    validityDays?: number
    displayImageUrl: string
    effectUrl?: string | null
    sortOrder?: number
  }) {
    const created = await prisma.storeItem.create({ data })
    await cacheRedisService.del(RedisKeys.storeCatalog(), RedisKeys.storeCatalog(created.category))
    return created
  },

  async updateStoreItem(
    id: string,
    data: {
      name?: string
      coinCost?: number
      isActive?: boolean
      sortOrder?: number
      effectUrl?: string | null
    },
  ) {
    const existing = await prisma.storeItem.findUnique({ where: { id } })
    if (!existing) throw new AppError(404, 'Store item not found', 'STORE_ITEM_NOT_FOUND')
    const updated = await prisma.storeItem.update({ where: { id }, data })
    await cacheRedisService.del(
      RedisKeys.storeCatalog(),
      RedisKeys.storeCatalog(updated.category),
      RedisKeys.storeItem(updated.id),
    )
    return updated
  },

  async softDeleteStoreItem(id: string): Promise<void> {
    const existing = await prisma.storeItem.findUnique({ where: { id } })
    if (!existing) throw new AppError(404, 'Store item not found', 'STORE_ITEM_NOT_FOUND')
    await prisma.storeItem.update({ where: { id }, data: { isActive: false } })
    await cacheRedisService.del(
      RedisKeys.storeCatalog(),
      RedisKeys.storeCatalog(existing.category),
      RedisKeys.storeItem(existing.id),
    )
  },
}
