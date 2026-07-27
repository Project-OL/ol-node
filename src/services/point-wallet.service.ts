import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { getRedisForRead, redisClient, RedisKeys, WALLET_BALANCE_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { walletRepository } from '../repositories/wallet.repository'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { mapDbUnavailable, walletService } from './wallet.service'
import { auditService } from './audit.service'
import { WalletCurrencyType, PointTxType, LedgerDirection, LevelType } from '@prisma/client'
import { assertPointsDebitAllowed } from './wallet-freeze.service'
import { walletLevelService } from './user-level.service'
import {
  utcDayFromTimestamp,
  resolvePointSummaryPeriod,
  type PointSummaryPeriod,
} from '../utils/datetime'
import { formatPointsAsUsd } from '../utils/points-currency'
import {
  buildPointAmountBreakdown,
  loadWithdrawalAmountContext,
  resolvePointLedgerRefId,
} from '../utils/point-transaction-amounts'
import {
  buildPointTransactionPaymentDetails,
  buildPointTransactionReportHint,
  POINT_WITHDRAWAL_TX_TYPES,
  resolvePointTransactionKind,
  resolvePointTransactionStatus,
} from '../utils/point-transaction-detail'
import { formatPointTransactionOrderNumber } from '../utils/point-transaction-order'
import { inferRefIdEntityType } from '../config/point-ledger-ref-id'
import type { PointLedgerEntry } from '@prisma/client'
import {
  earningsCategoryForTxType,
  resolvePointHistoryTxTypes,
  sumCreditsByCategory,
} from '../config/point-earnings-categories'
import { withdrawalService } from './withdrawal.service'
import { supportService } from './support.service'
import { getTransactionName } from '../config/transaction-display-names'
import {
  buildCounterpartyDetailsMap,
  COUNTERPARTY_USER_SELECT,
} from '../utils/ledger-transaction-enrichment'
import { enqueuePlatformLedgerMessage } from '../queues/platform-message.queue'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

const LEDGER_USER_SELECT = {
  ...COUNTERPARTY_USER_SELECT,
} as const

type LedgerUserRow = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
  publicId: bigint
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
    publicId: user.publicId.toString(),
    avatarUrl: user.avatarUrl,
  }
}

type PointLedgerDetailRow = PointLedgerEntry

async function loadWithdrawalPaymentContext(refId: string | null) {
  if (!refId) return null
  const row = await prismaRead.withdrawal.findUnique({
    where: { id: refId },
    select: {
      status: true,
      paymentMethod: true,
    },
  })
  return row
}

async function buildPointTransactionDetail(
  entry: PointLedgerDetailRow,
  selfRow: LedgerUserRow,
  counterpartyRow: LedgerUserRow | null,
) {
  const transactionDateTime = entry.createdAt.toISOString()
  const refId = resolvePointLedgerRefId(entry.refId, entry.metadata)
  const orderNumber = formatPointTransactionOrderNumber(entry.id, entry.createdAt)
  const transactionKind = resolvePointTransactionKind(entry.txType)

  const payrollConfig = await prismaRead.payrollConfig.findUnique({
    where: { id: 1 },
    select: { inrPerUsd: true },
  })
  const inrPerUsd = payrollConfig
    ? new Prisma.Decimal(payrollConfig.inrPerUsd.toString()).toNumber()
    : 86

  const withdrawalAmount = refId ? await loadWithdrawalAmountContext(refId, entry.txType) : null
  const withdrawalRow =
    refId && POINT_WITHDRAWAL_TX_TYPES.has(entry.txType)
      ? await loadWithdrawalPaymentContext(refId)
      : null

  const amountDetails = buildPointAmountBreakdown(
    {
      txType: entry.txType,
      amount: entry.amount,
      refId,
      metadata: entry.metadata,
      withdrawal: withdrawalAmount,
    },
    inrPerUsd,
  )

  const counterpartyDetailsMap = await buildCounterpartyDetailsMap(
    [
      {
        id: entry.id,
        direction: entry.direction,
        txType: entry.txType,
        amount: entry.amount,
        refId: entry.refId,
        counterpartyId: entry.counterpartyId,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      },
    ],
    'POINT',
    selfRow.id,
  )

  const counterpartyForPayment = counterpartyRow
    ? {
        publicId: counterpartyRow.publicId.toString(),
        displayName: ledgerUserDisplayName(counterpartyRow),
      }
    : null

  const { status, statusLabel } = resolvePointTransactionStatus(
    entry.txType,
    withdrawalRow?.status ?? null,
  )

  const paymentDetails = buildPointTransactionPaymentDetails({
    txType: entry.txType,
    counterparty: counterpartyForPayment,
    paymentMethod: withdrawalRow?.paymentMethod ?? null,
  })

  const report = buildPointTransactionReportHint({
    entry,
    businessRefId: refId,
  })

  return {
    id: entry.id,
    direction: entry.direction,
    txType: entry.txType,
    transactionName: getTransactionName('POINT', entry.txType, entry.direction),
    transactionKind,
    platformId: selfRow.publicId.toString(),
    orderNumber,
    orderTime: transactionDateTime,
    status,
    statusLabel,
    amount: entry.amount.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    refId,
    refIdEntityType: inferRefIdEntityType(entry.txType),
    amountDetails,
    paymentDetails,
    report,
    transactionDateTime,
    description: entry.description,
    metadata: entry.metadata,
    idempotencyKey: entry.idempotencyKey,
    createdAt: transactionDateTime,
    earningsCategory:
      entry.direction === LedgerDirection.CREDIT ? earningsCategoryForTxType(entry.txType) : null,
    self: mapLedgerParticipant(selfRow),
    counterparty: counterpartyRow ? mapLedgerParticipant(counterpartyRow) : null,
    counterpartyDetails: counterpartyDetailsMap.get(entry.id) ?? null,
  }
}

