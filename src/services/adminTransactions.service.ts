import {
  CoinTxType,
  LedgerDirection,
  PointTxType,
  WalletCurrencyType,
} from '@prisma/client'
import { randomUUID } from 'crypto'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import type { AdminTransactionsListQuery } from '../models/admin-transactions.schemas'
import {
  adminTransactionsRepository,
  type AdminTxnUserRow,
} from '../repositories/admin-transactions.repository'
import { coinTradingRepository } from '../repositories/coinTrading.repository'
import { getTransactionName } from '../config/transaction-display-names'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'
import { auditService } from './audit.service'
import { coinWalletService } from './coin-wallet.service'
import { pointWalletService } from './point-wallet.service'
import { coinTradingService } from './coinTrading.service'
import { walletService } from './wallet.service'
const TX_TIMEOUT_MS = 20_000

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AdminUserBrief = {
  userId: string
  username: string
  displayName: string
  publicId: string
  displayPublicId: string
  avatarUrl: string | null
}

function mapUserBrief(u: AdminTxnUserRow): AdminUserBrief {
  return {
    userId: u.id,
    username: u.username,
    displayName: buildUserDisplayName(u),
    publicId: String(u.publicId),
    displayPublicId: resolveDisplayPublicId(u),
    avatarUrl: u.avatarUrl,
  }
}

function pageSlice<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null
  return { page, nextCursor, hasMore }
}

async function resolvePartyFilters(query: AdminTransactionsListQuery): Promise<{
  userId?: string
  senderUserId?: string
  receiverUserId?: string
  counterpartyId?: string
  id?: string
}> {
  let userId = query.userId
  let senderUserId = query.senderUserId
  let receiverUserId = query.receiverUserId
  const counterpartyId = query.counterpartyId
  let id =
    query.id ??
    query.ledgerEntryId ??
    query.transactionId ??
    query.giftTransactionId ??
    query.transferId ??
    query.purchaseId ??
    query.subscriptionId ??
    query.storePurchaseId ??
    query.vipPurchaseId

  if (query.publicId != null) {
    const resolved = await adminTransactionsRepository.resolveUserIdByPublicId(query.publicId)
    if (!resolved) throw new AppError(404, 'User not found for publicId', 'USER_NOT_FOUND')
    userId = userId ?? resolved
  }

  if (query.q) {
    const q = query.q.trim()
    if (UUID_RE.test(q) || q.startsWith('c')) {
      // uuid or cuid — treat as row id when no explicit id
      id = id ?? q
    } else if (/^\d+$/.test(q)) {
      const resolved = await adminTransactionsRepository.resolveUserIdByPublicId(BigInt(q))
      if (!resolved) throw new AppError(404, 'User not found for q', 'USER_NOT_FOUND')
      userId = userId ?? resolved
    } else {
      throw new AppError(
        400,
        'q must be a transaction UUID/cuid or numeric publicId',
        'INVALID_REQUEST',
      )
    }
  }

  return { userId, senderUserId, receiverUserId, counterpartyId, id }
}

function asMetaObject(metadata: unknown): Record<string, unknown> | null {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  return metadata as Record<string, unknown>
}

