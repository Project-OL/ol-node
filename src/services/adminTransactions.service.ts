import {
  CoinTxType,
  LedgerDirection,
  LevelType,
  PointTxType,
  Prisma,
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
import { coinTradingService, walletTypeFromTransferRecord } from './coinTrading.service'
import {
  assertForceAllowed,
  assertNotReverted,
  computeRecovery,
  findReversalRecord,
  insertReversalRecord,
  isReversalLedgerRow,
  loadCoinTradingTransferReversals,
  loadLedgerRevertStates,
  readAvailableBalance,
  type ReversalSummary,
  type RevertMode,
  type RevertSourceKind,
} from './adminTransactionReversal.service'
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
  /** From `loadLedgerRevertStates`; reversal legs and already-reverted rows are not revertable. */
  revertState?: { isReversalRow: boolean; reversal: ReversalSummary | null } | null
}): boolean {
  if (!params.counterpartyId) return false
  if (params.revertState?.isReversalRow || params.revertState?.reversal) return false
  if (COIN_FUNDED_POINT_TX_TYPES.has(params.txType)) return false
  return POINT_WALLET_SOURCE_PEER_TYPES.has(params.txType)
}

/**
 * Single-wallet (no counterparty) point ledger rows an admin can revert:
 * generic balance corrections and the three reward-claim credit types.
 * None of these ever apply livestream XP or agency commission on credit
 * (verified: not in COMMISSION_ELIGIBLE_TX_TYPES / ranking tx-type sets, and
 * the reward services credit with `applyLivestreamLevel: false`), so a
 * revert never needs the XP/commission-reversal dance that peer reverts do.
 */
const SINGLE_WALLET_REVERTABLE_TX_TYPES = new Set<PointTxType>([
  PointTxType.ADJUSTMENT,
  PointTxType.NORMAL_HOST_REWARD,
  PointTxType.ROYAL_HOST_REWARD,
  PointTxType.LIVESTREAM_STREAK_REWARD,
])

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

/** Caller context shared by every revert endpoint. */
type RevertCallParams = {
  adminUserId: string
  /** `request.adminUser.role` — `mode: 'force'` requires SUPER_ADMIN. */
  adminRole?: string
  reason: string
  idempotencyKey?: string
  mode?: RevertMode
  /** Preview only: eligibility checks + receiver balance, no money moves. */
  dryRun?: boolean
}

const REVERSAL_ROW_MESSAGE = 'This row is itself a reversal and cannot be reverted'

/** `dryRun` response: what a full revert needs vs what a force revert would recover. */
function buildRevertPreview(params: {
  currencyType: WalletCurrencyType
  original: bigint
  available: bigint
  adminRole?: string
}) {
  const { recovered, shortfall, sufficient } = computeRecovery({
    original: params.original,
    available: params.available,
    mode: 'force',
  })
  return {
    ok: true as const,
    dryRun: true as const,
    currency: params.currencyType,
    originalAmount: params.original.toString(),
    receiverAvailable: params.available.toString(),
    recoverable: recovered.toString(),
    shortfall: shortfall.toString(),
    sufficient,
    forceAllowed: params.adminRole === 'SUPER_ADMIN',
  }
}

/**
 * Amount to move, read after the wallets are locked. `full` returns the original (the debit then
 * fails with INSUFFICIENT_* if the receiver is short); `force` caps at what the receiver has.
 */
async function recoveryUnderLock(
  tx: Prisma.TransactionClient,
  receiverUserId: string,
  currencyType: WalletCurrencyType,
  original: bigint,
  mode: RevertMode,
): Promise<{ recovered: bigint; shortfall: bigint }> {
  if (mode === 'full') return { recovered: original, shortfall: 0n }
  const available = await readAvailableBalance(tx, receiverUserId, currencyType)
  const { recovered, shortfall } = computeRecovery({ original, available, mode })
  if (recovered <= 0n) {
    throw new AppError(409, 'Receiver has nothing left to recover', 'NOTHING_TO_RECOVER')
  }
  return { recovered, shortfall }
}

