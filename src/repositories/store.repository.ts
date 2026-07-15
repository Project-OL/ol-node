import {
  Prisma,
  StoreItemCategory,
  type StoreItem,
  type UserActiveStoreItems,
  type UserStoreItem,
  type VipPublicId,
} from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

const TX_TIMEOUT_MS = 20_000

/**
 * Transaction-scoped mutual exclusion for the (user, category) active-item
 * read-modify-write. Purchase (self), equip, unequip, and expiry all switch
 * `user_active_store_items` based on a prior read; this advisory lock
 * serializes them at Read Committed without Serializable's 40001 abort storms.
 * Released automatically at commit/rollback.
 */
export async function lockActiveStoreCategory(
  tx: Prisma.TransactionClient,
  userId: string,
  category: StoreItemCategory,
): Promise<void> {
  // ::text cast: pg_advisory_xact_lock returns void, which $queryRaw cannot deserialize.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`store-active:${userId}:${category}`}, 0))::text AS locked`
}

/**
 * Row lock for the rare-ID inventory reservation: the availability re-check +
 * sell must be atomic against concurrent buyers of the same public id. At Read
 * Committed the plain re-read would race (both buyers see isAvailable=true);
 * FOR UPDATE serializes them so the loser sees the sold row and gets a 409.
 */
export async function lockVipPublicIdRow(
  tx: Prisma.TransactionClient,
  publicId: bigint,
): Promise<void> {
  await tx.$queryRaw`SELECT public_id FROM vip_public_ids WHERE public_id = ${publicId} FOR UPDATE`
}

