import {
  CoinTxType,
  LedgerDirection,
  LevelType,
  PointTxType,
  WalletCurrencyType,
} from '@prisma/client'
import { randomUUID } from 'crypto'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import type { AdminTransactionsListQuery } from '../models/admin-transactions.schemas'
import {
  adminTransactionsRepository,
  type AdminTxnUserRow,
} from '../repositories/admin-transactions.repository'
import { coinTradingRepository } from '../repositories/coinTrading.repository'
import { walletRepository } from '../repositories/wallet.repository'
import { lockWalletsInOrder } from '../utils/wallet-lock-order'
import { getTransactionName } from '../config/transaction-display-names'
import { buildUserDisplayName, formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import {
  ADMIN_WITHDRAWAL_LEDGER_TX_TYPES,
  isAdminWithdrawalRevertable,
} from '../utils/admin-withdrawal-revert'
import { auditService } from './audit.service'
import { coinWalletService } from './coin-wallet.service'
import { pointWalletService } from './point-wallet.service'
import { coinTradingService } from './coinTrading.service'
import { withdrawalService } from './withdrawal.service'
import { walletService } from './wallet.service'
import { syncLevelCacheFromApplyResult, walletLevelService } from './user-level.service'
import { agencyCommissionService } from './agencyCommission.service'
import {
  buildAdminCounterpartyDetailsMap,
  type CounterpartyDetails,
} from '../utils/ledger-transaction-enrichment'
import { platformProfitService } from './platform-profit.service'
import { ZERO_PLATFORM_PROFIT } from '../utils/platform-profit'

const TX_TIMEOUT_MS = 20_000

/** Point rows whose original funding was personal COIN (not point-wallet source). */
const COIN_FUNDED_POINT_TX_TYPES = new Set<PointTxType>([
  PointTxType.GIFT_RECEIVE,
  PointTxType.LIVESTREAM_GIFT,
  PointTxType.VIDEO_CALL,
  PointTxType.SUBSCRIPTION,
  PointTxType.GUARDIAN_PURCHASE,
])

/** Point credit types that awarded livestream XP (and may have agency commission). */
const LIVESTREAM_REVERT_POINT_TYPES = COIN_FUNDED_POINT_TX_TYPES

/**
 * True point-wallet peer movements (points leave/enter POINT wallets).
 * Not: coin→points earnings, platform rewards, payroll, or points→trading exchange.
 */
const POINT_WALLET_SOURCE_PEER_TYPES = new Set<PointTxType>([
  PointTxType.AGENT_POINT_TRANSFER,
  PointTxType.TRANSFER_IN,
])

/** Shared with per-user admin history. */
export function resolvePointLedgerRevertability(params: {
  txType: PointTxType
  counterpartyId: string | null | undefined
}): boolean {
  if (!params.counterpartyId) return false
  if (COIN_FUNDED_POINT_TX_TYPES.has(params.txType)) return false
  return POINT_WALLET_SOURCE_PEER_TYPES.has(params.txType)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AdminUserBrief = {
  userId: string
  username: string
  name: string
  displayName: string
  publicId: string
  displayPublicId: string
  avatarUrl: string | null
}

function mapUserBrief(u: AdminTxnUserRow): AdminUserBrief {
  return {
    userId: u.id,
    username: u.username,
    name: formatUserName(u),
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
  const senderUserId = query.senderUserId
  const receiverUserId = query.receiverUserId
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
    let ledgerId = parties.id
    if (ledgerId) {
      const senderLedgerId =
        await adminTransactionsRepository.findCoinTradingTransferSenderLedgerId(ledgerId)
      if (senderLedgerId) ledgerId = senderLedgerId
    }
    const rows = await adminTransactionsRepository.listCoinLedger({
      id: ledgerId,
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
        /** Always null historically (field wrongly FK'd to users); prefer reversedByAdminId. */
        reversedBy: null,
        reversedByAdminId: t.reversedByAdminId,
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
    const agencyByRef = await platformProfitService.sumAgencyCommissionByRefIds(giftIds)
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
        // Gift funding source is personal COIN — not admin-revertable under
        // point / trading-coin source-wallet policy.
        canRevert: false as const,
        alreadyReverted: reverted.has(g.id),
        platformProfit: platformProfitService.profitForGiftRow({
          coinCost: g.coinCost,
          pointsAwarded: g.pointsAwarded,
          agencyCommissionPoints: agencyByRef.get(g.id) ?? 0n,
        }),
      })),
      nextCursor,
      hasMore,
    }
  },

  async getPlatformProfitSummary(query: { from?: string; to?: string }) {
    const totals = await platformProfitService.summarizePlatformProfit({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    })
    return { platformProfitTotals: totals }
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
        platformProfit: platformProfitService.profitForFullCoinSpend(p.coinCost),
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
        platformProfit: platformProfitService.profitForFullCoinSpend(BigInt(p.coinsPaid)),
      })),
      nextCursor,
      hasMore,
    }
  },

  /**
   * Revert a **TRADING_COIN** ledger peer transfer:
   * 1) debit receiver  2) credit sender. Fails if receiver lacks balance.
   *
   * Personal COIN ledger rows are not revertible via this route (`NOT_REVERTABLE`).
   * Use `POST …/coin-trading-transfers/:transferId/revert` or gift revert instead.
   */
  async revertCoinLedgerEntry(params: {
    ledgerEntryId: string
    adminUserId: string
    reason: string
    idempotencyKey?: string
  }) {
    const entry = await adminTransactionsRepository.findCoinLedgerById(params.ledgerEntryId)
    if (!entry) throw new AppError(404, 'Ledger entry not found', 'LEDGER_ENTRY_NOT_FOUND')

    if (entry.wallet.currencyType !== WalletCurrencyType.TRADING_COIN) {
      const linkedTransfers = await coinTradingRepository.findTransfersByLedgerEntryIds([entry.id])
      const linked = linkedTransfers[0]
      throw new AppError(
        400,
        linked
          ? 'Personal coin ledger rows are not revertible here — use POST /admin/transactions/coin-trading-transfers/:transferId/revert'
          : 'Only TRADING_COIN ledger peer rows are revertible via this endpoint',
        'NOT_REVERTABLE',
        linked ? { transferId: linked.id } : undefined,
      )
    }

    const existing = await adminTransactionsRepository.findExistingCoinReversal(entry.id)
    if (existing) {
      throw new AppError(409, 'Ledger entry already reverted', 'ALREADY_REVERTED')
    }

    const { senderUserId, receiverUserId } = resolvePeerParties({
      direction: entry.direction,
      walletUserId: entry.wallet.userId,
      counterpartyId: entry.counterpartyId,
    })
    const currencyType = WalletCurrencyType.TRADING_COIN
    const amount = entry.amount
    const baseKey = params.idempotencyKey?.trim() || `admin-revert:coin:${entry.id}:${randomUUID()}`

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // Deterministic id-order locking (not receiver-then-sender) so this
          // can never lock-order-invert against a concurrent live transfer on
          // the same wallet pair, which locks via the same helper.
          const receiverWallet = await walletRepository.getOrCreate(
            receiverUserId,
            currencyType,
            tx,
          )
          const senderWallet = await walletRepository.getOrCreate(senderUserId, currencyType, tx)
          await lockWalletsInOrder(tx, [receiverWallet, senderWallet])

          const debit = await coinWalletService.debit(
            receiverUserId,
            amount,
            CoinTxType.TRADING_TRANSFER_REVERSAL,
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
            CoinTxType.TRADING_TRANSFER_REVERSAL,
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
        { timeout: TX_TIMEOUT_MS },
      )

      await walletService.adjustTradingBalanceCache(receiverUserId)
      await walletService.adjustTradingBalanceCache(senderUserId)

      auditService.logAdmin({
        adminUserId: params.adminUserId,
        targetUserId: receiverUserId,
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
          wealthXpReversed: false,
          idempotencyKey: baseKey,
        },
        destination: `Revert coin ledger ${entry.id}`,
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
        sideEffects: {
          wealthXpReversed: false,
          livestreamXpReversed: false,
          agencyCommissionReversed: false,
        },
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'INSUFFICIENT_COINS') {
        throw new AppError(
          402,
          'Insufficient trading coins on receiver to revert',
          'INSUFFICIENT_TRADING_COINS',
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

    if (
      ADMIN_WITHDRAWAL_LEDGER_TX_TYPES.has(entry.txType) &&
      entry.refId &&
      UUID_RE.test(entry.refId)
    ) {
      const row = await withdrawalService.adminReverseWithdrawal(
        params.adminUserId,
        entry.refId,
        params.reason,
      )
      return {
        ok: true as const,
        via: 'withdrawal' as const,
        withdrawal: withdrawalService.serializeWithdrawal(row),
      }
    }

    if (
      !resolvePointLedgerRevertability({
        txType: entry.txType,
        counterpartyId: entry.counterpartyId,
      })
    ) {
      throw new AppError(
        400,
        COIN_FUNDED_POINT_TX_TYPES.has(entry.txType)
          ? 'This point credit was funded from personal COIN (not a point-wallet transfer) and is not admin-revertable'
          : 'Only point-wallet peer transfers (e.g. agent point transfer) are revertible via this endpoint',
        'NOT_REVERTABLE',
      )
    }

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
          // Deterministic id-order locking (not receiver-then-sender) so this
          // can never lock-order-invert against a concurrent live transfer on
          // the same wallet pair, which locks via the same helper.
          const receiverWallet = await walletRepository.getOrCreate(
            receiverUserId,
            WalletCurrencyType.POINT,
            tx,
          )
          const senderWallet = await walletRepository.getOrCreate(
            senderUserId,
            WalletCurrencyType.POINT,
            tx,
          )
          await lockWalletsInOrder(tx, [receiverWallet, senderWallet])

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

          let livestreamResult = null
          let commission = {
            bustAgentUserId: null as string | null,
            reversed: false,
            commissionPoints: null as string | null,
          }

          // Side effects were applied on the original host CREDIT row.
          if (
            entry.direction === LedgerDirection.CREDIT &&
            LIVESTREAM_REVERT_POINT_TYPES.has(entry.txType)
          ) {
            livestreamResult = await walletLevelService.applyDebit(
              tx,
              receiverUserId,
              LevelType.LIVESTREAM,
              amount,
            )
            commission = await agencyCommissionService.reverseCommission(
              { hostLedgerEntryId: entry.id, reason: params.reason },
              tx,
            )
          }

          return { debit, credit, livestreamResult, commission }
        },
        { timeout: TX_TIMEOUT_MS },
      )

      await walletService.adjustPointBalanceCache(receiverUserId, -amount)
      await walletService.adjustPointBalanceCache(senderUserId, amount)
      await syncLevelCacheFromApplyResult(
        receiverUserId,
        LevelType.LIVESTREAM,
        result.livestreamResult,
      )
      if (result.commission.bustAgentUserId) {
        await agencyCommissionService.afterCommissionCreditCommit(result.commission.bustAgentUserId)
      }

      auditService.logAdmin({
        adminUserId: params.adminUserId,
        targetUserId: receiverUserId,
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
          livestreamXpReversed: Boolean(result.livestreamResult),
          agencyCommissionReversed: result.commission.reversed,
          commissionPoints: result.commission.commissionPoints,
          idempotencyKey: baseKey,
        },
        destination: `Revert point ledger ${entry.id}`,
      })

      return {
        ok: true as const,
        originalLedgerEntryId: entry.id,
        senderUserId,
        receiverUserId,
        amount: amount.toString(),
        debitLedgerEntryId: result.debit.ledgerEntryId,
        creditLedgerEntryId: result.credit.ledgerEntryId,
        sideEffects: {
          wealthXpReversed: false,
          livestreamXpReversed: Boolean(result.livestreamResult),
          agencyCommissionReversed: result.commission.reversed,
          commissionPoints: result.commission.commissionPoints,
        },
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
   * Gift revert disabled — gifts are funded from personal COIN.
   * Admin reverts are limited to POINT / TRADING_COIN sourced movements.
   */
  async revertGiftTransaction(_params: {
    giftTransactionId: string
    adminUserId: string
    reason: string
  }) {
    throw new AppError(
      400,
      'Gift transactions are not admin-revertable (funded from personal COIN, not points or trading coins)',
      'NOT_REVERTABLE',
    )
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

    await coinTradingService.reverseTransfer(params.adminUserId, params.transferId, params.reason)

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: transfer.recipientUserId,
      actionType: 'ADMIN_TRANSACTION_REVERT_TRADING_TRANSFER',
      actionStatus: 'success',
      actionDetails: {
        transferId: transfer.id,
        reason: params.reason,
        senderAgentUserId: transfer.senderAgentUserId,
        recipientUserId: transfer.recipientUserId,
      },
      destination: `Revert trading transfer ${transfer.id}`,
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

type CoinLedgerRow = Awaited<ReturnType<typeof adminTransactionsRepository.listCoinLedger>>[number]
type PointLedgerRow = Awaited<
  ReturnType<typeof adminTransactionsRepository.listPointLedger>
>[number]

function walletContextForCoinRow(currencyType: WalletCurrencyType): 'COIN' | 'TRADING_COIN' {
  return currencyType === WalletCurrencyType.TRADING_COIN ? 'TRADING_COIN' : 'COIN'
}

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

  // Personal COIN GIFT_SEND rows usually lack refId — resolve gift_transactions heuristically.
  const unresolvedGiftSends = page.filter((e) => {
    if (e.txType !== CoinTxType.GIFT_SEND || !e.counterpartyId) return false
    const direct = e.refId ?? readMetaString(e.metadata, 'giftTransactionId')
    return !(direct && giftTxMap.has(direct))
  })
  const nearGifts = await adminTransactionsRepository.findGiftTransactionsNearCoinDebits(
    unresolvedGiftSends.map((e) => ({
      senderUserId: e.wallet.user.id,
      receiverUserId: e.counterpartyId!,
      coinCost: Number(e.amount),
      giftId: readMetaString(e.metadata, 'giftId'),
      createdAt: e.createdAt,
    })),
  )
  for (const g of nearGifts) giftTxMap.set(g.id, g)

  const giftTxByLedgerId = new Map<string, (typeof nearGifts)[number]>()
  for (const e of unresolvedGiftSends) {
    const giftId = readMetaString(e.metadata, 'giftId')
    const matches = nearGifts.filter(
      (g) =>
        g.senderUserId === e.wallet.user.id &&
        g.receiverUserId === e.counterpartyId &&
        g.coinCost === Number(e.amount) &&
        (!giftId || g.giftId === giftId) &&
        Math.abs(g.createdAt.getTime() - e.createdAt.getTime()) <= 15_000,
    )
    if (matches.length === 0) continue
    matches.sort(
      (a, b) =>
        Math.abs(a.createdAt.getTime() - e.createdAt.getTime()) -
        Math.abs(b.createdAt.getTime() - e.createdAt.getTime()),
    )
    giftTxByLedgerId.set(e.id, matches[0]!)
  }

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

  const giftIdsForProfit = [
    ...new Set(
      [
        ...[...giftTxMap.values()].map((g) => g.id),
        ...[...giftTxByLedgerId.values()].map((g) => g.id),
      ].filter(Boolean),
    ),
  ]
  const splitRefIds = page
    .filter(
      (e) =>
        e.direction === LedgerDirection.DEBIT &&
        e.wallet.currencyType === WalletCurrencyType.COIN &&
        (e.txType === CoinTxType.VIDEO_CALL ||
          e.txType === CoinTxType.CREATOR_SUBSCRIPTION ||
          e.txType === CoinTxType.GUARDIAN_PURCHASE) &&
        e.refId,
    )
    .map((e) => e.refId as string)
  const agencyByRefId = await platformProfitService.sumAgencyCommissionByRefIds([
    ...giftIdsForProfit,
    ...splitRefIds,
  ])
  const hostPointsByRefId = await platformProfitService.sumHostPointsByRefIds(splitRefIds, [
    PointTxType.VIDEO_CALL,
    PointTxType.SUBSCRIPTION,
    PointTxType.GUARDIAN_PURCHASE,
  ])

  // Trading-coin and personal-coin rows can share a page only if currency filter is omitted;
  // our list endpoints always filter by currency, but still partition for safety.
  const coinDetails = await buildAdminCounterpartyDetailsMap(
    page
      .filter((e) => e.wallet.currencyType !== WalletCurrencyType.TRADING_COIN)
      .map((e) => ({
        id: e.id,
        direction: e.direction,
        txType: e.txType,
        amount: e.amount,
        refId: e.refId,
        counterpartyId: e.counterpartyId,
        metadata: e.metadata,
        createdAt: e.createdAt,
        walletUserId: e.wallet.user.id,
      })),
    'COIN',
  )
  const tradingDetails = await buildAdminCounterpartyDetailsMap(
    page
      .filter((e) => e.wallet.currencyType === WalletCurrencyType.TRADING_COIN)
      .map((e) => ({
        id: e.id,
        direction: e.direction,
        txType: e.txType,
        amount: e.amount,
        refId: e.refId,
        counterpartyId: e.counterpartyId,
        metadata: e.metadata,
        createdAt: e.createdAt,
        walletUserId: e.wallet.user.id,
      })),
    'TRADING_COIN',
  )

  return page.map((e) => {
    const cp = e.counterpartyId ? userMap.get(e.counterpartyId) : undefined
    const giftRef = e.refId ?? readMetaString(e.metadata, 'giftTransactionId')
    const giftTx = (giftRef ? giftTxMap.get(giftRef) : undefined) ?? giftTxByLedgerId.get(e.id)
    const storeItemId = readMetaString(e.metadata, 'storeItemId')
    const storeItem = storeItemId ? storeMap.get(storeItemId) : undefined
    const vip = vipMap.get(e.id)
    const tradingTransfer = transferByLedger.get(e.id)
    const counterpartyDetails: CounterpartyDetails =
      (e.wallet.currencyType === WalletCurrencyType.TRADING_COIN
        ? tradingDetails.get(e.id)
        : coinDetails.get(e.id)) ?? null

    return {
      id: e.id,
      direction: e.direction,
      txType: e.txType,
      transactionName: getTransactionName(
        walletContextForCoinRow(e.wallet.currencyType),
        e.txType,
        e.direction,
      ),
      amount: e.amount.toString(),
      balanceAfter: e.balanceAfter.toString(),
      refId: e.refId,
      counterpartyId: e.counterpartyId,
      description: e.description,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
      currencyType: e.wallet.currencyType,
      user: mapUserBrief(e.wallet.user),
      counterparty: cp ? mapUserBrief(cp) : null,
      counterpartyDetails,
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
            reversedAt: tradingTransfer.reversedAt?.toISOString() ?? null,
          }
        : null,
      platformProfit:
        e.direction === LedgerDirection.DEBIT && e.wallet.currencyType === WalletCurrencyType.COIN
          ? platformProfitService.profitForCoinDebitRow({
              txType: e.txType,
              amount: e.amount,
              gift: giftTx
                ? {
                    id: giftTx.id,
                    coinCost: giftTx.coinCost,
                    pointsAwarded: giftTx.pointsAwarded,
                  }
                : null,
              agencyByRefId,
              hostPointsByRefId,
              refId: e.refId,
            })
          : ZERO_PLATFORM_PROFIT,
      ...resolveCoinLedgerRevertability({
        currencyType: e.wallet.currencyType,
        ledgerEntryId: e.id,
        counterpartyId: e.counterpartyId,
        tradingTransfer: tradingTransfer
          ? { id: tradingTransfer.id, reversedAt: tradingTransfer.reversedAt }
          : null,
      }),
    }
  })
}