function forceAuditDetails(
  mode: RevertMode,
  r: { recovered: bigint; shortfall: bigint; forced: boolean },
) {
  return {
    mode,
    forced: r.forced,
    recoveredAmount: r.recovered.toString(),
    shortfallAmount: r.shortfall.toString(),
  }
}

function forceResultFields(r: { recovered: bigint; shortfall: bigint; forced: boolean }) {
  return {
    forced: r.forced,
    recoveredAmount: r.recovered.toString(),
    shortfallAmount: r.shortfall.toString(),
  }
}

/**
 * Revert unit for a point peer row. An agent point transfer (both rows share `refId` = transfer
 * id) is one unit whatever row was clicked; parties and amount come from the transfer record.
 */
async function resolvePointPeerSource(entry: {
  id: string
  txType: PointTxType
  refId: string | null
  direction: LedgerDirection
  amount: bigint
  counterpartyId: string | null
  wallet: { userId: string }
}): Promise<{
  kind: RevertSourceKind
  id: string
  senderUserId: string
  receiverUserId: string
  amount: bigint
  legacyLedgerIds: string[]
}> {
  if (
    entry.txType === PointTxType.AGENT_POINT_TRANSFER &&
    entry.refId &&
    UUID_RE.test(entry.refId)
  ) {
    const transfer = await prismaRead.agentPointTransfer.findUnique({ where: { id: entry.refId } })
    if (transfer) {
      return {
        kind: 'AGENT_POINT_TRANSFER',
        id: transfer.id,
        senderUserId: transfer.senderAgentUserId,
        receiverUserId: transfer.recipientAgentUserId,
        amount: transfer.points,
        legacyLedgerIds: [transfer.senderLedgerEntryId, transfer.recipientLedgerEntryId],
      }
    }
  }
  const { senderUserId, receiverUserId } = resolvePeerParties({
    direction: entry.direction,
    walletUserId: entry.wallet.userId,
    counterpartyId: entry.counterpartyId,
  })
  return {
    kind: 'POINT_LEDGER',
    id: entry.id,
    senderUserId,
    receiverUserId,
    amount: entry.amount,
    legacyLedgerIds: [entry.id],
  }
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

  /** DIAMOND wallet ledger — same `coin_ledger_entries` table as COIN/TRADING_COIN, scoped
   * by currency. Includes both user wallets and the GAME_HOUSE counterparty's own wallet
   * (no `userId` filter excludes it — the house account is a normal `Wallet` row). */
  async listDiamondLedger(query: AdminTransactionsListQuery) {
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
      currencyType: WalletCurrencyType.DIAMOND,
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
    const reversals = await loadCoinTradingTransferReversals(page)
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
        canRevert: t.reversedAt == null && !reversals.has(t.id),
        reversal: reversals.get(t.id) ?? null,
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
    const agencyByGift = await platformProfitService.sumAgencyCommissionForGiftRows(
      page.map((g) => ({
        id: g.id,
        senderUserId: g.senderUserId,
        receiverUserId: g.receiverUserId,
        pointsAwarded: g.pointsAwarded,
        createdAt: g.createdAt,
      })),
    )
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
          agencyCommissionPoints: agencyByGift.get(g.id) ?? 0n,
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
   * Revert a **TRADING_COIN** ledger peer row that has no coin-trading transfer record:
   * 1) debit receiver  2) credit sender.
   *
   * Personal COIN rows, and any row linked to a coin-trading transfer, are `NOT_REVERTABLE` here —
   * use `POST …/coin-trading-transfers/:transferId/revert` (`details.transferId` says which).
   * Reversal legs are never revertable. `dryRun` previews; `mode: 'force'` (SUPER_ADMIN)
   * recovers what the receiver still has.
   */
  async revertCoinLedgerEntry(params: { ledgerEntryId: string } & RevertCallParams) {
    const mode = params.mode ?? 'full'
    const entry = await adminTransactionsRepository.findCoinLedgerById(params.ledgerEntryId)
    if (!entry) throw new AppError(404, 'Ledger entry not found', 'LEDGER_ENTRY_NOT_FOUND')

    const linkedTransfers = await coinTradingRepository.findTransfersByLedgerEntryIds([entry.id])
    const linked = linkedTransfers[0]
    if (linked) {
      // Always the transfer path — reverting one leg here would bypass the transfer's own state.
      throw new AppError(
        400,
        'This row belongs to a coin-trading transfer — use POST /admin/transactions/coin-trading-transfers/:transferId/revert',
        'NOT_REVERTABLE',
        { transferId: linked.id },
      )
    }
    if (entry.wallet.currencyType !== WalletCurrencyType.TRADING_COIN) {
      throw new AppError(
        400,
        'Only TRADING_COIN ledger peer rows are revertible via this endpoint',
        'NOT_REVERTABLE',
      )
    }
    if (isReversalLedgerRow(entry)) {
      throw new AppError(400, REVERSAL_ROW_MESSAGE, 'NOT_REVERTABLE')
    }

    const { senderUserId, receiverUserId } = resolvePeerParties({
      direction: entry.direction,
      walletUserId: entry.wallet.userId,
      counterpartyId: entry.counterpartyId,
    })
    await assertNotReverted({
      sourceKind: 'COIN_LEDGER',
      sourceId: entry.id,
      legacyLedgerIds: [entry.id],
      legacyCurrency: 'coin',
    })

    const currencyType = WalletCurrencyType.TRADING_COIN
    const original = entry.amount
    if (params.dryRun) {
      return buildRevertPreview({
        currencyType,
        original,
        available: await readAvailableBalance(prisma, receiverUserId, currencyType),
        adminRole: params.adminRole,
      })
    }
    assertForceAllowed(mode, params.adminRole)
    const baseKey = params.idempotencyKey?.trim() || `admin-revert:coin:${entry.id}:${randomUUID()}`
    const metadata = {
      adminUserId: params.adminUserId,
      source: 'admin_transaction_revert',
      originalLedgerEntryId: entry.id,
      reason: params.reason,
    }

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

          const { recovered, shortfall } = await recoveryUnderLock(
            tx,
            receiverUserId,
            currencyType,
            original,
            mode,
          )
          const forced = shortfall > 0n

          const debit = await coinWalletService.debit(
            receiverUserId,
            recovered,
            CoinTxType.TRADING_TRANSFER_REVERSAL,
            tx,
            {
              idempotencyKey: `admin-revert:coin:${entry.id}:debit`,
              description:
                `Admin revert debit${forced ? ' (partial)' : ''}: ${params.reason}`.slice(0, 500),
              counterpartyId: senderUserId,
              currencyType,
              applyWealthXp: false,
              freezeCheck: false,
              metadata,
            },
          )
          const credit = await coinWalletService.credit(
            senderUserId,
            recovered,
            CoinTxType.TRADING_TRANSFER_REVERSAL,
            tx,
            {
              idempotencyKey: `admin-revert:coin:${entry.id}:credit`,
              description:
                `Admin revert credit${forced ? ' (partial)' : ''}: ${params.reason}`.slice(0, 500),
              counterpartyId: receiverUserId,
              currencyType,
              applyWealthCredit: false,
              metadata,
            },
          )
          await insertReversalRecord(tx, {
            sourceKind: 'COIN_LEDGER',
            sourceId: entry.id,
            currency: currencyType,
            senderUserId,
            receiverUserId,
            originalAmount: original,
            recoveredAmount: recovered,
            shortfallAmount: shortfall,
            forced,
            reason: params.reason,
            adminUserId: params.adminUserId,
            debitLedgerEntryId: debit.ledgerEntryId,
            creditLedgerEntryId: credit.ledgerEntryId,
          })

          return { debit, credit, recovered, shortfall, forced }
        },
        { timeout: TX_TIMEOUT_MS },
      )

      await walletService.adjustTradingBalanceCache(receiverUserId)
      await walletService.adjustTradingBalanceCache(senderUserId)

      auditService.logAdmin({
        adminUserId: params.adminUserId,
        targetUserId: receiverUserId,
        actionType: result.forced
          ? 'ADMIN_TRANSACTION_FORCE_REVERT'
          : 'ADMIN_TRANSACTION_REVERT_COIN',
        actionStatus: 'success',
        actionDetails: {
          originalLedgerEntryId: entry.id,
          senderUserId,
          receiverUserId,
          amount: original.toString(),
          currencyType,
          reason: params.reason,
          debitLedgerEntryId: result.debit.ledgerEntryId,
          creditLedgerEntryId: result.credit.ledgerEntryId,
          wealthXpReversed: false,
          idempotencyKey: baseKey,
          ...forceAuditDetails(mode, result),
        },
        destination: `Revert coin ledger ${entry.id}`,
      })

      return {
        ok: true as const,
        originalLedgerEntryId: entry.id,
        senderUserId,
        receiverUserId,
        amount: original.toString(),
        currencyType,
        debitLedgerEntryId: result.debit.ledgerEntryId,
        creditLedgerEntryId: result.credit.ledgerEntryId,
        ...forceResultFields(result),
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

  /**
   * Revert a point-wallet peer transfer. An agent point transfer is keyed by its transfer id, so its
   * sender row and receiver row are one revertable unit. Withdrawal rows forward to the withdrawal
   * reverse (no dryRun amounts, no force). `dryRun` previews; `mode: 'force'` (SUPER_ADMIN)
   * recovers what the receiver still has.
   */
  async revertPointLedgerEntry(params: { ledgerEntryId: string } & RevertCallParams) {
    const mode = params.mode ?? 'full'
    const entry = await adminTransactionsRepository.findPointLedgerById(params.ledgerEntryId)
    if (!entry) throw new AppError(404, 'Ledger entry not found', 'LEDGER_ENTRY_NOT_FOUND')

    if (
      ADMIN_WITHDRAWAL_LEDGER_TX_TYPES.has(entry.txType) &&
      entry.refId &&
      UUID_RE.test(entry.refId)
    ) {
      if (params.dryRun) {
        return {
          ok: true as const,
          dryRun: true as const,
          via: 'withdrawal' as const,
          sufficient: true,
          forceAllowed: false,
        }
      }
      if (mode === 'force') {
        throw new AppError(
          400,
          'Force reverse is not available for withdrawals',
          'FORCE_NOT_SUPPORTED',
        )
      }
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

    if (isReversalLedgerRow(entry)) {
      throw new AppError(400, REVERSAL_ROW_MESSAGE, 'NOT_REVERTABLE')
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

    const source = await resolvePointPeerSource(entry)
    await assertNotReverted({
      sourceKind: source.kind,
      sourceId: source.id,
      legacyLedgerIds: source.legacyLedgerIds,
      legacyCurrency: 'point',
    })
    const { senderUserId, receiverUserId } = source
    const original = source.amount

    if (params.dryRun) {
      return buildRevertPreview({
        currencyType: WalletCurrencyType.POINT,
        original,
        available: await readAvailableBalance(prisma, receiverUserId, WalletCurrencyType.POINT),
        adminRole: params.adminRole,
      })
    }
    assertForceAllowed(mode, params.adminRole)
    const baseKey =
      params.idempotencyKey?.trim() || `admin-revert:point:${entry.id}:${randomUUID()}`
    const metadata = {
      adminUserId: params.adminUserId,
      source: 'admin_transaction_revert',
      originalLedgerEntryId: entry.id,
      ...(source.kind === 'AGENT_POINT_TRANSFER' ? { agentPointTransferId: source.id } : {}),
      reason: params.reason,
    }

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

          const { recovered, shortfall } = await recoveryUnderLock(
            tx,
            receiverUserId,
            WalletCurrencyType.POINT,
            original,
            mode,
          )
          const forced = shortfall > 0n

          const debit = await pointWalletService.debit(
            receiverUserId,
            recovered,
            PointTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `admin-revert:point:${entry.id}:debit`,
              description:
                `Admin revert debit${forced ? ' (partial)' : ''}: ${params.reason}`.slice(0, 500),
              counterpartyId: senderUserId,
              availabilityCheck: true,
              freezeCheck: false,
              metadata,
            },
          )
          const credit = await pointWalletService.creditInTransaction(
            senderUserId,
            recovered,
            PointTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `admin-revert:point:${entry.id}:credit`,
              description:
                `Admin revert credit${forced ? ' (partial)' : ''}: ${params.reason}`.slice(0, 500),
              counterpartyId: receiverUserId,
              applyLivestreamLevel: false,
              metadata,
            },
          )

          let livestreamResult = null
          let commission = {
            bustAgentUserId: null as string | null,
            reversed: false,
            commissionPoints: null as string | null,
          }

          // Side effects were applied on the original host CREDIT row. (Unreachable today:
          // coin-funded earning types are rejected above; kept for legacy peer types.)
          if (
            entry.direction === LedgerDirection.CREDIT &&
            LIVESTREAM_REVERT_POINT_TYPES.has(entry.txType)
          ) {
            livestreamResult = await walletLevelService.applyDebit(
              tx,
              receiverUserId,
              LevelType.LIVESTREAM,
              recovered,
            )
            commission = await agencyCommissionService.reverseCommission(
              { hostLedgerEntryId: entry.id, reason: params.reason },
              tx,
            )
          }

          await insertReversalRecord(tx, {
            sourceKind: source.kind,
            sourceId: source.id,
            currency: WalletCurrencyType.POINT,
            senderUserId,
            receiverUserId,
            originalAmount: original,
            recoveredAmount: recovered,
            shortfallAmount: shortfall,
            forced,
            reason: params.reason,
            adminUserId: params.adminUserId,
            debitLedgerEntryId: debit.ledgerEntryId,
            creditLedgerEntryId: credit.ledgerEntryId,
          })

          return { debit, credit, livestreamResult, commission, recovered, shortfall, forced }
        },
        { timeout: TX_TIMEOUT_MS },
      )

      await walletService.adjustPointBalanceCache(receiverUserId, -result.recovered)
      await walletService.adjustPointBalanceCache(senderUserId, result.recovered)
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
        actionType: result.forced
          ? 'ADMIN_TRANSACTION_FORCE_REVERT'
          : 'ADMIN_TRANSACTION_REVERT_POINT',
        actionStatus: 'success',
        actionDetails: {
          originalLedgerEntryId: entry.id,
          sourceKind: source.kind,
          sourceId: source.id,
          senderUserId,
          receiverUserId,
          amount: original.toString(),
          reason: params.reason,
          debitLedgerEntryId: result.debit.ledgerEntryId,
          creditLedgerEntryId: result.credit.ledgerEntryId,
          livestreamXpReversed: Boolean(result.livestreamResult),
          agencyCommissionReversed: result.commission.reversed,
          commissionPoints: result.commission.commissionPoints,
          idempotencyKey: baseKey,
          ...forceAuditDetails(mode, result),
        },
        destination: `Revert point ledger ${entry.id}`,
      })

      return {
        ok: true as const,
        originalLedgerEntryId: entry.id,
        senderUserId,
        receiverUserId,
        amount: original.toString(),
        debitLedgerEntryId: result.debit.ledgerEntryId,
        creditLedgerEntryId: result.credit.ledgerEntryId,
        ...forceResultFields(result),
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
   * Revert a single-wallet (no counterparty) point ledger entry: an admin
   * ADJUSTMENT correction, or a reward-claim credit (Normal/Royal Host,
   * Livestream Streak). A DEBIT is reverted with a clean credit back (no XP
   * — unlike the generic "Add Points" admin endpoint, which always grants
   * livestream XP); a CREDIT (e.g. a claimed reward) is reverted with a
   * debit gated on the user actually having the balance to give it back, or with
   * `mode: 'force'` (SUPER_ADMIN) only what the user still has.
   * Rows with a counterparty (peer legs) and reversal legs are rejected.
   */
  async revertSingleWalletPointEntry(params: { ledgerEntryId: string } & RevertCallParams) {
    const mode = params.mode ?? 'full'
    const entry = await adminTransactionsRepository.findPointLedgerById(params.ledgerEntryId)
    if (!entry) throw new AppError(404, 'Ledger entry not found', 'LEDGER_ENTRY_NOT_FOUND')

    if (!SINGLE_WALLET_REVERTABLE_TX_TYPES.has(entry.txType)) {
      throw new AppError(
        400,
        'Only admin ADJUSTMENT and reward-claim credits are revertable via this endpoint',
        'NOT_REVERTABLE',
      )
    }
    if (isReversalLedgerRow(entry)) {
      throw new AppError(400, REVERSAL_ROW_MESSAGE, 'NOT_REVERTABLE')
    }
    if (entry.counterpartyId) {
      throw new AppError(
        400,
        'This row has a counterparty — it is part of a peer transfer, not a single-wallet entry',
        'NOT_REVERTABLE',
      )
    }

    await assertNotReverted({
      sourceKind: 'POINT_SINGLE',
      sourceId: entry.id,
      legacyLedgerIds: [entry.id],
      legacyCurrency: 'point-single',
    })

    const userId = entry.wallet.userId
    const original = entry.amount
    const isCreditBack = entry.direction === LedgerDirection.DEBIT

    if (params.dryRun) {
      // Crediting back a debit always succeeds; only clawing back a credit can be short.
      return buildRevertPreview({
        currencyType: WalletCurrencyType.POINT,
        original,
        available: isCreditBack
          ? original
          : await readAvailableBalance(prisma, userId, WalletCurrencyType.POINT),
        adminRole: params.adminRole,
      })
    }
    assertForceAllowed(mode, params.adminRole)

    const idempotencyKey = `admin-revert:point-single:${entry.id}:reverse`
    const metadata = {
      adminUserId: params.adminUserId,
      source: 'admin_single_wallet_revert',
      originalLedgerEntryId: entry.id,
      reason: params.reason,
    }

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          if (isCreditBack) {
            const credit = await pointWalletService.creditInTransaction(
              userId,
              original,
              PointTxType.ADJUSTMENT,
              tx,
              {
                idempotencyKey,
                description: `Admin revert credit: ${params.reason}`.slice(0, 500),
                applyLivestreamLevel: false,
                metadata,
              },
            )
            await insertReversalRecord(tx, {
              sourceKind: 'POINT_SINGLE',
              sourceId: entry.id,
              currency: WalletCurrencyType.POINT,
              senderUserId: userId,
              receiverUserId: userId,
              originalAmount: original,
              recoveredAmount: original,
              shortfallAmount: 0n,
              forced: false,
              reason: params.reason,
              adminUserId: params.adminUserId,
              creditLedgerEntryId: credit.ledgerEntryId,
            })
            return {
              direction: LedgerDirection.CREDIT,
              ...credit,
              recovered: original,
              shortfall: 0n,
              forced: false,
            }
          }

          const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT, tx)
          await lockWalletsInOrder(tx, [wallet])
          const { recovered, shortfall } = await recoveryUnderLock(
            tx,
            userId,
            WalletCurrencyType.POINT,
            original,
            mode,
          )
          const forced = shortfall > 0n
          const debit = await pointWalletService.debit(
            userId,
            recovered,
            PointTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey,
              description:
                `Admin revert debit${forced ? ' (partial)' : ''}: ${params.reason}`.slice(0, 500),
              availabilityCheck: true,
              freezeCheck: false,
              metadata,
            },
          )
          await insertReversalRecord(tx, {
            sourceKind: 'POINT_SINGLE',
            sourceId: entry.id,
            currency: WalletCurrencyType.POINT,
            senderUserId: userId,
            receiverUserId: userId,
            originalAmount: original,
            recoveredAmount: recovered,
            shortfallAmount: shortfall,
            forced,
            reason: params.reason,
            adminUserId: params.adminUserId,
            debitLedgerEntryId: debit.ledgerEntryId,
          })
          return { direction: LedgerDirection.DEBIT, ...debit, recovered, shortfall, forced }
        },
        { timeout: TX_TIMEOUT_MS },
      )

      await walletService.adjustPointBalanceCache(
        userId,
        result.direction === LedgerDirection.CREDIT ? result.recovered : -result.recovered,
      )

      auditService.logAdmin({
        adminUserId: params.adminUserId,
        targetUserId: userId,
        actionType: result.forced
          ? 'ADMIN_TRANSACTION_FORCE_REVERT'
          : 'ADMIN_WALLET_REVERT_SINGLE_POINT',
        actionStatus: 'success',
        actionDetails: {
          originalLedgerEntryId: entry.id,
          originalTxType: entry.txType,
          userId,
          amount: original.toString(),
          reason: params.reason,
          reversalLedgerEntryId: result.ledgerEntryId,
          idempotencyKey,
          ...forceAuditDetails(mode, result),
        },
        destination: `Revert single-wallet point ledger ${entry.id}`,
      })

      return {
        ok: true as const,
        originalLedgerEntryId: entry.id,
        userId,
        originalDirection: entry.direction,
        amount: original.toString(),
        reversalLedgerEntryId: result.ledgerEntryId,
        ...forceResultFields(result),
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'INSUFFICIENT_POINTS') {
        throw new AppError(
          402,
          'Insufficient points on this user to revert this credit',
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

  /**
   * Coin-trading transfer revert — debit recipient first, then credit sender.
   * `dryRun` previews; `mode: 'force'` (SUPER_ADMIN) recovers what the recipient still has.
   */
  async revertCoinTradingTransfer(params: { transferId: string } & RevertCallParams) {
    const mode = params.mode ?? 'full'
    const transfer = await coinTradingRepository.getTransferById(params.transferId)
    if (!transfer) throw new AppError(404, 'Transfer not found', 'TRANSFER_NOT_FOUND')
    const existing = await findReversalRecord('COIN_TRADING_TRANSFER', transfer.id)
    if (transfer.reversedAt || existing) {
      throw new AppError(409, 'Transfer already reversed', 'TRANSFER_ALREADY_REVERSED')
    }

    if (params.dryRun) {
      return buildRevertPreview({
        currencyType: walletTypeFromTransferRecord(transfer.recipientWalletType),
        original: transfer.coinsCredited,
        available: await readAvailableBalance(
          prisma,
          transfer.recipientUserId,
          walletTypeFromTransferRecord(transfer.recipientWalletType),
        ),
        adminRole: params.adminRole,
      })
    }
    assertForceAllowed(mode, params.adminRole)

    const outcome = await coinTradingService.reverseTransfer(
      params.adminUserId,
      params.transferId,
      params.reason,
      { mode },
    )

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: transfer.recipientUserId,
      actionType: outcome.forced
        ? 'ADMIN_TRANSACTION_FORCE_REVERT'
        : 'ADMIN_TRANSACTION_REVERT_TRADING_TRANSFER',
      actionStatus: 'success',
      actionDetails: {
        transferId: transfer.id,
        reason: params.reason,
        senderAgentUserId: transfer.senderAgentUserId,
        recipientUserId: transfer.recipientUserId,
        amount: transfer.coinsCredited.toString(),
        ...forceAuditDetails(mode, outcome),
      },
      destination: `Revert trading transfer ${transfer.id}`,
    })

    return {
      ok: true as const,
      transferId: transfer.id,
      senderUserId: transfer.senderAgentUserId,
      receiverUserId: transfer.recipientUserId,
      tradingCoinsCreditedToSender: outcome.recovered.toString(),
      coinsDebitedFromReceiver: outcome.recovered.toString(),
      recipientWalletType: transfer.recipientWalletType,
      ...forceResultFields(outcome),
    }
  },
}