function readMetaString(metadata: unknown, key: string): string | undefined {
  const obj = asMetaObject(metadata)
  if (!obj) return undefined
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Resolve sender/receiver for same-currency peer move from one ledger row. */
function resolvePeerParties(entry: {
  direction: LedgerDirection
  walletUserId: string
  counterpartyId: string | null
}): { senderUserId: string; receiverUserId: string } {
  if (!entry.counterpartyId) {
    throw new AppError(
      400,
      'Entry has no counterparty — cannot revert peer transfer',
      'NOT_REVERTABLE',
    )
  }
  if (entry.direction === LedgerDirection.CREDIT) {
    return { receiverUserId: entry.walletUserId, senderUserId: entry.counterpartyId }
  }
  return { senderUserId: entry.walletUserId, receiverUserId: entry.counterpartyId }
}

export const adminTransactionsService = {
  async listCoinTransactions(query: AdminTransactionsListQuery) {
    const parties = await resolvePartyFilters(query)
    const rows = await adminTransactionsRepository.listCoinLedger({
      id: parties.id,
      userId: parties.userId,
      counterpartyId: parties.counterpartyId ?? parties.receiverUserId ?? parties.senderUserId,
      types: query.types,
      direction: query.direction,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
      currencyType: WalletCurrencyType.COIN,
    })
    const { page, nextCursor, hasMore } = pageSlice(rows, query.limit)
    return {
      entries: await enrichCoinLedgerRows(page),
      nextCursor,
      hasMore,
    }
  },

  async listTradingCoinLedger(query: AdminTransactionsListQuery) {
    const parties = await resolvePartyFilters(query)
    const rows = await adminTransactionsRepository.listCoinLedger({
      id: parties.id,
      userId: parties.userId,
      counterpartyId: parties.counterpartyId ?? parties.receiverUserId ?? parties.senderUserId,
      types: query.types,
      direction: query.direction,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
      currencyType: WalletCurrencyType.TRADING_COIN,
    })
    const { page, nextCursor, hasMore } = pageSlice(rows, query.limit)
    return {
      entries: await enrichCoinLedgerRows(page),
      nextCursor,
      hasMore,
    }
  },

  async listPointTransactions(query: AdminTransactionsListQuery) {
    const parties = await resolvePartyFilters(query)
    const rows = await adminTransactionsRepository.listPointLedger({
      id: parties.id,
      userId: parties.userId,
      counterpartyId: parties.counterpartyId ?? parties.receiverUserId ?? parties.senderUserId,
      types: query.types,
      direction: query.direction,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    })
    const { page, nextCursor, hasMore } = pageSlice(rows, query.limit)
    return {
      entries: await enrichPointLedgerRows(page),
      nextCursor,
      hasMore,
    }
  },

  async listCoinTradingTransfers(query: AdminTransactionsListQuery) {
    const parties = await resolvePartyFilters(query)
    const rows = await adminTransactionsRepository.listCoinTradingTransfers({
      id: parties.id,
      userId: parties.userId,
      senderUserId: parties.senderUserId,
      receiverUserId: parties.receiverUserId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    })
    const { page, nextCursor, hasMore } = pageSlice(rows, query.limit)
    return {
      entries: page.map((t) => ({
        id: t.id,
        sender: mapUserBrief(t.senderAgent),
        receiver: mapUserBrief(t.recipient),
        tradingCoinsDebited: t.tradingCoinsDebited.toString(),
        coinsCredited: t.coinsCredited.toString(),
        recipientWalletType: t.recipientWalletType,
        senderLedgerEntryId: t.senderLedgerEntryId,
        recipientLedgerEntryId: t.recipientLedgerEntryId,
        reversedAt: t.reversedAt?.toISOString() ?? null,
        reverseReason: t.reverseReason,
        reversedBy: t.reversedBy ? mapUserBrief(t.reversedBy) : null,
        createdAt: t.createdAt.toISOString(),
        canRevert: t.reversedAt == null,
      })),
      nextCursor,
      hasMore,
    }
  },

  async listGiftTransactions(query: AdminTransactionsListQuery) {
    const parties = await resolvePartyFilters(query)
    const rows = await adminTransactionsRepository.listGiftTransactions({
      id: parties.id,
      userId: parties.userId,
      senderUserId: parties.senderUserId,
      receiverUserId: parties.receiverUserId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    })
    const { page, nextCursor, hasMore } = pageSlice(rows, query.limit)
    const giftIds = page.map((g) => g.id)
    const existing = await adminTransactionsRepository.findExistingGiftReversals(giftIds)
    const reverted = new Set(existing.map((e) => e.giftTransactionId))
    return {
      entries: page.map((g) => ({
        id: g.id,
        sender: mapUserBrief(g.sender),
        receiver: mapUserBrief(g.receiver),
        gift: {
          id: g.gift.id,
          name: g.gift.name,
          code: g.gift.code,
          displayImageUrl: g.gift.displayImageUrl,
          catalogCoinCost: g.gift.coinCost,
          vipOnly: g.gift.vipOnly,
        },
        coinCost: g.coinCost,
        pointsAwarded: g.pointsAwarded,
        quantity: g.quantity,
        context: g.context,
        createdAt: g.createdAt.toISOString(),
        canRevert: !reverted.has(g.id),
      })),
      nextCursor,
      hasMore,
    }
  },

  async listSubscriptions(query: AdminTransactionsListQuery) {
    const parties = await resolvePartyFilters(query)
    const rows = await adminTransactionsRepository.listSubscriptions({
      id: parties.id,
      userId: parties.userId,
      senderUserId: parties.senderUserId,
      receiverUserId: parties.receiverUserId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    })
    const { page, nextCursor, hasMore } = pageSlice(rows, query.limit)
    return {
      entries: page.map((s) => ({
        id: s.id,
        status: s.status,
        subscriber: mapUserBrief(s.subscriber),
        creator: mapUserBrief(s.creator),
        nextRenewalAt: s.nextRenewalAt.toISOString(),
        graceUntil: s.graceUntil?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    }
  },

  async listVipPurchases(query: AdminTransactionsListQuery) {
    const parties = await resolvePartyFilters(query)
    const rows = await adminTransactionsRepository.listVipPurchases({
      id: parties.id,
      userId: parties.userId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    })
    const { page, nextCursor, hasMore } = pageSlice(rows, query.limit)
    return {
      entries: page.map((p) => ({
        id: p.id,
        user: mapUserBrief(p.user),
        tier: p.tier,
        periodDays: p.periodDays,
        coinCost: p.coinCost.toString(),
        ledgerEntryId: p.ledgerEntryId,
        ledgerEntry: {
          id: p.ledgerEntry.id,
          amount: p.ledgerEntry.amount.toString(),
          direction: p.ledgerEntry.direction,
          txType: p.ledgerEntry.txType,
          balanceAfter: p.ledgerEntry.balanceAfter.toString(),
          createdAt: p.ledgerEntry.createdAt.toISOString(),
        },
        expiresAtBefore: p.expiresAtBefore?.toISOString() ?? null,
        expiresAtAfter: p.expiresAtAfter.toISOString(),
        createdAt: p.createdAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    }
  },

  async listStorePurchases(query: AdminTransactionsListQuery) {
    const parties = await resolvePartyFilters(query)
    const rows = await adminTransactionsRepository.listStorePurchases({
      id: parties.id,
      userId: parties.userId,
      senderUserId: parties.senderUserId,
      receiverUserId: parties.receiverUserId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    })
    const { page, nextCursor, hasMore } = pageSlice(rows, query.limit)
    return {
      entries: page.map((p) => ({
        id: p.id,
        recipient: mapUserBrief(p.user),
        buyer: mapUserBrief(p.purchasedBy),
        storeItem: {
          id: p.storeItem.id,
          name: p.storeItem.name,
          category: p.storeItem.category,
          coinCost: p.storeItem.coinCost,
          displayImageUrl: p.storeItem.displayImageUrl,
          effectUrl: p.storeItem.effectUrl,
          validityDays: p.storeItem.validityDays,
        },
        coinsPaid: p.coinsPaid,
        isActive: p.isActive,
        isApplied: p.isApplied,
        expiresAt: p.expiresAt.toISOString(),
        activatedAt: p.activatedAt?.toISOString() ?? null,
        expiredAt: p.expiredAt?.toISOString() ?? null,
        revokedAt: p.revokedAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    }
  },

  /**
   * Revert a coin (personal or trading) ledger peer transfer:
   * 1) debit receiver  2) credit sender. Fails if receiver lacks balance.
   */
  async revertCoinLedgerEntry(params: {
    ledgerEntryId: string
    adminUserId: string
    reason: string
    idempotencyKey?: string
  }) {
    const entry = await adminTransactionsRepository.findCoinLedgerById(params.ledgerEntryId)
    if (!entry) throw new AppError(404, 'Ledger entry not found', 'LEDGER_ENTRY_NOT_FOUND')

    const existing = await adminTransactionsRepository.findExistingCoinReversal(entry.id)
    if (existing) {
      throw new AppError(409, 'Ledger entry already reverted', 'ALREADY_REVERTED')
    }

    const { senderUserId, receiverUserId } = resolvePeerParties({
      direction: entry.direction,
      walletUserId: entry.wallet.userId,
      counterpartyId: entry.counterpartyId,
    })
    const currencyType = entry.wallet.currencyType
    const amount = entry.amount
    const baseKey =
      params.idempotencyKey?.trim() || `admin-revert:coin:${entry.id}:${randomUUID()}`

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const debit = await coinWalletService.debit(
            receiverUserId,
            amount,
            currencyType === WalletCurrencyType.TRADING_COIN
              ? CoinTxType.TRADING_TRANSFER_REVERSAL
              : CoinTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `admin-revert:coin:${entry.id}:debit`,
              description: `Admin revert debit: ${params.reason}`.slice(0, 500),
              counterpartyId: senderUserId,
              currencyType,
              applyWealthXp: false,
              metadata: {
                adminUserId: params.adminUserId,
                source: 'admin_transaction_revert',
                originalLedgerEntryId: entry.id,
                reason: params.reason,
              },
            },
          )
          const credit = await coinWalletService.credit(
            senderUserId,
            amount,
            currencyType === WalletCurrencyType.TRADING_COIN
              ? CoinTxType.TRADING_TRANSFER_REVERSAL
              : CoinTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `admin-revert:coin:${entry.id}:credit`,
              description: `Admin revert credit: ${params.reason}`.slice(0, 500),
              counterpartyId: receiverUserId,
              currencyType,
              applyWealthCredit: false,
              metadata: {
                adminUserId: params.adminUserId,
                source: 'admin_transaction_revert',
                originalLedgerEntryId: entry.id,
                reason: params.reason,
              },
            },
          )
          return { debit, credit }
        },
        { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
      )

      if (currencyType === WalletCurrencyType.COIN) {
        await walletService.adjustCoinBalanceCache(receiverUserId, -amount)
        await walletService.adjustCoinBalanceCache(senderUserId, amount)
      } else {
        await walletService.adjustTradingBalanceCache(receiverUserId)
        await walletService.adjustTradingBalanceCache(senderUserId)
      }

      auditService.log({
        userId: params.adminUserId,
        actionType: 'ADMIN_TRANSACTION_REVERT_COIN',
        actionStatus: 'success',
        actionDetails: {
          originalLedgerEntryId: entry.id,
          senderUserId,
          receiverUserId,
          amount: amount.toString(),
          currencyType,
          reason: params.reason,
          debitLedgerEntryId: result.debit.ledgerEntryId,
          creditLedgerEntryId: result.credit.ledgerEntryId,
          idempotencyKey: baseKey,
        },
      })

      return {
        ok: true as const,
        originalLedgerEntryId: entry.id,
        senderUserId,
        receiverUserId,
        amount: amount.toString(),
        currencyType,
        debitLedgerEntryId: result.debit.ledgerEntryId,
        creditLedgerEntryId: result.credit.ledgerEntryId,
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'INSUFFICIENT_COINS') {
        if (currencyType === WalletCurrencyType.TRADING_COIN) {
          throw new AppError(
            402,
            'Insufficient trading coins on receiver to revert',
            'INSUFFICIENT_TRADING_COINS',
            err.details,
          )
        }
        throw new AppError(
          402,
          'Insufficient coins on receiver to revert',
          'INSUFFICIENT_COINS',
          err.details,
        )
      }
      throw err
    }
  },

  async revertPointLedgerEntry(params: {
    ledgerEntryId: string
    adminUserId: string
    reason: string
    idempotencyKey?: string
  }) {
    const entry = await adminTransactionsRepository.findPointLedgerById(params.ledgerEntryId)
    if (!entry) throw new AppError(404, 'Ledger entry not found', 'LEDGER_ENTRY_NOT_FOUND')

    const existing = await adminTransactionsRepository.findExistingPointReversal(entry.id)
    if (existing) {
      throw new AppError(409, 'Ledger entry already reverted', 'ALREADY_REVERTED')
    }

    const { senderUserId, receiverUserId } = resolvePeerParties({
      direction: entry.direction,
      walletUserId: entry.wallet.userId,
      counterpartyId: entry.counterpartyId,
    })
    const amount = entry.amount
    const baseKey =
      params.idempotencyKey?.trim() || `admin-revert:point:${entry.id}:${randomUUID()}`

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const debit = await pointWalletService.debit(
            receiverUserId,
            amount,
            PointTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `admin-revert:point:${entry.id}:debit`,
              description: `Admin revert debit: ${params.reason}`.slice(0, 500),
              counterpartyId: senderUserId,
              availabilityCheck: true,
              metadata: {
                adminUserId: params.adminUserId,
                source: 'admin_transaction_revert',
                originalLedgerEntryId: entry.id,
                reason: params.reason,
              },
            },
          )
          const credit = await pointWalletService.creditInTransaction(
            senderUserId,
            amount,
            PointTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `admin-revert:point:${entry.id}:credit`,
              description: `Admin revert credit: ${params.reason}`.slice(0, 500),
              counterpartyId: receiverUserId,
              applyLivestreamLevel: false,
              metadata: {
                adminUserId: params.adminUserId,
                source: 'admin_transaction_revert',
                originalLedgerEntryId: entry.id,
                reason: params.reason,
              },
            },
          )
          return { debit, credit }
        },
        { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
      )

      await walletService.adjustPointBalanceCache(receiverUserId, -amount)
      await walletService.adjustPointBalanceCache(senderUserId, amount)

      auditService.log({
        userId: params.adminUserId,
        actionType: 'ADMIN_TRANSACTION_REVERT_POINT',
        actionStatus: 'success',
        actionDetails: {
          originalLedgerEntryId: entry.id,
          senderUserId,
          receiverUserId,
          amount: amount.toString(),
          reason: params.reason,
          debitLedgerEntryId: result.debit.ledgerEntryId,
          creditLedgerEntryId: result.credit.ledgerEntryId,
          idempotencyKey: baseKey,
        },
      })

      return {
        ok: true as const,
        originalLedgerEntryId: entry.id,
        senderUserId,
        receiverUserId,
        amount: amount.toString(),
        debitLedgerEntryId: result.debit.ledgerEntryId,
        creditLedgerEntryId: result.credit.ledgerEntryId,
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'INSUFFICIENT_POINTS') {
        throw new AppError(
          402,
          'Insufficient points on receiver to revert',
          'INSUFFICIENT_POINTS',
          err.details,
        )
      }
      throw err
    }
  },

  /**
   * Gift revert (cross-currency): debit points from receiver, then credit coins to sender.
   */
  async revertGiftTransaction(params: {
    giftTransactionId: string
    adminUserId: string
    reason: string
  }) {
    const giftTx = await adminTransactionsRepository.findGiftTransactionById(
      params.giftTransactionId,
    )
    if (!giftTx) throw new AppError(404, 'Gift transaction not found', 'GIFT_TRANSACTION_NOT_FOUND')

    const existing = await adminTransactionsRepository.findExistingGiftReversal(giftTx.id)
    if (existing) {
      throw new AppError(409, 'Gift transaction already reverted', 'ALREADY_REVERTED')
    }

    const points = BigInt(giftTx.pointsAwarded)
    const coins = BigInt(giftTx.coinCost)

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const debit = await pointWalletService.debit(
            giftTx.receiverUserId,
            points,
            PointTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `admin-revert:gift:${giftTx.id}:debit`,
              description: `Admin gift revert (points): ${params.reason}`.slice(0, 500),
              counterpartyId: giftTx.senderUserId,
              refId: giftTx.id,
              availabilityCheck: true,
              metadata: {
                adminUserId: params.adminUserId,
                source: 'admin_gift_revert',
                giftTransactionId: giftTx.id,
                reason: params.reason,
              },
            },
          )
          const credit = await coinWalletService.credit(
            giftTx.senderUserId,
            coins,
            CoinTxType.GIFT_REFUND,
            tx,
            {
              idempotencyKey: `admin-revert:gift:${giftTx.id}:credit`,
              description: `Admin gift revert (coins): ${params.reason}`.slice(0, 500),
              counterpartyId: giftTx.receiverUserId,
              currencyType: WalletCurrencyType.COIN,
              applyWealthCredit: false,
              metadata: {
                adminUserId: params.adminUserId,
                source: 'admin_gift_revert',
                giftTransactionId: giftTx.id,
                reason: params.reason,
              },
            },
          )
          return { debit, credit }
        },
        { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
      )

      await walletService.adjustCoinBalanceCache(giftTx.senderUserId, coins)
      await walletService.adjustPointBalanceCache(giftTx.receiverUserId, -points)

      auditService.log({
        userId: params.adminUserId,
        actionType: 'ADMIN_TRANSACTION_REVERT_GIFT',
        actionStatus: 'success',
        actionDetails: {
          giftTransactionId: giftTx.id,
          senderUserId: giftTx.senderUserId,
          receiverUserId: giftTx.receiverUserId,
          coins: coins.toString(),
          points: points.toString(),
          reason: params.reason,
          debitPointLedgerEntryId: result.debit.ledgerEntryId,
          creditCoinLedgerEntryId: result.credit.ledgerEntryId,
        },
      })

      return {
        ok: true as const,
        giftTransactionId: giftTx.id,
        senderUserId: giftTx.senderUserId,
        receiverUserId: giftTx.receiverUserId,
        coinsCredited: coins.toString(),
        pointsDebited: points.toString(),
        debitPointLedgerEntryId: result.debit.ledgerEntryId,
        creditCoinLedgerEntryId: result.credit.ledgerEntryId,
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'INSUFFICIENT_POINTS') {
        throw new AppError(
          402,
          'Insufficient points on receiver to revert gift',
          'INSUFFICIENT_POINTS',
          err.details,
        )
      }
      throw err
    }
  },

  /** Coin-trading transfer revert — debit recipient first, then credit sender. */
  async revertCoinTradingTransfer(params: {
    transferId: string
    adminUserId: string
    reason: string
  }) {
    const transfer = await coinTradingRepository.getTransferById(params.transferId)
    if (!transfer) throw new AppError(404, 'Transfer not found', 'TRANSFER_NOT_FOUND')
    if (transfer.reversedAt) {
      throw new AppError(409, 'Transfer already reversed', 'TRANSFER_ALREADY_REVERSED')
    }

    await coinTradingService.reverseTransfer(
      params.adminUserId,
      params.transferId,
      params.reason,
    )

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_TRANSACTION_REVERT_TRADING_TRANSFER',
      actionStatus: 'success',
      actionDetails: {
        transferId: transfer.id,
        reason: params.reason,
        senderAgentUserId: transfer.senderAgentUserId,
        recipientUserId: transfer.recipientUserId,
      },
    })

    return {
      ok: true as const,
      transferId: transfer.id,
      senderUserId: transfer.senderAgentUserId,
      receiverUserId: transfer.recipientUserId,
      tradingCoinsCreditedToSender: transfer.tradingCoinsDebited.toString(),
      coinsDebitedFromReceiver: transfer.coinsCredited.toString(),
      recipientWalletType: transfer.recipientWalletType,
    }
  },
}

