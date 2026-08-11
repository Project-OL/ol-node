import { CoinTxType, LedgerDirection, PointTxType, Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'
import { getTransactionName, type LedgerWalletContext } from '../config/transaction-display-names'
import { formatUserName } from './user-display'

export const COUNTERPARTY_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  publicId: true,
} as const

export type CounterpartyUserRow = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
  publicId: bigint
}

export type CounterpartyDetails = {
  name?: string
  publicId?: string
  userId?: string
  avatarUrl?: string | null
  storeItemName?: string
  price?: string
  rarePublicId?: string
  membershipType?: string
  addedByAdmin?: {
    adminUserId: string
    name?: string
    publicId?: string
  }
  transactionId?: string
} | null

type LedgerEntryLike = {
  id: string
  direction: LedgerDirection | 'credit' | 'debit'
  txType: PointTxType | CoinTxType | string
  amount: bigint
  refId: string | null
  counterpartyId: string | null
  metadata: Prisma.JsonValue
  createdAt: Date
}

export function mapUserCounterpartyDetails(
  user: CounterpartyUserRow,
): NonNullable<CounterpartyDetails> {
  return {
    userId: user.id,
    name: formatUserName(user),
    publicId: user.publicId.toString(),
    avatarUrl: user.avatarUrl,
  }
}

function asObject(metadata: Prisma.JsonValue): Record<string, unknown> | null {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }
  return metadata as Record<string, unknown>
}