export const storeRepository = {
  async findAllItems(category?: StoreItemCategory): Promise<StoreItem[]> {
    return prismaRead.storeItem.findMany({
      where: { isActive: true, ...(category ? { category } : {}) },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    })
  },

  async findItemById(id: string): Promise<StoreItem | null> {
    return prismaRead.storeItem.findUnique({ where: { id } })
  },

  async createUserStoreItem(data: {
    userId: string
    storeItemId: string
    purchasedById: string
    coinsPaid: number
    expiresAt: Date
    idempotencyKey: string
  }): Promise<UserStoreItem> {
    return prisma.userStoreItem.create({ data })
  },

  async findUserStoreItemById(
    id: string,
  ): Promise<(UserStoreItem & { storeItem: StoreItem }) | null> {
    return prismaRead.userStoreItem.findUnique({ where: { id }, include: { storeItem: true } })
  },

  async findOwnedItems(
    userId: string,
    opts: { category?: StoreItemCategory; isActive?: boolean; cursor?: string; limit: number },
  ): Promise<(UserStoreItem & { storeItem: StoreItem })[]> {
    return prismaRead.userStoreItem.findMany({
      where: {
        userId,
        ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
        ...(opts.category ? { storeItem: { category: opts.category } } : {}),
      },
      include: { storeItem: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  },

  async activateItem(
    userId: string,
    userStoreItemId: string,
    category: StoreItemCategory,
  ): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        await lockActiveStoreCategory(tx, userId, category)
        const activeRow = await tx.userActiveStoreItems.findUnique({
          where: { userId_category: { userId, category } },
        })

        if (activeRow?.userStoreItemId) {
          await tx.userStoreItem.updateMany({
            where: { id: activeRow.userStoreItemId, userId },
            data: { isApplied: false },
          })
        }

        await tx.userStoreItem.update({
          where: { id: userStoreItemId },
          data: { isApplied: true, activatedAt: new Date() },
        })

        await tx.userActiveStoreItems.upsert({
          where: { userId_category: { userId, category } },
          create: {
            userId,
            category,
            userStoreItemId,
          },
          update: { userStoreItemId },
        })
      },
      { timeout: TX_TIMEOUT_MS },
    )
  },

  async deactivateItem(
    userId: string,
    userStoreItemId: string,
    category: StoreItemCategory,
  ): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        await lockActiveStoreCategory(tx, userId, category)
        await tx.userStoreItem.update({
          where: { id: userStoreItemId },
          data: { isApplied: false },
        })

        await tx.userActiveStoreItems.upsert({
          where: { userId_category: { userId, category } },
          create: {
            userId,
            category,
            userStoreItemId: null,
          },
          update: { userStoreItemId: null },
        })
      },
      { timeout: TX_TIMEOUT_MS },
    )
  },

  /** Unequip whatever is currently in the category slot (idempotent if already empty). */
  async clearActiveCategory(userId: string, category: StoreItemCategory): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        await lockActiveStoreCategory(tx, userId, category)
        const activeRow = await tx.userActiveStoreItems.findUnique({
          where: { userId_category: { userId, category } },
        })
        if (activeRow?.userStoreItemId) {
          await tx.userStoreItem.updateMany({
            where: { id: activeRow.userStoreItemId, userId },
            data: { isApplied: false },
          })
        }
        await tx.userActiveStoreItems.upsert({
          where: { userId_category: { userId, category } },
          create: {
            userId,
            category,
            userStoreItemId: null,
          },
          update: { userStoreItemId: null },
        })
      },
      { timeout: TX_TIMEOUT_MS },
    )
  },

  async expireItem(
    userStoreItemId: string,
  ): Promise<{ userId: string; category: StoreItemCategory } | null> {
    return prisma.$transaction(
      async (tx) => {
        const target = await tx.userStoreItem.findUnique({
          where: { id: userStoreItemId },
          select: { userId: true, storeItem: { select: { category: true } } },
        })
        if (!target) return null
        // Category known — take the (user, category) lock, then re-read the
        // mutable flags so the decision is made under mutual exclusion.
        await lockActiveStoreCategory(tx, target.userId, target.storeItem.category)
        const row = await tx.userStoreItem.findUnique({
          where: { id: userStoreItemId },
          include: { storeItem: { select: { category: true } } },
        })
        if (!row) return null
        if (!row.isActive) {
          return { userId: row.userId, category: row.storeItem.category }
        }
        if (row.expiresAt.getTime() > Date.now()) return null

        const wasApplied = row.isApplied
        await tx.userStoreItem.update({
          where: { id: userStoreItemId },
          data: {
            isActive: false,
            isApplied: false,
            expiredAt: new Date(),
          },
        })
        if (wasApplied) {
          await tx.userActiveStoreItems.upsert({
            where: {
              userId_category: {
                userId: row.userId,
                category: row.storeItem.category,
              },
            },
            create: {
              userId: row.userId,
              category: row.storeItem.category,
              userStoreItemId: null,
            },
            update: { userStoreItemId: null },
          })
        }
        return { userId: row.userId, category: row.storeItem.category }
      },
      { timeout: TX_TIMEOUT_MS },
    )
  },

  async findActiveItems(userId: string): Promise<UserActiveStoreItems[]> {
    return prismaRead.userActiveStoreItems.findMany({ where: { userId } })
  },

  async findActiveItemForCategory(
    userId: string,
    category: StoreItemCategory,
  ): Promise<UserActiveStoreItems | null> {
    return prismaRead.userActiveStoreItems.findUnique({
      where: { userId_category: { userId, category } },
    })
  },

  async findAvailableRareIds(opts: { limit: number; cursor?: string }): Promise<VipPublicId[]> {
    const cursorPublicId =
      opts.cursor && opts.cursor.trim().length > 0 ? BigInt(opts.cursor) : undefined
    return prismaRead.vipPublicId.findMany({
      where: { isAvailable: true },
      orderBy: [{ rarityScore: 'desc' }, { publicId: 'asc' }],
      take: opts.limit,
      ...(cursorPublicId ? { cursor: { publicId: cursorPublicId }, skip: 1 } : {}),
    })
  },
}
