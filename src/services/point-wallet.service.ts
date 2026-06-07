import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { redisClient, getRedisForRead, RedisKeys, WALLET_BALANCE_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { walletRepository } from '../repositories/wallet.repository'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { walletService } from './wallet.service'
import { auditService } from './audit.service'
import { WalletCurrencyType, PointTxType, LedgerDirection, LevelType } from '@prisma/client'
import { walletLevelService } from './user-level.service'
import { utcDayFromTimestamp } from '../utils/datetime'
import { formatPointsAsUsd } from '../utils/points-currency'
import {
  buildPointAmountBreakdown,
  loadWithdrawalAmountContext,
  resolvePointLedgerRefId,
} from '../utils/point-transaction-amounts'
import { inferRefIdEntityType } from '../config/point-ledger-ref-id'
import type { PointLedgerEntry } from '@prisma/client'
import {
  earningsCategoryForTxType,
  resolvePointHistoryTxTypes,
  sumCreditsByCategory,
} from '../config/point-earnings-categories'
import { withdrawalService } from './withdrawal.service'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

const LEDGER_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
} as const

type LedgerUserRow = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
}

function ledgerUserDisplayName(user: LedgerUserRow): string {
  const fullName =
    user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : (user.firstName ?? user.lastName)
  const trimmed = fullName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : user.username
}

function mapLedgerParticipant(user: LedgerUserRow) {
  return {
    userId: user.id,
    username: user.username,
    displayName: ledgerUserDisplayName(user),
    avatarUrl: user.avatarUrl,
  }
}

type PointLedgerDetailRow = PointLedgerEntry

async function buildPointTransactionDetail(
  entry: PointLedgerDetailRow,
  selfRow: LedgerUserRow,
  counterpartyRow: LedgerUserRow | null,
) {
  const transactionDateTime = entry.createdAt.toISOString()
  const refId = resolvePointLedgerRefId(entry.refId, entry.metadata)

  const payrollConfig = await prismaRead.payrollConfig.findUnique({
    where: { id: 1 },
    select: { inrPerUsd: true },
  })
  const inrPerUsd = payrollConfig
    ? new Prisma.Decimal(payrollConfig.inrPerUsd.toString()).toNumber()
    : 86

  const withdrawal = refId ? await loadWithdrawalAmountContext(refId, entry.txType) : null

  const amountDetails = buildPointAmountBreakdown(
    {
      txType: entry.txType,
      amount: entry.amount,
      refId,
      metadata: entry.metadata,
      withdrawal,
    },
    inrPerUsd,
  )

  return {
    id: entry.id,
    direction: entry.direction,
    txType: entry.txType,
    amount: entry.amount.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    refId,
    refIdEntityType: inferRefIdEntityType(entry.txType),
    amountDetails,
    transactionDateTime,
    description: entry.description,
    metadata: entry.metadata,
    idempotencyKey: entry.idempotencyKey,
    createdAt: transactionDateTime,
    earningsCategory: earningsCategoryForTxType(entry.txType),
    self: mapLedgerParticipant(selfRow),
    counterparty: counterpartyRow ? mapLedgerParticipant(counterpartyRow) : null,
  }
}