type CoinLedgerRow = Awaited<
  ReturnType<typeof adminTransactionsRepository.listCoinLedger>
>[number]
type PointLedgerRow = Awaited<
  ReturnType<typeof adminTransactionsRepository.listPointLedger>
>[number]

async function enrichCoinLedgerRows(page: CoinLedgerRow[]) {
  const counterpartyIds = page
    .map((e) => e.counterpartyId)
    .filter((id): id is string => typeof id === 'string')
  const users = await adminTransactionsRepository.findUsersByIds(counterpartyIds)
  const userMap = new Map(users.map((u) => [u.id, u]))

  const giftTxIds = page
    .map((e) => e.refId ?? readMetaString(e.metadata, 'giftTransactionId'))
    .filter((id): id is string => !!id && UUID_RE.test(id))
  const giftTxs = await adminTransactionsRepository.findGiftTransactionsByIds(giftTxIds)
  const giftTxMap = new Map(giftTxs.map((g) => [g.id, g]))

  const storeItemIds = page
    .map((e) => readMetaString(e.metadata, 'storeItemId'))
    .filter((id): id is string => !!id)
  const storeItems = await adminTransactionsRepository.findStoreItemsByIds(storeItemIds)
  const storeMap = new Map(storeItems.map((s) => [s.id, s]))

  const vipByLedger = await adminTransactionsRepository.findVipPurchasesByLedgerIds(
    page.map((e) => e.id),
  )
  const vipMap = new Map(vipByLedger.map((v) => [v.ledgerEntryId, v]))

  const transferLinks = await coinTradingRepository.findTransfersByLedgerEntryIds(
    page.map((e) => e.id),
  )
  const transferByLedger = new Map<string, (typeof transferLinks)[number]>()
  for (const t of transferLinks) {
    transferByLedger.set(t.senderLedgerEntryId, t)
    transferByLedger.set(t.recipientLedgerEntryId, t)
  }

  return page.map((e) => {
    const cp = e.counterpartyId ? userMap.get(e.counterpartyId) : undefined
    const giftRef = e.refId ?? readMetaString(e.metadata, 'giftTransactionId')
    const giftTx = giftRef ? giftTxMap.get(giftRef) : undefined
    const storeItemId = readMetaString(e.metadata, 'storeItemId')
    const storeItem = storeItemId ? storeMap.get(storeItemId) : undefined
    const vip = vipMap.get(e.id)
    const tradingTransfer = transferByLedger.get(e.id)

    return {
      id: e.id,
      direction: e.direction,
      txType: e.txType,
      transactionName: getTransactionName(
        e.wallet.currencyType === 'TRADING_COIN' ? 'TRADING_COIN' : 'COIN',
        e.txType,
        e.direction,
      ),
      amount: e.amount.toString(),
      balanceAfter: e.balanceAfter.toString(),
      refId: e.refId,
      description: e.description,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
      currencyType: e.wallet.currencyType,
      user: mapUserBrief(e.wallet.user),
      counterparty: cp ? mapUserBrief(cp) : null,
      gift: giftTx
        ? {
            giftTransactionId: giftTx.id,
            giftId: giftTx.gift.id,
            giftName: giftTx.gift.name,
            displayImageUrl: giftTx.gift.displayImageUrl,
            coinCost: giftTx.coinCost,
            pointsAwarded: giftTx.pointsAwarded,
            quantity: giftTx.quantity,
          }
        : null,
      storeItem: storeItem
        ? {
            id: storeItem.id,
            name: storeItem.name,
            category: storeItem.category,
            coinCost: storeItem.coinCost,
            displayImageUrl: storeItem.displayImageUrl,
          }
        : null,
      vipPurchase: vip
        ? {
            id: vip.id,
            tier: vip.tier,
            periodDays: vip.periodDays,
            coinCost: vip.coinCost.toString(),
            expiresAtAfter: vip.expiresAtAfter.toISOString(),
          }
        : null,
      coinTradingTransfer: tradingTransfer
        ? {
            id: tradingTransfer.id,
            tradingCoinsDebited: tradingTransfer.tradingCoinsDebited.toString(),
            coinsCredited: tradingTransfer.coinsCredited.toString(),
            recipientWalletType: tradingTransfer.recipientWalletType,
          }
        : null,
      canRevert: Boolean(e.counterpartyId),
    }
  })
}