function readString(obj: Record<string, unknown> | null, key: string): string | undefined {
  if (!obj) return undefined
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

const USER_COUNTERPARTY_POINT_TYPES = new Set<PointTxType>([
  PointTxType.GIFT_RECEIVE,
  PointTxType.VIDEO_CALL,
  PointTxType.SUBSCRIPTION,
  PointTxType.GUARDIAN_PURCHASE,
  PointTxType.AGENT_COMMISSION,
  PointTxType.PAYROLL_HOST_PAYOUT,
  PointTxType.PAYROLL_PROCESSING_REWARD,
  PointTxType.AGENT_POINT_TRANSFER,
  PointTxType.TRANSFER_IN,
])

const USER_COUNTERPARTY_COIN_TYPES = new Set<CoinTxType>([
  CoinTxType.GIFT_SEND,
  CoinTxType.VIDEO_CALL,
  CoinTxType.CREATOR_SUBSCRIPTION,
  CoinTxType.GUARDIAN_PURCHASE,
  CoinTxType.TRADING_TRANSFER_IN,
  CoinTxType.TRADING_TRANSFER_OUT,
  CoinTxType.TRADING_TRANSFER_REVERSAL,
])

function usesUserCounterparty(
  walletContext: LedgerWalletContext,
  txType: PointTxType | CoinTxType | string,
): boolean {
  if (walletContext === 'POINT') {
    return USER_COUNTERPARTY_POINT_TYPES.has(txType as PointTxType)
  }
  return USER_COUNTERPARTY_COIN_TYPES.has(txType as CoinTxType)
}

async function loadAgencyOwnerByForceExitRef(
  walletUserId: string,
  refId: string | null,
): Promise<string | null> {
  if (!refId) return null
  const row = await prismaRead.agencyHostHistory.findFirst({
    where: {
      hostUserId: walletUserId,
      reason: 'CS_FORCE_EXIT',
      exitMetadata: {
        path: ['ticketId'],
        equals: refId,
      },
    },
    orderBy: { exitedAt: 'desc' },
    select: { agencyUserId: true },
  })
  return row?.agencyUserId ?? null
}

export type BuildCounterpartyDetailsOptions = {
  /**
   * When true (admin lists), always attach user `counterpartyDetails`
   * (name, publicId, userId, avatarUrl) whenever `counterpartyId` resolves,
   * not only for the wallet-history tx-type allow-list.
   */
  alwaysIncludeUserCounterparty?: boolean
}

export async function buildCounterpartyDetailsMap(
  entries: LedgerEntryLike[],
  walletContext: LedgerWalletContext,
  walletUserId: string,
  options?: BuildCounterpartyDetailsOptions,
): Promise<Map<string, CounterpartyDetails>> {
  const result = new Map<string, CounterpartyDetails>()
  if (entries.length === 0) return result

  const userIds = new Set<string>()
  const adminUserIds = new Set<string>()
  const storeItemIds = new Set<string>()

  for (const entry of entries) {
    const meta = asObject(entry.metadata)

    if (entry.counterpartyId) {
      userIds.add(entry.counterpartyId)
    }

    const adminUserId = readString(meta, 'adminUserId')
    if (adminUserId) adminUserIds.add(adminUserId)

    const storeItemId = readString(meta, 'storeItemId')
    if (storeItemId) storeItemIds.add(storeItemId)
  }

  const forceExitEntries = entries.filter(
    (e) =>
      walletContext === 'POINT' &&
      e.txType === PointTxType.AGENCY_FORCE_EXIT_PENALTY &&
      !e.counterpartyId,
  )

  const forceExitOwnerByEntryId = new Map<string, string>()
  await Promise.all(
    forceExitEntries.map(async (e) => {
      const ownerId = await loadAgencyOwnerByForceExitRef(walletUserId, e.refId)
      if (ownerId) {
        forceExitOwnerByEntryId.set(e.id, ownerId)
        userIds.add(ownerId)
      }
    }),
  )

  const [users, adminUsers, storeItems] = await Promise.all([
    userIds.size > 0
      ? prismaRead.user.findMany({
          where: { id: { in: [...userIds] } },
          select: COUNTERPARTY_USER_SELECT,
        })
      : Promise.resolve([] as CounterpartyUserRow[]),
    adminUserIds.size > 0
      ? prismaRead.user.findMany({
          where: { id: { in: [...adminUserIds] } },
          select: COUNTERPARTY_USER_SELECT,
        })
      : Promise.resolve([] as CounterpartyUserRow[]),
    storeItemIds.size > 0
      ? prismaRead.storeItem.findMany({
          where: { id: { in: [...storeItemIds] } },
          select: { id: true, name: true, coinCost: true },
        })
      : Promise.resolve([] as Array<{ id: string; name: string; coinCost: number }>),
  ])

  const userMap = new Map(users.map((u) => [u.id, u]))
  const adminMap = new Map(adminUsers.map((u) => [u.id, u]))
  const storeMap = new Map(storeItems.map((s) => [s.id, s]))

  for (const entry of entries) {
    const meta = asObject(entry.metadata)
    let details: CounterpartyDetails = null

    if (
      walletContext !== 'POINT' &&
      entry.txType === CoinTxType.ADJUSTMENT &&
      entry.direction !== LedgerDirection.DEBIT &&
      String(entry.direction).toLowerCase() !== 'debit'
    ) {
      const adminId = readString(meta, 'adminUserId')
      if (adminId) {
        const admin = adminMap.get(adminId)
        details = {
          addedByAdmin: admin
            ? {
                adminUserId: adminId,
                name: formatUserName(admin),
                publicId: admin.publicId.toString(),
              }
            : { adminUserId: adminId },
        }
      }
    } else if (entry.txType === CoinTxType.STORE_ITEM_PURCHASE) {
      const storeItemId = readString(meta, 'storeItemId')
      const item = storeItemId ? storeMap.get(storeItemId) : undefined
      details = {
        storeItemName: item?.name,
        price: item ? String(item.coinCost) : entry.amount.toString(),
      }
    } else if (entry.txType === CoinTxType.VIP_PURCHASE) {
      details = {
        rarePublicId: readString(meta, 'publicId'),
        price: entry.amount.toString(),
      }
    } else if (entry.txType === CoinTxType.VIP_MEMBERSHIP_PURCHASE) {
      const tier = readString(meta, 'tier')
      details = tier ? { membershipType: tier } : null
    } else if (
      walletContext === 'POINT' &&
      entry.txType === PointTxType.WITHDRAWAL_ESCROW_SETTLED
    ) {
      const agentId = entry.counterpartyId ?? undefined
      const agent = agentId ? userMap.get(agentId) : undefined
      details = agent
        ? {
            ...mapUserCounterpartyDetails(agent),
            transactionId: entry.refId ?? undefined,
          }
        : entry.refId
          ? { transactionId: entry.refId }
          : null
    } else if (
      walletContext === 'POINT' &&
      entry.txType === PointTxType.AGENCY_FORCE_EXIT_PENALTY
    ) {
      const ownerId = entry.counterpartyId ?? forceExitOwnerByEntryId.get(entry.id)
      const owner = ownerId ? userMap.get(ownerId) : undefined
      details = owner ? mapUserCounterpartyDetails(owner) : null
    } else if (usesUserCounterparty(walletContext, entry.txType) && entry.counterpartyId) {
      const user = userMap.get(entry.counterpartyId)
      details = user ? mapUserCounterpartyDetails(user) : null
    }

    if (options?.alwaysIncludeUserCounterparty && entry.counterpartyId) {
      const user = userMap.get(entry.counterpartyId)
      if (user) {
        const userDetails = mapUserCounterpartyDetails(user)
        details = details ? { ...details, ...userDetails } : userDetails
      }
    }

    result.set(entry.id, details)
  }

  return result
}

export function enrichLedgerEntry<T extends LedgerEntryLike & Record<string, unknown>>(
  entry: T,
  walletContext: LedgerWalletContext,
  counterpartyDetails: CounterpartyDetails,
): T & { transactionName: string; counterpartyDetails: CounterpartyDetails } {
  return {
    ...entry,
    transactionName: getTransactionName(walletContext, entry.txType, entry.direction),
    counterpartyDetails,
  }
}

export async function enrichLedgerEntries<T extends LedgerEntryLike & Record<string, unknown>>(
  entries: T[],
  walletContext: LedgerWalletContext,
  walletUserId: string,
  options?: BuildCounterpartyDetailsOptions,
): Promise<Array<T & { transactionName: string; counterpartyDetails: CounterpartyDetails }>> {
  const counterpartyMap = await buildCounterpartyDetailsMap(
    entries,
    walletContext,
    walletUserId,
    options,
  )
  return entries.map((entry) =>
    enrichLedgerEntry(entry, walletContext, counterpartyMap.get(entry.id) ?? null),
  )
}

/**
 * Admin multi-wallet lists: build counterpartyDetails per wallet owner
 * (force-exit agency-owner lookup is scoped to the ledger wallet user).
 */
export async function buildAdminCounterpartyDetailsMap(
  entries: Array<LedgerEntryLike & { walletUserId: string }>,
  walletContext: LedgerWalletContext,
): Promise<Map<string, CounterpartyDetails>> {
  const result = new Map<string, CounterpartyDetails>()
  if (entries.length === 0) return result

  const byWalletUser = new Map<string, LedgerEntryLike[]>()
  for (const entry of entries) {
    const list = byWalletUser.get(entry.walletUserId) ?? []
    list.push(entry)
    byWalletUser.set(entry.walletUserId, list)
  }

  await Promise.all(
    [...byWalletUser.entries()].map(async ([walletUserId, group]) => {
      const map = await buildCounterpartyDetailsMap(group, walletContext, walletUserId, {
        alwaysIncludeUserCounterparty: true,
      })
      for (const [id, details] of map) {
        result.set(id, details)
      }
    }),
  )

  return result
}