export const pointWalletService = {
  async getSummary(userId: string) {
    const balance = await walletService.getPointBalance(userId)

    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)
    const unconfirmed = wallet.unconfirmedPoints ?? 0n
    const available = balance - unconfirmed
    const earnings = await prismaRead.pointLedgerEntry.groupBy({
      by: ['txType'],
      where: { walletId: wallet.id, direction: LedgerDirection.CREDIT },
      _sum: { amount: true },
    })

    const totalsByTxType = Object.fromEntries(
      earnings.map((e) => [e.txType, e._sum.amount ?? 0n]),
    ) as Partial<Record<PointTxType, bigint>>

    return {
      remainingPoints: balance.toString(),
      totalPoints: balance.toString(),
      availablePoints: available.toString(),
      unconfirmedPoints: unconfirmed.toString(),
      earnings: sumCreditsByCategory(totalsByTxType),
    }
  },

  async creditPoints(params: {
    userId: string
    amount: bigint
    txType: PointTxType
    refId?: string
    counterpartyId?: string
    description?: string
    metadata?: object
    idempotencyKey: string
  }) {
    const { userId, amount, txType, refId, counterpartyId, description, metadata, idempotencyKey } =
      params

    const cached = await walletService.getCachedIdemResponse(idempotencyKey)
    if (cached) return cached

    const acquired = await walletService.acquireIdemKey(idempotencyKey)
    if (!acquired) throw new AppError(409, 'Already processing', 'IDEM_CONFLICT')

    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)

    const { entry, levelResult, bustAgentUserId } = await prisma.$transaction(
      async (tx) => {
        await walletRepository.lockForUpdate(tx, wallet.id)

        const last = await tx.pointLedgerEntry.findFirst({
          where: { walletId: wallet.id },
          orderBy: { createdAt: 'desc' },
          select: { balanceAfter: true },
        })
        const newBalance = (last?.balanceAfter ?? 0n) + amount

        const e = await pointLedgerRepository.insert(tx, {
          walletId: wallet.id,
          direction: LedgerDirection.CREDIT,
          txType,
          amount,
          balanceAfter: newBalance,
          refId,
          counterpartyId,
          description,
          metadata,
          idempotencyKey,
        })

        await walletRepository.bumpVersion(tx, wallet.id)

        const { agencyCommissionService } = await import('./agencyCommission.service')
        const ac = await agencyCommissionService.applyCommission(
          {
            hostUserId: userId,
            hostLedgerEntryId: e.id,
            hostPointsCredited: amount,
            hostTxType: txType,
            day: utcDayFromTimestamp(new Date()),
          },
          tx,
        )

        const lr = await walletLevelService.applyCredit(tx, userId, LevelType.LIVESTREAM, amount)

        return {
          entry: e,
          levelResult: lr,
          bustAgentUserId: ac.bustAgentUserId,
        }
      },
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_TIMEOUT_MS },
    )

    await walletService.adjustPointBalanceCache(userId, amount)

    if (bustAgentUserId) {
      const { agencyCommissionService } = await import('./agencyCommission.service')
      await agencyCommissionService.bustAgentCommissionCaches(bustAgentUserId)
    }

    const streamSnapshot = await walletLevelService.refreshCache(
      userId,
      LevelType.LIVESTREAM,
      levelResult.newCumulative,
      levelResult.newLevel,
      levelResult.previousLevel,
    )

    auditService.log({
      userId,
      actionType: 'POINTS_CREDIT',
      actionStatus: 'success',
      actionDetails: {
        ledgerEntryId: entry.id,
        txType,
        amount: amount.toString(),
        refId,
      },
    })

    const response = {
      ledgerEntryId: entry.id,
      balanceAfter: entry.balanceAfter.toString(),
      livestreamLevel: {
        currentLevel: streamSnapshot.currentLevel,
        cumulativeTotal: streamSnapshot.cumulativeTotal,
        distanceToUpgrade: streamSnapshot.distanceToUpgrade,
        leveledUp: streamSnapshot.leveledUp,
        previousLevel: streamSnapshot.previousLevel,
      },
    }
    await walletService.resolveIdemKey(idempotencyKey, response)
    return response
  },

  async initiateWithdrawal(
    userId: string,
    amountPoints: bigint,
    paymentMethodId: string,
    idempotencyKey: string,
    notes?: string,
  ) {
    const result = (await withdrawalService.createWithdrawal(userId, {
      grossPoints: amountPoints,
      paymentMethodId,
      idempotencyKey,
      notes,
    })) as { withdrawalId: string; status: string }

    auditService.log({
      userId,
      actionType: 'POINTS_WITHDRAWAL_INITIATED',
      actionStatus: 'success',
      actionDetails: {
        withdrawalId: result.withdrawalId,
        amountPoints: amountPoints.toString(),
      },
    })

    return result
  },

  async getHistory(
    userId: string,
    filter: {
      types?: string[]
      from?: string
      to?: string
      cursor?: string
      limit: number
    },
  ) {
    let ledgerTypes: PointTxType[] | undefined
    try {
      ledgerTypes = resolvePointHistoryTxTypes(filter.types)
    } catch (e) {
      throw new AppError(
        400,
        e instanceof Error ? e.message : 'Invalid types filter',
        'INVALID_REQUEST',
      )
    }

    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)

    const entries = await pointLedgerRepository.list({
      walletId: wallet.id,
      types: ledgerTypes,
      from: filter.from ? new Date(filter.from) : undefined,
      to: filter.to ? new Date(filter.to) : undefined,
      cursor: filter.cursor,
      limit: filter.limit,
    })

    const hasMore = entries.length > filter.limit
    const page = hasMore ? entries.slice(0, filter.limit) : entries
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined

    return {
      entries: page.map((e) => {
        const refId = resolvePointLedgerRefId(e.refId, e.metadata)
        return {
          id: e.id,
          direction: e.direction,
          txType: e.txType,
          amount: e.amount.toString(),
          balanceAfter: e.balanceAfter.toString(),
          refId,
          usdAmount: formatPointsAsUsd(e.amount),
          counterpartyId: e.counterpartyId,
          description: e.description,
          metadata: e.metadata,
          createdAt: e.createdAt,
        }
      }),
      nextCursor,
      hasMore,
    }
  },

  /**
   * Single point ledger row for the authenticated user's POINT wallet, with
   * self + counterparty profile cards.
   */
  async getTransactionDetail(userId: string, entryId: string) {
    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)

    const entry = await pointLedgerRepository.findByIdForWallet(entryId, wallet.id)
    if (!entry) {
      throw new AppError(404, 'Point transaction not found', 'NOT_FOUND')
    }

    const userIds = [userId]
    if (entry.counterpartyId && entry.counterpartyId !== userId) {
      userIds.push(entry.counterpartyId)
    }

    const users = await prismaRead.user.findMany({
      where: { id: { in: userIds } },
      select: LEDGER_USER_SELECT,
    })
    const byId = new Map(users.map((u) => [u.id, u]))

    const selfRow = byId.get(userId)
    if (!selfRow) {
      throw new AppError(404, 'User not found', 'NOT_FOUND')
    }

    const counterpartyRow = entry.counterpartyId ? (byId.get(entry.counterpartyId) ?? null) : null

    return buildPointTransactionDetail(entry, selfRow, counterpartyRow)
  },

  /**
   * Fetch all point ledger rows for the caller's wallet that share a business refId
   * (e.g. withdrawal id, gift_transaction id, subscription id).
   */
  async getTransactionsByRefId(userId: string, refId: string) {
    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)

    const entries = await pointLedgerRepository.findByRefForWallet(wallet.id, refId)
    if (entries.length === 0) {
      throw new AppError(404, 'Point transaction not found', 'NOT_FOUND')
    }

    const counterpartyIds = [
      ...new Set(
        entries.map((e) => e.counterpartyId).filter((id): id is string => !!id && id !== userId),
      ),
    ]
    const users = await prismaRead.user.findMany({
      where: { id: { in: [userId, ...counterpartyIds] } },
      select: LEDGER_USER_SELECT,
    })
    const byId = new Map(users.map((u) => [u.id, u]))
    const selfRow = byId.get(userId)
    if (!selfRow) {
      throw new AppError(404, 'User not found', 'NOT_FOUND')
    }

    const resolvedRefId = resolvePointLedgerRefId(entries[0]!.refId, entries[0]!.metadata) ?? refId

    const detailEntries = await Promise.all(
      entries.map((entry) => {
        const counterpartyRow = entry.counterpartyId
          ? (byId.get(entry.counterpartyId) ?? null)
          : null
        return buildPointTransactionDetail(entry, selfRow, counterpartyRow)
      }),
    )

    return {
      refId: resolvedRefId,
      refIdEntityType: inferRefIdEntityType(entries[0]!.txType),
      entries: detailEntries,
    }
  },

  /**
   * Point credit inside a caller-owned transaction. Idempotent on `idempotencyKey`.
   * When `applyLivestreamLevel` is true (default), applies livestream cumulative XP
   * (host earnings). Set false for agent commission / internal transfers.
   */
  async creditInTransaction(
    userId: string,
    amount: bigint,
    txType: PointTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string
      refId?: string
      counterpartyId?: string
      description?: string
      metadata?: Prisma.JsonValue
      applyLivestreamLevel?: boolean
    },
  ): Promise<{
    ledgerEntryId: string
    balanceAfter: bigint
    bustAgentUserId: string | null
  }> {
    const existing = await pointLedgerRepository.findByIdempotencyKey(tx, options.idempotencyKey)
    if (existing) {
      return {
        ledgerEntryId: existing.id,
        balanceAfter: existing.balanceAfter,
        bustAgentUserId: null,
      }
    }

    const wallet = await tx.wallet.upsert({
      where: {
        userId_currencyType: {
          userId,
          currencyType: WalletCurrencyType.POINT,
        },
      },
      create: { userId, currencyType: WalletCurrencyType.POINT },
      update: {},
    })
    await walletRepository.lockForUpdate(tx, wallet.id)
    const last = await tx.pointLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    })
    const newBalance = (last?.balanceAfter ?? 0n) + amount

    const entry = await pointLedgerRepository.insert(tx, {
      walletId: wallet.id,
      direction: LedgerDirection.CREDIT,
      txType,
      amount,
      balanceAfter: newBalance,
      refId: options.refId,
      counterpartyId: options.counterpartyId,
      description: options.description ?? undefined,
      metadata: options.metadata as object | undefined,
      idempotencyKey: options.idempotencyKey,
    })
    await walletRepository.bumpVersion(tx, wallet.id)

    const applyCommission =
      txType === PointTxType.LIVESTREAM_GIFT ||
      txType === PointTxType.GIFT_RECEIVE ||
      txType === PointTxType.VIDEO_CALL ||
      txType === PointTxType.SUBSCRIPTION ||
      txType === PointTxType.GUARDIAN_PURCHASE

    let bustAgentUserId: string | null = null
    if (applyCommission) {
      const { agencyCommissionService } = await import('./agencyCommission.service')
      const ac = await agencyCommissionService.applyCommission(
        {
          hostUserId: userId,
          hostLedgerEntryId: entry.id,
          hostPointsCredited: amount,
          hostTxType: txType,
          day: utcDayFromTimestamp(new Date()),
        },
        tx,
      )
      bustAgentUserId = ac.bustAgentUserId
    }

    const applyXp = options.applyLivestreamLevel !== false
    if (
      applyXp &&
      txType !== PointTxType.AGENT_COMMISSION &&
      txType !== PointTxType.AGENT_POINT_TRANSFER
    ) {
      await walletLevelService.applyCredit(tx, userId, LevelType.LIVESTREAM, amount)
    }

    return {
      ledgerEntryId: entry.id,
      balanceAfter: entry.balanceAfter,
      bustAgentUserId,
    }
  },

  /**
   * Generic point debit inside a caller-owned Serializable transaction.
   * Idempotent on `idempotencyKey`. Does not apply livestream XP (penalties / adjustments).
   */
  async debit(
    userId: string,
    amount: bigint,
    txType: PointTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string
      description?: string
      metadata?: Prisma.JsonValue
      counterpartyId?: string
      refId?: string
      /**
       * When true (default), the debit is gated on AVAILABLE points
       * (ledger sum − unconfirmedPoints), not the raw ledger sum. Set to
       * false for system-initiated debits (escrow settlement, reversals,
       * penalties) where correctness is enforced by upstream business logic.
       */
      availabilityCheck?: boolean
    },
  ): Promise<{ ledgerEntryId: string; balanceAfter: bigint }> {
    const existing = await pointLedgerRepository.findByIdempotencyKey(tx, options.idempotencyKey)
    if (existing) {
      return {
        ledgerEntryId: existing.id,
        balanceAfter: existing.balanceAfter,
      }
    }

    const wallet = await tx.wallet.upsert({
      where: {
        userId_currencyType: {
          userId,
          currencyType: WalletCurrencyType.POINT,
        },
      },
      create: { userId, currencyType: WalletCurrencyType.POINT },
      update: {},
    })
    await walletRepository.lockForUpdate(tx, wallet.id)
    const last = await tx.pointLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    })
    const balance = last?.balanceAfter ?? 0n
    const unconfirmed = wallet.unconfirmedPoints ?? 0n
    const checkAvailability = options.availabilityCheck !== false
    const available = checkAvailability ? balance - unconfirmed : balance
    if (available < amount) {
      throw new AppError(400, 'Insufficient available points', 'INSUFFICIENT_POINTS', {
        balance: available.toString(),
        required: amount.toString(),
        unconfirmed: unconfirmed.toString(),
      })
    }

    const entry = await pointLedgerRepository.insert(tx, {
      walletId: wallet.id,
      direction: LedgerDirection.DEBIT,
      txType,
      amount,
      balanceAfter: balance - amount,
      refId: options.refId,
      counterpartyId: options.counterpartyId,
      description: options.description,
      metadata: options.metadata as object | undefined,
      idempotencyKey: options.idempotencyKey,
    })
    await walletRepository.bumpVersion(tx, wallet.id)
    return { ledgerEntryId: entry.id, balanceAfter: entry.balanceAfter }
  },

  /**
   * SOFT escrow entry for a withdrawal. Inserts a DEBIT `point_ledger_entries`
   * row that does NOT reduce the ledger sum (`balanceAfter` carries the previous
   * running balance forward). Availability is tracked separately via
   * `wallets.unconfirmedPoints` (incremented by the caller in the same tx).
   *
   * The availability check is expected to be done by the caller BEFORE the tx;
   * this method performs no balance check. Idempotent on `idempotencyKey`.
   */
  async escrow(
    userId: string,
    amount: bigint,
    txType: PointTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string
      description?: string
      metadata?: Prisma.JsonValue
      counterpartyId?: string
      refId?: string
    },
  ): Promise<{ ledgerEntryId: string; balanceAfter: bigint }> {
    const existing = await pointLedgerRepository.findByIdempotencyKey(tx, options.idempotencyKey)
    if (existing) {
      return {
        ledgerEntryId: existing.id,
        balanceAfter: existing.balanceAfter,
      }
    }

    const wallet = await tx.wallet.upsert({
      where: {
        userId_currencyType: {
          userId,
          currencyType: WalletCurrencyType.POINT,
        },
      },
      create: { userId, currencyType: WalletCurrencyType.POINT },
      update: {},
    })
    await walletRepository.lockForUpdate(tx, wallet.id)
    const last = await tx.pointLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    })
    // balanceAfter unchanged — escrow does not move the ledger sum.
    const runningBalance = last?.balanceAfter ?? 0n

    const entry = await pointLedgerRepository.insert(tx, {
      walletId: wallet.id,
      direction: LedgerDirection.DEBIT,
      txType,
      amount,
      balanceAfter: runningBalance,
      refId: options.refId,
      counterpartyId: options.counterpartyId,
      description: options.description,
      metadata: options.metadata as object | undefined,
      idempotencyKey: options.idempotencyKey,
    })
    await walletRepository.bumpVersion(tx, wallet.id)
    return { ledgerEntryId: entry.id, balanceAfter: entry.balanceAfter }
  },

  /** Cached in-flight escrow total for a POINT wallet (`wallets.unconfirmedPoints`). */
  async getUnconfirmedPoints(userId: string): Promise<bigint> {
    const key = RedisKeys.walletPointsUnconfirmed(userId)
    try {
      const cached = await getRedisForRead().get(key)
      if (cached !== null) return BigInt(cached)
    } catch {
      // fall through to Postgres
    }
    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)
    const val = wallet.unconfirmedPoints ?? 0n
    try {
      await redisClient.set(key, val.toString(), 'EX', WALLET_BALANCE_TTL)
    } catch {
      // ignore cache write failure
    }
    return val
  },

  /** Spendable points = ledger sum (totalPoints) − unconfirmedPoints. */
  async getAvailablePoints(userId: string): Promise<bigint> {
    const { available } = await pointWalletService.getBalanceBreakdown(userId)
    return available
  },

  async getBalanceBreakdown(userId: string): Promise<{
    total: bigint
    available: bigint
    unconfirmed: bigint
  }> {
    const [total, unconfirmed] = await Promise.all([
      walletService.getPointBalance(userId),
      pointWalletService.getUnconfirmedPoints(userId),
    ])
    return { total, unconfirmed, available: total - unconfirmed }
  },

  /** Point balances plus USD equivalents (10_000 points = 1 USD). */
  async getBalanceWithUsd(userId: string) {
    const { total, available, unconfirmed } = await pointWalletService.getBalanceBreakdown(userId)
    return {
      totalPoints: total.toString(),
      availablePoints: available.toString(),
      unconfirmedPoints: unconfirmed.toString(),
      totalUsd: formatPointsAsUsd(total),
      availableUsd: formatPointsAsUsd(available),
      unconfirmedUsd: formatPointsAsUsd(unconfirmed),
      pointsPerUsd: 10_000,
    }
  },
}