async function enrichPointLedgerRows(page: PointLedgerRow[]) {
  const counterpartyIds = page
    .map((e) => e.counterpartyId)
    .filter((id): id is string => typeof id === 'string')
  const users = await adminTransactionsRepository.findUsersByIds(counterpartyIds)
  const userMap = new Map(users.map((u) => [u.id, u]))

  const giftTxIds = page
    .map((e) => e.refId ?? readMetaString(e.metadata, 'giftTransactionId'))
    .filter((id): id is string => !!id && UUID_RE.test(id))
  const giftTxs = await adminTransactionsRepository.findGiftTransactionsByIds(giftTxIds)
  const giftTxMap = new Map(giftTxs.map((g) => [g.id, g]))

  return page.map((e) => {
    const cp = e.counterpartyId ? userMap.get(e.counterpartyId) : undefined
    const giftRef = e.refId ?? readMetaString(e.metadata, 'giftTransactionId')
    const giftTx = giftRef ? giftTxMap.get(giftRef) : undefined

    return {
      id: e.id,
      direction: e.direction,
      txType: e.txType,
      transactionName: getTransactionName('POINT', e.txType, e.direction),
      amount: e.amount.toString(),
      balanceAfter: e.balanceAfter.toString(),
      refId: e.refId,
      description: e.description,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
      user: mapUserBrief(e.wallet.user),
      counterparty: cp ? mapUserBrief(cp) : null,
      gift: giftTx
        ? {
            giftTransactionId: giftTx.id,
            giftId: giftTx.gift.id,
            giftName: giftTx.gift.name,
            displayImageUrl: giftTx.gift.displayImageUrl,
            coinCost: giftTx.coinCost,
            pointsAwarded: giftTx.pointsAwarded,
            quantity: giftTx.quantity,
          }
        : null,
      canRevert: Boolean(e.counterpartyId),
    }
  })
}