export const pointWalletService = {
  async getSummary(userId: string, opts?: { period?: PointSummaryPeriod }) {
    // Balance + unconfirmed come from one cached breakdown (same operands, same
    // availablePoints = totalPoints - unconfirmedPoints computation).
    const {
      total: balance,
      available,
      unconfirmed,
    } = await pointWalletService.getBalanceBreakdown(userId)

    const earningsWhere: Prisma.PointLedgerEntryWhereInput = {
      wallet: { userId, currencyType: WalletCurrencyType.POINT },
      direction: LedgerDirection.CREDIT,
    }

    let earningsPeriod: { period: string; from: string; to: string } | undefined
    if (opts?.period) {
      const range = resolvePointSummaryPeriod(opts.period)
      earningsWhere.createdAt = { gte: range.start, lte: range.end }
      earningsPeriod = {
        period: range.label,
        from: range.start.toISOString(),
        to: range.end.toISOString(),
      }
    }

    const earnings = await prismaRead.pointLedgerEntry.groupBy({
      by: ['txType'],
      where: earningsWhere,
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
      ...(earningsPeriod ? { earningsPeriod } : {}),
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

    void enqueuePlatformLedgerMessage('point', entry.id).catch(() => {})

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

    const baseEntries = page.map((e) => {
      const refId = resolvePointLedgerRefId(e.refId, e.metadata)
      return {
        id: e.id,
        direction: e.direction,
        txType: e.txType,
        amount: e.amount,
        balanceAfter: e.balanceAfter.toString(),
        refId,
        usdAmount: formatPointsAsUsd(e.amount),
        counterpartyId: e.counterpartyId,
        description: e.description,
        metadata: e.metadata,
        createdAt: e.createdAt,
      }
    })

    const counterpartyMap = await buildCounterpartyDetailsMap(baseEntries, 'POINT', userId)

    return {
      entries: baseEntries.map((e) => ({
        id: e.id,
        direction: e.direction,
        txType: e.txType,
        transactionName: getTransactionName('POINT', e.txType, e.direction),
        amount: e.amount.toString(),
        balanceAfter: e.balanceAfter,
        refId: e.refId,
        usdAmount: e.usdAmount,
        counterpartyId: e.counterpartyId,
        counterpartyDetails: counterpartyMap.get(e.id) ?? null,
        description: e.description,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
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

  async getTransactionDetailByOrderNumber(userId: string, orderNumber: string) {
    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)
    const entry = await pointLedgerRepository.findByOrderNumberForWallet(wallet.id, orderNumber)
    if (!entry) {
      throw new AppError(404, 'Point transaction not found', 'NOT_FOUND')
    }
    return pointWalletService.getTransactionDetail(userId, entry.id)
  },

  async reportTransaction(
    userId: string,
    input: { orderNumber: string; description: string; imageUrl?: string },
  ) {
    const detail = await pointWalletService.getTransactionDetailByOrderNumber(
      userId,
      input.orderNumber,
    )

    if (!detail.report?.allowed) {
      throw new AppError(400, 'This transaction cannot be reported', 'TRANSACTION_NOT_REPORTABLE')
    }

    const ticket = await supportService.createTicket(userId, {
      type: detail.report.supportType,
      subType: detail.report.supportSubType,
      description: input.description,
      imageUrl: input.imageUrl,
      transactionRef: detail.report.transactionRef,
    })

    return {
      ticket,
      orderNumber: detail.orderNumber,
      transactionKind: detail.transactionKind,
      entryId: detail.id,
    }
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
   * Livestream cumulative XP (host earnings) is applied ONLY when `applyLivestreamLevel`
   * is explicitly `true`. It must be opt-in so internal/system credits (agent commission,
   * agent point transfer, payroll payouts/rewards, withdrawal refunds) never inflate the
   * livestream level. Authoritative livestream triggers: gift receive, video call host
   * credit, subscription, guardian, admin point adjustment.
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
    livestreamLevelResult: Awaited<ReturnType<typeof walletLevelService.applyCredit>> | null
  }> {
    const existing = await pointLedgerRepository.findByIdempotencyKey(tx, options.idempotencyKey)
    if (existing) {
      return {
        ledgerEntryId: existing.id,
        balanceAfter: existing.balanceAfter,
        bustAgentUserId: null,
        livestreamLevelResult: null,
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

    void enqueuePlatformLedgerMessage('point', entry.id).catch(() => {})

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

    const applyXp = options.applyLivestreamLevel === true
    let livestreamLevelResult: Awaited<ReturnType<typeof walletLevelService.applyCredit>> | null =
      null
    if (
      applyXp &&
      txType !== PointTxType.AGENT_COMMISSION &&
      txType !== PointTxType.AGENT_POINT_TRANSFER
    ) {
      livestreamLevelResult = await walletLevelService.applyCredit(
        tx,
        userId,
        LevelType.LIVESTREAM,
        amount,
      )
    }

    void enqueuePlatformLedgerMessage('point', entry.id).catch(() => {})

    return {
      ledgerEntryId: entry.id,
      balanceAfter: entry.balanceAfter,
      bustAgentUserId,
      livestreamLevelResult,
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

    await assertPointsDebitAllowed(userId)

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
    void enqueuePlatformLedgerMessage('point', entry.id).catch(() => {})
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
    const balKey = RedisKeys.walletPointBalance(userId)
    const unconfKey = RedisKeys.walletPointsUnconfirmed(userId)

    let totalRaw: string | null = null
    let unconfRaw: string | null = null
    try {
      // One MGET replaces two GETs; both operands cached under their existing keys.
      const [t, u] = await getRedisForRead().mget(balKey, unconfKey)
      totalRaw = t ?? null
      unconfRaw = u ?? null
    } catch {
      // Redis unavailable — recompute from Postgres below
    }
    if (totalRaw !== null && unconfRaw !== null) {
      const total = BigInt(totalRaw)
      const unconfirmed = BigInt(unconfRaw)
      return { total, available: total - unconfirmed, unconfirmed }
    }

    // Miss on either key: one wallet row serves both the unconfirmed value and
    // the wallet id for the ledger recompute (previously two getOrCreate calls).
    let wallet
    try {
      wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT)
    } catch (e) {
      mapDbUnavailable(e)
    }
    const unconfirmed = unconfRaw !== null ? BigInt(unconfRaw) : (wallet.unconfirmedPoints ?? 0n)
    let total: bigint
    if (totalRaw !== null) {
      total = BigInt(totalRaw)
    } else {
      try {
        total = await pointLedgerRepository.computeBalance(wallet.id)
      } catch (e) {
        mapDbUnavailable(e)
      }
    }

    try {
      const pipe = redisClient.pipeline()
      if (totalRaw === null) pipe.set(balKey, total.toString(), 'EX', WALLET_BALANCE_TTL)
      if (unconfRaw === null) pipe.set(unconfKey, unconfirmed.toString(), 'EX', WALLET_BALANCE_TTL)
      await pipe.exec()
    } catch {
      // best-effort cache write
    }
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