/**
 * Revert only when funding source is TRADING_COIN (or a trading-transfer)
 * or when listing POINT peers elsewhere. Personal COIN / gifts are never
 * revertable via coin ledger flags — gifts use personal COIN as source.
 */
export type AdminCoinRevertVia = {
  endpoint: 'coin_ledger' | 'coin_trading_transfer' | 'withdrawal'
  id: string
}

/** Exported for per-user admin history parity with global explorer lists. */
export function resolveCoinLedgerRevertability(params: {
  currencyType: WalletCurrencyType
  ledgerEntryId: string
  counterpartyId: string | null
  tradingTransfer: { id: string; reversedAt: Date | null } | null
}): { canRevert: boolean; revertVia: AdminCoinRevertVia | null } {
  // Agent→user (or peer) transfer funded by TRADING_COIN — preferred dedicated path.
  if (params.tradingTransfer && params.tradingTransfer.reversedAt == null) {
    return {
      canRevert: true,
      revertVia: {
        endpoint: 'coin_trading_transfer',
        id: params.tradingTransfer.id,
      },
    }
  }

  // TRADING_COIN peer movement (implementation still needs a peer to reverse).
  if (params.currencyType === WalletCurrencyType.TRADING_COIN && Boolean(params.counterpartyId)) {
    return {
      canRevert: true,
      revertVia: { endpoint: 'coin_ledger', id: params.ledgerEntryId },
    }
  }

  return { canRevert: false, revertVia: null }
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

  const withdrawalIds = [
    ...new Set(
      page
        .filter(
          (e) => ADMIN_WITHDRAWAL_LEDGER_TX_TYPES.has(e.txType) && e.refId && UUID_RE.test(e.refId),
        )
        .map((e) => e.refId as string),
    ),
  ]
  const withdrawals =
    withdrawalIds.length > 0
      ? await prismaRead.withdrawal.findMany({
          where: { id: { in: withdrawalIds } },
          select: {
            id: true,
            status: true,
            processedAt: true,
            platformFeePoints: true,
            agentRewardPoints: true,
            serviceFeePoints: true,
          },
        })
      : []
  const withdrawalMap = new Map(withdrawals.map((w) => [w.id, w]))

  const counterpartyDetailsMap = await buildAdminCounterpartyDetailsMap(
    page.map((e) => ({
      id: e.id,
      direction: e.direction,
      txType: e.txType,
      amount: e.amount,
      refId: e.refId,
      counterpartyId: e.counterpartyId,
      metadata: e.metadata,
      createdAt: e.createdAt,
      walletUserId: e.wallet.user.id,
    })),
    'POINT',
  )

  return page.map((e) => {
    const cp = e.counterpartyId ? userMap.get(e.counterpartyId) : undefined
    const giftRef = e.refId ?? readMetaString(e.metadata, 'giftTransactionId')
    const giftTx = giftRef ? giftTxMap.get(giftRef) : undefined

    const withdrawal =
      ADMIN_WITHDRAWAL_LEDGER_TX_TYPES.has(e.txType) && e.refId
        ? withdrawalMap.get(e.refId)
        : undefined
    const withdrawalCanRevert = withdrawal
      ? isAdminWithdrawalRevertable({
          status: withdrawal.status,
          processedAt: withdrawal.processedAt,
        })
      : false

    return {
      id: e.id,
      direction: e.direction,
      txType: e.txType,
      transactionName: getTransactionName('POINT', e.txType, e.direction),
      amount: e.amount.toString(),
      balanceAfter: e.balanceAfter.toString(),
      refId: e.refId,
      counterpartyId: e.counterpartyId,
      description: e.description,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
      user: mapUserBrief(e.wallet.user),
      counterparty: cp ? mapUserBrief(cp) : null,
      counterpartyDetails: counterpartyDetailsMap.get(e.id) ?? null,
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
      platformProfit:
        e.direction === LedgerDirection.DEBIT &&
        (e.txType === PointTxType.WITHDRAWAL ||
          e.txType === PointTxType.WITHDRAWAL_ESCROW_SETTLED) &&
        withdrawal
          ? platformProfitService.profitForWithdrawalRow({
              platformFeePoints: withdrawal.platformFeePoints,
              agentRewardPoints: withdrawal.agentRewardPoints,
              serviceFeePoints: withdrawal.serviceFeePoints,
            })
          : ZERO_PLATFORM_PROFIT,
      canRevert: withdrawalCanRevert
        ? true
        : resolvePointLedgerRevertability({
            txType: e.txType,
            counterpartyId: e.counterpartyId,
          }),
      revertVia: withdrawalCanRevert
        ? ({ endpoint: 'withdrawal', id: withdrawal!.id } satisfies AdminCoinRevertVia)
        : null,
    }
  })
}