type CoinLedgerRow = Awaited<ReturnType<typeof adminTransactionsRepository.listCoinLedger>>[number]
type PointLedgerRow = Awaited<
  ReturnType<typeof adminTransactionsRepository.listPointLedger>
>[number]

function walletContextForCoinRow(
  currencyType: WalletCurrencyType,
): 'COIN' | 'TRADING_COIN' | 'DIAMOND' {
  if (currencyType === WalletCurrencyType.TRADING_COIN) return 'TRADING_COIN'
  if (currencyType === WalletCurrencyType.DIAMOND) return 'DIAMOND'
  return 'COIN'
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
  const revertStates = await loadLedgerRevertStates({
    coinLedgerIds: page
      .filter(
        (e) =>
          e.wallet.currencyType === WalletCurrencyType.TRADING_COIN || transferByLedger.has(e.id),
      )
      .map((e) => e.id),
  })

  const giftRowsForAgency = [
    ...new Map(
      [...giftTxMap.values(), ...giftTxByLedgerId.values()].map((g) => [g.id, g]),
    ).values(),
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
  const [giftAgencyById, agencyBySplitRef] = await Promise.all([
    platformProfitService.sumAgencyCommissionForGiftRows(
      giftRowsForAgency.map((g) => ({
        id: g.id,
        senderUserId: g.senderUserId,
        receiverUserId: g.receiverUserId,
        pointsAwarded: g.pointsAwarded,
        createdAt: g.createdAt,
      })),
    ),
    platformProfitService.sumAgencyCommissionByRefIds(splitRefIds),
  ])
  const agencyByRefId = new Map(agencyBySplitRef)
  for (const [giftId, amount] of giftAgencyById) {
    agencyByRefId.set(giftId, (agencyByRefId.get(giftId) ?? 0n) + amount)
  }
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
        revertState: revertStates.get(e.id) ?? null,
      }),
      reversal: revertStates.get(e.id)?.reversal ?? null,
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
  /** From `loadLedgerRevertStates`; absent means "not known reverted". */
  revertState?: { isReversalRow: boolean; reversal: ReversalSummary | null } | null
}): { canRevert: boolean; revertVia: AdminCoinRevertVia | null } {
  const alreadyReverted = Boolean(params.revertState?.reversal)

  // Agent→user (or peer) transfer funded by TRADING_COIN — the only revert path for its rows.
  // Once the transfer is reversed its rows are never revertable (no fall-through to coin_ledger).
  if (params.tradingTransfer) {
    if (params.tradingTransfer.reversedAt == null && !alreadyReverted) {
      return {
        canRevert: true,
        revertVia: {
          endpoint: 'coin_trading_transfer',
          id: params.tradingTransfer.id,
        },
      }
    }
    return { canRevert: false, revertVia: null }
  }

  // Reversal legs and already-reverted rows.
  if (params.revertState?.isReversalRow || alreadyReverted) {
    return { canRevert: false, revertVia: null }
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

  const revertStates = await loadLedgerRevertStates({
    pointLedgerIds: page
      .filter(
        (e) =>
          resolvePointLedgerRevertability({ txType: e.txType, counterpartyId: e.counterpartyId }) ||
          SINGLE_WALLET_REVERTABLE_TX_TYPES.has(e.txType),
      )
      .map((e) => e.id),
  })

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
            revertState: revertStates.get(e.id) ?? null,
          }),
      revertVia: withdrawalCanRevert
        ? ({ endpoint: 'withdrawal', id: withdrawal!.id } satisfies AdminCoinRevertVia)
        : null,
      reversal: revertStates.get(e.id)?.reversal ?? null,
    }
  })
}
