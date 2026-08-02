import {
  CoinTxType,
  LedgerDirection,
  PointTxType,
  Prisma,
  WalletCurrencyType,
} from '@prisma/client'
import { prismaRead } from '../config/database'

export const adminTxnUserSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
} as const

export type AdminTxnUserRow = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
}

export type AdminLedgerListFilter = {
  id?: string
  userId?: string
  counterpartyId?: string
  types?: string[]
  direction?: 'credit' | 'debit'
  from?: Date
  to?: Date
  cursor?: string
  limit: number
  /** COIN or TRADING_COIN wallet currency for coin ledger lists. */
  currencyType?: WalletCurrencyType
}

function createdAtCursorFilter(
  cursorCreatedAt: Date | undefined,
  from?: Date,
  to?: Date,
): Prisma.DateTimeFilter | undefined {
  const createdAt: Prisma.DateTimeFilter = {}
  if (from) createdAt.gte = from
  if (to) createdAt.lte = to
  if (cursorCreatedAt) createdAt.lt = cursorCreatedAt
  return Object.keys(createdAt).length > 0 ? createdAt : undefined
}

export const adminTransactionsRepository = {
  async resolveUserIdByPublicId(publicId: bigint): Promise<string | null> {
    const user = await prismaRead.user.findFirst({
      where: {
        OR: [
          { publicId },
          { defaultPublicId: publicId },
          { currentVipPublicId: publicId },
        ],
      },
      select: { id: true },
    })
    return user?.id ?? null
  },

  async getCoinLedgerCreatedAt(id: string): Promise<Date | null> {
    const row = await prismaRead.coinLedgerEntry.findUnique({
      where: { id },
      select: { createdAt: true },
    })
    return row?.createdAt ?? null
  },

  async getPointLedgerCreatedAt(id: string): Promise<Date | null> {
    const row = await prismaRead.pointLedgerEntry.findUnique({
      where: { id },
      select: { createdAt: true },
    })
    return row?.createdAt ?? null
  },

  async listCoinLedger(filter: AdminLedgerListFilter) {
    let cursorCreatedAt: Date | undefined
    if (filter.cursor) {
      cursorCreatedAt = (await this.getCoinLedgerCreatedAt(filter.cursor)) ?? undefined
    }
    const createdAt = createdAtCursorFilter(cursorCreatedAt, filter.from, filter.to)

    const where: Prisma.CoinLedgerEntryWhereInput = {
      ...(filter.id ? { id: filter.id } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(filter.types?.length ? { txType: { in: filter.types as CoinTxType[] } } : {}),
      ...(filter.direction
        ? {
            direction:
              filter.direction === 'credit' ? LedgerDirection.CREDIT : LedgerDirection.DEBIT,
          }
        : {}),
      ...(filter.counterpartyId ? { counterpartyId: filter.counterpartyId } : {}),
      wallet: {
        ...(filter.currencyType ? { currencyType: filter.currencyType } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
      },
    }

    return prismaRead.coinLedgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filter.limit + 1,
      include: {
        wallet: {
          select: {
            id: true,
            userId: true,
            currencyType: true,
            user: { select: adminTxnUserSelect },
          },
        },
      },
    })
  },

  async findCoinLedgerById(id: string) {
    return prismaRead.coinLedgerEntry.findUnique({
      where: { id },
      include: {
        wallet: {
          select: {
            id: true,
            userId: true,
            currencyType: true,
            user: { select: adminTxnUserSelect },
          },
        },
      },
    })
  },

  async listPointLedger(filter: AdminLedgerListFilter) {
    let cursorCreatedAt: Date | undefined
    if (filter.cursor) {
      cursorCreatedAt = (await this.getPointLedgerCreatedAt(filter.cursor)) ?? undefined
    }
    const createdAt = createdAtCursorFilter(cursorCreatedAt, filter.from, filter.to)

    const where: Prisma.PointLedgerEntryWhereInput = {
      ...(filter.id ? { id: filter.id } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(filter.types?.length ? { txType: { in: filter.types as PointTxType[] } } : {}),
      ...(filter.direction
        ? {
            direction:
              filter.direction === 'credit' ? LedgerDirection.CREDIT : LedgerDirection.DEBIT,
          }
        : {}),
      ...(filter.counterpartyId ? { counterpartyId: filter.counterpartyId } : {}),
      wallet: {
        currencyType: WalletCurrencyType.POINT,
        ...(filter.userId ? { userId: filter.userId } : {}),
      },
    }

    return prismaRead.pointLedgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filter.limit + 1,
      include: {
        wallet: {
          select: {
            id: true,
            userId: true,
            currencyType: true,
            user: { select: adminTxnUserSelect },
          },
        },
      },
    })
  },

  async findPointLedgerById(id: string) {
    return prismaRead.pointLedgerEntry.findUnique({
      where: { id },
      include: {
        wallet: {
          select: {
            id: true,
            userId: true,
            currencyType: true,
            user: { select: adminTxnUserSelect },
          },
        },
      },
    })
  },

  async listCoinTradingTransfers(filter: {
    id?: string
    senderUserId?: string
    receiverUserId?: string
    userId?: string
    from?: Date
    to?: Date
    cursor?: string
    limit: number
    reversedOnly?: boolean
  }) {
    const and: Prisma.CoinTradingTransferWhereInput[] = []
    if (filter.id) and.push({ id: filter.id })
    if (filter.senderUserId) and.push({ senderAgentUserId: filter.senderUserId })
    if (filter.receiverUserId) and.push({ recipientUserId: filter.receiverUserId })
    if (filter.userId) {
      and.push({
        OR: [{ senderAgentUserId: filter.userId }, { recipientUserId: filter.userId }],
      })
    }
    if (filter.from || filter.to || filter.cursor) {
      const createdAt: Prisma.DateTimeFilter = {}
      if (filter.from) createdAt.gte = filter.from
      if (filter.to) createdAt.lte = filter.to
      if (filter.cursor) {
        const cur = await prismaRead.coinTradingTransfer.findUnique({
          where: { id: filter.cursor },
          select: { createdAt: true },
        })
        if (cur) createdAt.lt = cur.createdAt
      }
      and.push({ createdAt })
    }
    if (filter.reversedOnly === true) and.push({ reversedAt: { not: null } })
    if (filter.reversedOnly === false) and.push({ reversedAt: null })

    return prismaRead.coinTradingTransfer.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: { createdAt: 'desc' },
      take: filter.limit + 1,
      include: {
        senderAgent: { select: adminTxnUserSelect },
        recipient: { select: adminTxnUserSelect },
        reversedBy: { select: adminTxnUserSelect },
      },
    })
  },

  async listGiftTransactions(filter: {
    id?: string
    senderUserId?: string
    receiverUserId?: string
    userId?: string
    from?: Date
    to?: Date
    cursor?: string
    limit: number
  }) {
    const and: Prisma.GiftTransactionWhereInput[] = []
    if (filter.id) and.push({ id: filter.id })
    if (filter.senderUserId) and.push({ senderUserId: filter.senderUserId })
    if (filter.receiverUserId) and.push({ receiverUserId: filter.receiverUserId })
    if (filter.userId) {
      and.push({
        OR: [{ senderUserId: filter.userId }, { receiverUserId: filter.userId }],
      })
    }
    if (filter.from || filter.to || filter.cursor) {
      const createdAt: Prisma.DateTimeFilter = {}
      if (filter.from) createdAt.gte = filter.from
      if (filter.to) createdAt.lte = filter.to
      if (filter.cursor) {
        const cur = await prismaRead.giftTransaction.findUnique({
          where: { id: filter.cursor },
          select: { createdAt: true },
        })
        if (cur) createdAt.lt = cur.createdAt
      }
      and.push({ createdAt })
    }

    return prismaRead.giftTransaction.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: { createdAt: 'desc' },
      take: filter.limit + 1,
      include: {
        sender: { select: adminTxnUserSelect },
        receiver: { select: adminTxnUserSelect },
        gift: {
          select: {
            id: true,
            name: true,
            code: true,
            displayImageUrl: true,
            coinCost: true,
            vipOnly: true,
          },
        },
      },
    })
  },

  async findGiftTransactionById(id: string) {
    return prismaRead.giftTransaction.findUnique({
      where: { id },
      include: {
        sender: { select: adminTxnUserSelect },
        receiver: { select: adminTxnUserSelect },
        gift: {
          select: {
            id: true,
            name: true,
            code: true,
            displayImageUrl: true,
            coinCost: true,
            vipOnly: true,
          },
        },
      },
    })
  },

  async listSubscriptions(filter: {
    id?: string
    senderUserId?: string
    receiverUserId?: string
    userId?: string
    from?: Date
    to?: Date
    cursor?: string
    limit: number
  }) {
    const and: Prisma.CreatorSubscriptionWhereInput[] = []
    if (filter.id) and.push({ id: filter.id })
    if (filter.senderUserId) and.push({ subscriberId: filter.senderUserId })
    if (filter.receiverUserId) and.push({ creatorId: filter.receiverUserId })
    if (filter.userId) {
      and.push({
        OR: [{ subscriberId: filter.userId }, { creatorId: filter.userId }],
      })
    }
    if (filter.from || filter.to || filter.cursor) {
      const createdAt: Prisma.DateTimeFilter = {}
      if (filter.from) createdAt.gte = filter.from
      if (filter.to) createdAt.lte = filter.to
      if (filter.cursor) {
        const cur = await prismaRead.creatorSubscription.findUnique({
          where: { id: filter.cursor },
          select: { createdAt: true },
        })
        if (cur) createdAt.lt = cur.createdAt
      }
      and.push({ createdAt })
    }

    return prismaRead.creatorSubscription.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: { createdAt: 'desc' },
      take: filter.limit + 1,
      include: {
        subscriber: { select: adminTxnUserSelect },
        creator: { select: adminTxnUserSelect },
      },
    })
  },

  async listVipPurchases(filter: {
    id?: string
    userId?: string
    from?: Date
    to?: Date
    cursor?: string
    limit: number
  }) {
    const and: Prisma.VipMembershipPurchaseWhereInput[] = []
    if (filter.id) and.push({ id: filter.id })
    if (filter.userId) and.push({ userId: filter.userId })
    if (filter.from || filter.to || filter.cursor) {
      const createdAt: Prisma.DateTimeFilter = {}
      if (filter.from) createdAt.gte = filter.from
      if (filter.to) createdAt.lte = filter.to
      if (filter.cursor) {
        const cur = await prismaRead.vipMembershipPurchase.findUnique({
          where: { id: filter.cursor },
          select: { createdAt: true },
        })
        if (cur) createdAt.lt = cur.createdAt
      }
      and.push({ createdAt })
    }

    return prismaRead.vipMembershipPurchase.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: { createdAt: 'desc' },
      take: filter.limit + 1,
      include: {
        user: { select: adminTxnUserSelect },
        ledgerEntry: {
          select: {
            id: true,
            amount: true,
            direction: true,
            txType: true,
            balanceAfter: true,
            createdAt: true,
          },
        },
      },
    })
  },

  async listStorePurchases(filter: {
    id?: string
    userId?: string
    senderUserId?: string
    receiverUserId?: string
    from?: Date
    to?: Date
    cursor?: string
    limit: number
  }) {
    const and: Prisma.UserStoreItemWhereInput[] = []
    if (filter.id) and.push({ id: filter.id })
    if (filter.receiverUserId) and.push({ userId: filter.receiverUserId })
    if (filter.senderUserId) and.push({ purchasedById: filter.senderUserId })
    if (filter.userId) {
      and.push({
        OR: [{ userId: filter.userId }, { purchasedById: filter.userId }],
      })
    }
    if (filter.from || filter.to || filter.cursor) {
      const createdAt: Prisma.DateTimeFilter = {}
      if (filter.from) createdAt.gte = filter.from
      if (filter.to) createdAt.lte = filter.to
      if (filter.cursor) {
        const cur = await prismaRead.userStoreItem.findUnique({
          where: { id: filter.cursor },
          select: { createdAt: true },
        })
        if (cur) createdAt.lt = cur.createdAt
      }
      and.push({ createdAt })
    }

    return prismaRead.userStoreItem.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: { createdAt: 'desc' },
      take: filter.limit + 1,
      include: {
        user: { select: adminTxnUserSelect },
        purchasedBy: { select: adminTxnUserSelect },
        storeItem: {
          select: {
            id: true,
            name: true,
            category: true,
            coinCost: true,
            displayImageUrl: true,
            effectUrl: true,
            validityDays: true,
          },
        },
      },
    })
  },

  async findUsersByIds(ids: string[]) {
    if (ids.length === 0) return []
    return prismaRead.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: adminTxnUserSelect,
    })
  },

  async findGiftsByIds(ids: string[]) {
    if (ids.length === 0) return []
    return prismaRead.gift.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: {
        id: true,
        name: true,
        code: true,
        displayImageUrl: true,
        coinCost: true,
        vipOnly: true,
      },
    })
  },

  async findGiftTransactionsByIds(ids: string[]) {
    if (ids.length === 0) return []
    return prismaRead.giftTransaction.findMany({
      where: { id: { in: [...new Set(ids)] } },
      include: {
        gift: {
          select: {
            id: true,
            name: true,
            code: true,
            displayImageUrl: true,
            coinCost: true,
            vipOnly: true,
          },
        },
      },
    })
  },

  async findStoreItemsByIds(ids: string[]) {
    if (ids.length === 0) return []
    return prismaRead.storeItem.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: {
        id: true,
        name: true,
        category: true,
        coinCost: true,
        displayImageUrl: true,
      },
    })
  },

  async findVipPurchasesByLedgerIds(ledgerIds: string[]) {
    if (ledgerIds.length === 0) return []
    return prismaRead.vipMembershipPurchase.findMany({
      where: { ledgerEntryId: { in: [...new Set(ledgerIds)] } },
      include: { user: { select: adminTxnUserSelect } },
    })
  },

  async findExistingCoinReversal(originalLedgerEntryId: string) {
    return prismaRead.coinLedgerEntry.findFirst({
      where: {
        OR: [
          { idempotencyKey: `admin-revert:coin:${originalLedgerEntryId}:debit` },
          { idempotencyKey: `admin-revert:coin:${originalLedgerEntryId}:credit` },
        ],
      },
      select: { id: true, idempotencyKey: true },
    })
  },

  async findExistingPointReversal(originalLedgerEntryId: string) {
    return prismaRead.pointLedgerEntry.findFirst({
      where: {
        OR: [
          { idempotencyKey: `admin-revert:point:${originalLedgerEntryId}:debit` },
          { idempotencyKey: `admin-revert:point:${originalLedgerEntryId}:credit` },
        ],
      },
      select: { id: true, idempotencyKey: true },
    })
  },

  async findExistingGiftReversal(giftTransactionId: string) {
    return prismaRead.coinLedgerEntry.findFirst({
      where: { idempotencyKey: `admin-revert:gift:${giftTransactionId}:credit` },
      select: { id: true },
    })
  },

  async findExistingGiftReversals(giftTransactionIds: string[]) {
    if (giftTransactionIds.length === 0) return []
    const keys = giftTransactionIds.map((id) => `admin-revert:gift:${id}:credit`)
    const rows = await prismaRead.coinLedgerEntry.findMany({
      where: { idempotencyKey: { in: keys } },
      select: { idempotencyKey: true },
    })
    return rows.map((r) => ({
      giftTransactionId: r.idempotencyKey.replace(/^admin-revert:gift:/, '').replace(/:credit$/, ''),
    }))
  },
}
