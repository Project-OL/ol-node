import { Prisma, StoreItemCategory, LevelType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import {
  redisClient,
  RedisKeys,
  STORE_CATALOG_TTL,
  STORE_ITEM_TTL,
  STORE_RARE_IDS_TTL,
  USER_ACTIVE_STORE_TTL,
  USER_STORE_ITEMS_TTL,
} from '../config/redis'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import { cacheRedisService } from './cacheRedis.service'
import { lockActiveStoreCategory, storeRepository } from '../repositories/store.repository'
import { vipAssignmentRepository } from '../repositories/vip-assignment.repository'
import { followRepository } from '../repositories/follow.repository'
import { coinWalletService } from './coin-wallet.service'
import { walletService } from './wallet.service'
import { syncLevelCacheFromApplyResult, type LevelApplyResult } from './user-level.service'
import {
  enqueueRareIdAssignmentExpiry,
  enqueueStoreItemExpiry,
} from '../queues/store-item-expiry.queue'
import type { ActiveStoreItemsMap } from '../models/store.types'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'

const TX_TIMEOUT_MS = 20_000

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

export type ListOwnedItemsResponse = {
  items: Array<{
    userStoreItemId: string
    isApplied: boolean
    isActive: boolean
    expiresAt: string
    purchasedById: string
    coinsPaid: number
    item: StoreItemSummary
  }>
  ownedRarePublicIds: Array<{
    assignmentId: string
    publicId: string
    tier: string
    rarityScore: number
    priceCredits: number | null
    matchedRules: string[]
    isActive: boolean
    isEquipped: boolean
    startsAt: string
    expiresAt: string
    revokedAt: string | null
  }>
  nextCursor: string | null
}

async function executePurchaseItem(params: {
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
  let buyerWealthResult: LevelApplyResult | null = null
  // Read Committed + explicit locks (same rationale as gifts/send): the buyer
  // wallet FOR UPDATE serializes the debit, and the (user, category) advisory
  // lock serializes the active-item switch against equip/unequip/expiry.
  // Serializable added no protection and aborted every lock waiter with 40001.
  // The retry wrapper remains as a deadlock safety net.
  const created = await withSerializationRetry(() =>
    prisma.$transaction(
      async (tx) => {
        buyerWealthResult = await coinWalletService.debitForStoreItemPurchase(
          params.buyerId,
          BigInt(item.coinCost),
          {
            recipientId: params.recipientId,
            storeItemId: item.id,
            idempotencyKey: params.idempotencyKey,
            applyWealthXp: true,
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
          await lockActiveStoreCategory(tx, params.recipientId, item.category)
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
      { timeout: TX_TIMEOUT_MS },
    ),
  )

  await walletService.adjustCoinBalanceCache(params.buyerId, BigInt(item.coinCost))
  await syncLevelCacheFromApplyResult(params.buyerId, LevelType.WEALTH, buyerWealthResult)
  await enqueueStoreItemExpiry(created.id, expiresAt)
  await Promise.all([
    cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(params.recipientId)),
    cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(params.buyerId)),
    cacheRedisService.del(
      RedisKeys.userActiveStore(params.recipientId),
      RedisKeys.storeCatalog(),
      RedisKeys.storeCatalog(item.category),
    ),
  ])

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
}

export const storeService = {
  async getCatalog(
    category?: StoreItemCategory,
  ): Promise<
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

  async getRareIds(
    cursor?: string,
    limit = 20,
  ): Promise<{
    items: Array<{ publicId: string; priceCredits: number; rarityScore: number }>
    nextCursor: string | null
  }> {
    const key = RedisKeys.storeRareIds()
    if (!cursor) {
      const cached = await cacheRedisService.get<{
        items: Array<{ publicId: string; priceCredits: number; rarityScore: number }>
        nextCursor: string | null
      }>(key)
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
    // Same idempotency envelope as gifts/send + withdrawal-create: Redis replay
    // window returns the original 201 body for retries; the unique keys on
    // coin_ledger_entries and user_store_items backstop after the TTL (mapped
    // to 409 IDEM_CONFLICT below instead of surfacing a raw P2002 500).
    const idem = `store-purchase:${params.buyerId}:${params.idempotencyKey}`
    const cachedResponse = (await walletService.getCachedIdemResponse(idem)) as Awaited<
      ReturnType<typeof executePurchaseItem>
    > | null
    if (cachedResponse) return cachedResponse

    const acquired = await walletService.acquireIdemKey(idem)
    if (!acquired) {
      throw new AppError(409, 'Already processing', 'IDEM_CONFLICT')
    }

    try {
      const response = await executePurchaseItem(params)
      try {
        await walletService.resolveIdemKey(idem, response)
      } catch {
        // Replay window lost; DB unique keys still prevent double-processing.
      }
      return response
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Settled earlier but the Redis snapshot expired — never double-buy.
        throw new AppError(409, 'Duplicate purchase (already processed)', 'IDEM_CONFLICT')
      }
      try {
        await redisClient.del(RedisKeys.walletIdem(idem))
      } catch {
        // best-effort
      }
      throw err
    }
  },

  async purchaseRareId(params: {
    buyerId: string
    publicId: bigint
    recipientId: string
    idempotencyKey: string
  }): Promise<{
    publicId: string
    recipientId: string
    purchasedById: string
    expiresAt: string
    isGift: boolean
  }> {
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

    const expiresAt = new Date(Date.now() + env.STORE_RARE_ID_DURATION_DAYS * 24 * 60 * 60 * 1000)
    let buyerWealthResult: LevelApplyResult | null = null
    const createdAssignment = await prisma.$transaction(
      async (tx) => {
        buyerWealthResult = await coinWalletService.debitForVipPurchase(
          params.buyerId,
          BigInt(row.priceCredits!),
          {
            recipientId: params.recipientId,
            publicId: params.publicId.toString(),
            idempotencyKey: params.idempotencyKey,
            applyWealthXp: true,
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
        const assignment = await tx.userVipAssignment.create({
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
        return assignment
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: TX_TIMEOUT_MS },
    )

    await walletService.adjustCoinBalanceCache(params.buyerId, BigInt(row.priceCredits!))
    await syncLevelCacheFromApplyResult(params.buyerId, LevelType.WEALTH, buyerWealthResult)
    await enqueueRareIdAssignmentExpiry(createdAssignment.id, createdAssignment.expiresAt)
    await Promise.all([
      cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(params.recipientId)),
      cacheRedisService.del(
        RedisKeys.storeRareIds(),
        RedisKeys.userActiveStore(params.recipientId),
      ),
      cacheRedisService.del(
        RedisKeys.userMe(params.recipientId),
        RedisKeys.userProfile(params.recipientId),
      ),
    ])

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
    await Promise.all([
      cacheRedisService.del(RedisKeys.userActiveStore(userId)),
      cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(userId)),
      cacheRedisService.del(RedisKeys.userMe(userId), RedisKeys.userProfile(userId)),
    ])
  },

  async deactivateOwnedItem(userId: string, userStoreItemId: string): Promise<void> {
    const owned = await storeRepository.findUserStoreItemById(userStoreItemId)
    if (!owned || owned.userId !== userId) {
      throw new AppError(404, 'Store item ownership not found', 'STORE_ITEM_NOT_OWNED')
    }
    if (!owned.isActive || owned.revokedAt) {
      throw new AppError(400, 'Store item is inactive', 'STORE_ITEM_INACTIVE')
    }
    if (!owned.isApplied) {
      // Idempotent deactivate: already inactive in active slot.
      return
    }
    await storeRepository.deactivateItem(userId, userStoreItemId, owned.storeItem.category)
    await Promise.all([
      cacheRedisService.del(RedisKeys.userActiveStore(userId)),
      cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(userId)),
      cacheRedisService.del(RedisKeys.userMe(userId), RedisKeys.userProfile(userId)),
    ])
  },

  async activateOwnedRarePublicId(userId: string, assignmentId: string): Promise<void> {
    const assignment = await prismaRead.userVipAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        userId: true,
        publicId: true,
        isActive: true,
        revokedAt: true,
        expiresAt: true,
      },
    })
    if (!assignment || assignment.userId !== userId) {
      throw new AppError(404, 'Rare ID ownership not found', 'RARE_ID_NOT_OWNED')
    }
    if (!assignment.isActive || assignment.revokedAt) {
      throw new AppError(400, 'Rare ID is inactive', 'RARE_ID_INACTIVE')
    }
    if (assignment.expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, 'Rare ID has expired', 'RARE_ID_EXPIRED')
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        currentVipPublicId: assignment.publicId,
        vipPublicIdExpiresAt: assignment.expiresAt,
      },
    })

    const ttlSeconds = Math.max(1, Math.floor((assignment.expiresAt.getTime() - Date.now()) / 1000))
    try {
      await redisClient.set(
        RedisKeys.userActiveVipId(userId),
        assignment.publicId.toString(),
        'EX',
        ttlSeconds,
      )
    } catch {
      /* ignore */
    }

    await Promise.all([
      cacheRedisService.del(RedisKeys.userActiveStore(userId)),
      cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(userId)),
    ])
  },

  async deactivateOwnedRarePublicId(userId: string, assignmentId: string): Promise<void> {
    const assignment = await prismaRead.userVipAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, userId: true, publicId: true },
    })
    if (!assignment || assignment.userId !== userId) {
      throw new AppError(404, 'Rare ID ownership not found', 'RARE_ID_NOT_OWNED')
    }

    await prisma.user.updateMany({
      where: { id: userId, currentVipPublicId: assignment.publicId },
      data: {
        currentVipPublicId: null,
        vipPublicIdExpiresAt: null,
      },
    })

    try {
      await redisClient.del(RedisKeys.userActiveVipId(userId))
    } catch {
      /* ignore */
    }

    await Promise.all([
      cacheRedisService.del(RedisKeys.userActiveStore(userId)),
      cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(userId)),
    ])
  },

  async listOwnedItems(
    userId: string,
    opts: { category?: StoreItemCategory; isActive?: boolean; cursor?: string; limit?: number },
  ): Promise<ListOwnedItemsResponse> {
    const safeLimit = Math.max(1, Math.min(opts.limit ?? 20, 50))
    const cacheKey = !opts.cursor
      ? `${RedisKeys.userStoreItems(userId)}:${opts.category ?? 'ALL'}:${opts.isActive ?? 'ALL'}:${safeLimit}:rare-v1`
      : null
    if (cacheKey) {
      const cached = await cacheRedisService.get<ListOwnedItemsResponse>(cacheKey)
      if (cached) return cached
    }
    const [rows, rareAssignments, user] = await Promise.all([
      storeRepository.findOwnedItems(userId, {
        category: opts.category,
        isActive: opts.isActive,
        cursor: opts.cursor,
        limit: safeLimit + 1,
      }),
      vipAssignmentRepository.findAllForUser(userId, { isActive: opts.isActive }),
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { currentVipPublicId: true, vipPublicIdExpiresAt: true },
      }),
    ])
    const hasMore = rows.length > safeLimit
    const page = hasMore ? rows.slice(0, safeLimit) : rows
    const now = Date.now()
    const equippedId = user?.currentVipPublicId ?? null
    const equippedValid =
      equippedId != null &&
      user?.vipPublicIdExpiresAt != null &&
      user.vipPublicIdExpiresAt.getTime() > now

    const ownedRarePublicIds = rareAssignments.map((row) => ({
      assignmentId: row.id,
      publicId: row.publicId.toString(),
      tier: row.vipPublicId.tier,
      rarityScore: row.vipPublicId.rarityScore,
      priceCredits: row.vipPublicId.priceCredits,
      matchedRules: row.vipPublicId.matchedRules,
      isActive: row.isActive,
      isEquipped: equippedValid && equippedId === row.publicId,
      startsAt: row.startsAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    }))

    const payload: ListOwnedItemsResponse = {
      items: page.map((row) => ({
        userStoreItemId: row.id,
        isApplied: row.isApplied,
        isActive: row.isActive,
        expiresAt: row.expiresAt.toISOString(),
        purchasedById: row.purchasedById,
        coinsPaid: row.coinsPaid,
        item: toStoreSummary(row.storeItem),
      })),
      ownedRarePublicIds,
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
      if (
        !owned ||
        !owned.isActive ||
        !owned.isApplied ||
        owned.expiresAt.getTime() <= Date.now()
      ) {
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
    if (
      user?.currentVipPublicId &&
      user.vipPublicIdExpiresAt &&
      user.vipPublicIdExpiresAt > new Date()
    ) {
      map.rareId = user.currentVipPublicId.toString()
    }
    await cacheRedisService.set(key, map, USER_ACTIVE_STORE_TTL)
    return map
  },

  async processExpiryJob(userStoreItemId: string): Promise<void> {
    const result = await storeRepository.expireItem(userStoreItemId)
    if (!result) return
    await Promise.all([
      cacheRedisService.del(RedisKeys.userActiveStore(result.userId)),
      cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(result.userId)),
    ])
  },

  /**
   * Rare public ID lease ended: return catalog row to the store; clear user overlay fields. Does not remove `vip:reserved`.
   */
  async processRareIdExpiryJob(assignmentId: string): Promise<void> {
    const assignment = await prisma.userVipAssignment.findUnique({ where: { id: assignmentId } })
    if (!assignment) return
    if (!assignment.isActive) return

    const { userId, publicId } = assignment

    await prisma.$transaction(async (tx) => {
      await tx.userVipAssignment.update({
        where: { id: assignmentId },
        data: { isActive: false },
      })

      await tx.user.updateMany({
        where: { id: userId, currentVipPublicId: publicId },
        data: {
          currentVipPublicId: null,
          vipPublicIdExpiresAt: null,
        },
      })

      await tx.vipPublicId.update({
        where: { publicId },
        data: {
          isAvailable: true,
          currentOwnerId: null,
          expiresAt: null,
          purchasedAt: null,
          assignedAt: null,
        },
      })
    })

    try {
      await redisClient.del(RedisKeys.userActiveVipId(userId))
    } catch {
      /* ignore */
    }

    await Promise.all([
      cacheRedisService.delByKeyPrefix(RedisKeys.userStoreItems(userId)),
      cacheRedisService.del(RedisKeys.userActiveStore(userId), RedisKeys.storeRareIds()),
      cacheRedisService.del(RedisKeys.userMe(userId), RedisKeys.userProfile(userId)),
    ])
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
      description?: string | null
      coinCost?: number
      isActive?: boolean
      sortOrder?: number
      displayImageUrl?: string
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
