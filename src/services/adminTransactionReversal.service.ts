import { CoinTxType, Prisma, PointTxType, WalletCurrencyType } from '@prisma/client'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'

/**
 * Shared state + rules for admin transaction reverts (`adminTransactions.service`,
 * `coinTrading.service.reverseTransfer`, per-user history lists).
 *
 * Once-only guarantee: every revert inserts one `admin_transaction_reversals` row keyed
 * `(sourceKind, sourceId)` inside the same transaction as its debit/credit. A transfer is keyed by
 * its transfer id, so the sender row and the receiver row of one transfer share a single key.
 * Reverts made before that table existed are still detected via their ledger idempotency keys
 * (`admin-revert:…`) and `coin_trading_transfers.reversed_at`.
 */

export type RevertSourceKind =
  | 'COIN_TRADING_TRANSFER'
  | 'AGENT_POINT_TRANSFER'
  | 'POINT_LEDGER'
  | 'COIN_LEDGER'
  | 'POINT_SINGLE'

export type RevertMode = 'full' | 'force'

export type ReversalSummary = {
  reversedAt: string
  forced: boolean
  /** Null for reverts made before `admin_transaction_reversals` existed (amount not recorded). */
  recoveredAmount: string | null
  shortfallAmount: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Idempotency-key prefixes written by admin reversal legs (never revertable themselves). */
const REVERSAL_KEY_PREFIXES = ['admin-revert:', 'trading-reversal:']

/** True when a ledger row is itself one leg of a reversal (reverting it would undo the revert). */
export function isReversalLedgerRow(entry: {
  idempotencyKey?: string | null
  txType?: string | null
}): boolean {
  if (entry.txType === CoinTxType.TRADING_TRANSFER_REVERSAL) return true
  const key = entry.idempotencyKey ?? ''
  return REVERSAL_KEY_PREFIXES.some((p) => key.startsWith(p))
}

/**
 * How much a revert moves. `full` needs the receiver to cover everything; `force` takes what the
 * receiver has (capped at the original) and leaves the rest as shortfall.
 */
export function computeRecovery(params: {
  original: bigint
  available: bigint
  mode: RevertMode
}): { recovered: bigint; shortfall: bigint; sufficient: boolean } {
  const available = params.available > 0n ? params.available : 0n
  const sufficient = available >= params.original
  if (params.mode === 'full' || sufficient) {
    return { recovered: params.original, shortfall: 0n, sufficient }
  }
  return { recovered: available, shortfall: params.original - available, sufficient }
}

export function assertForceAllowed(mode: RevertMode, adminRole: string | undefined): void {
  if (mode === 'force' && adminRole !== 'SUPER_ADMIN') {
    throw new AppError(403, 'Only a super admin can force-reverse', 'FORCE_REVERSE_FORBIDDEN')
  }
}

type BalanceReader = Pick<
  Prisma.TransactionClient,
  'wallet' | 'pointLedgerEntry' | 'coinLedgerEntry'
>

/**
 * Spendable balance a revert can claw back: ledger balance for coins, ledger balance minus
 * escrowed `unconfirmedPoints` for points (same rule as `pointWalletService.debit`). Call inside
 * the revert transaction after the wallets are locked for the authoritative figure.
 */
export async function readAvailableBalance(
  db: BalanceReader,
  userId: string,
  currencyType: WalletCurrencyType,
): Promise<bigint> {
  const wallet = await db.wallet.findUnique({
    where: { userId_currencyType: { userId, currencyType } },
    select: { id: true, unconfirmedPoints: true },
  })
  if (!wallet) return 0n
  if (currencyType === WalletCurrencyType.POINT) {
    const last = await db.pointLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    })
    const available = (last?.balanceAfter ?? 0n) - (wallet.unconfirmedPoints ?? 0n)
    return available > 0n ? available : 0n
  }
  const last = await db.coinLedgerEntry.findFirst({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  const balance = last?.balanceAfter ?? 0n
  return balance > 0n ? balance : 0n
}

export type ReversalRecordInput = {
  sourceKind: RevertSourceKind
  sourceId: string
  currency: WalletCurrencyType
  senderUserId: string
  receiverUserId: string
  originalAmount: bigint
  recoveredAmount: bigint
  shortfallAmount: bigint
  forced: boolean
  reason: string
  adminUserId: string
  debitLedgerEntryId?: string | null
  creditLedgerEntryId?: string | null
}

/**
 * Insert the once-only reversal row. Call inside the revert transaction: a concurrent revert of
 * the same source fails here with 409 and its debit/credit roll back with it.
 */
export async function insertReversalRecord(
  tx: Prisma.TransactionClient,
  data: ReversalRecordInput,
): Promise<void> {
  try {
    await tx.adminTransactionReversal.create({
      data: {
        ...data,
        currency: data.currency,
        debitLedgerEntryId: data.debitLedgerEntryId ?? null,
        creditLedgerEntryId: data.creditLedgerEntryId ?? null,
      },
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'Transaction already reverted', 'ALREADY_REVERTED')
    }
    throw err
  }
}

function toSummary(row: {
  createdAt: Date
  forced: boolean
  recoveredAmount: bigint
  shortfallAmount: bigint
}): ReversalSummary {
  return {
    reversedAt: row.createdAt.toISOString(),
    forced: row.forced,
    recoveredAmount: row.recoveredAmount.toString(),
    shortfallAmount: row.shortfallAmount.toString(),
  }
}

/** Reversal made before `admin_transaction_reversals` existed — amounts are not known. */
function legacySummary(reversedAt: Date, amount?: bigint): ReversalSummary {
  return {
    reversedAt: reversedAt.toISOString(),
    forced: false,
    recoveredAmount: amount != null ? amount.toString() : null,
    shortfallAmount: '0',
  }
}

export async function findReversalRecord(sourceKind: RevertSourceKind, sourceId: string) {
  return prismaRead.adminTransactionReversal.findUnique({
    where: { sourceKind_sourceId: { sourceKind, sourceId } },
  })
}

/** Throw 409 if any reversal (new table or legacy idempotency keys) already exists. */
export async function assertNotReverted(params: {
  sourceKind: RevertSourceKind
  sourceId: string
  /** Original ledger ids whose legacy `admin-revert:{currency}:{id}:*` rows also count. */
  legacyLedgerIds: string[]
  legacyCurrency: 'point' | 'coin' | 'point-single'
}): Promise<void> {
  const existing = await findReversalRecord(params.sourceKind, params.sourceId)
  if (existing) throw new AppError(409, 'Transaction already reverted', 'ALREADY_REVERTED')
  const keys = legacyReversalKeys(params.legacyCurrency, params.legacyLedgerIds)
  if (keys.length === 0) return
  const legacy =
    params.legacyCurrency === 'coin'
      ? await prismaRead.coinLedgerEntry.findFirst({
          where: { idempotencyKey: { in: keys } },
          select: { id: true },
        })
      : await prismaRead.pointLedgerEntry.findFirst({
          where: { idempotencyKey: { in: keys } },
          select: { id: true },
        })
  if (legacy) throw new AppError(409, 'Transaction already reverted', 'ALREADY_REVERTED')
}

function legacyReversalKeys(
  currency: 'point' | 'coin' | 'point-single',
  ledgerIds: string[],
): string[] {
  if (currency === 'point-single') {
    return ledgerIds.map((id) => `admin-revert:point-single:${id}:reverse`)
  }
  return ledgerIds.flatMap((id) => [
    `admin-revert:${currency}:${id}:debit`,
    `admin-revert:${currency}:${id}:credit`,
  ])
}

/** Reads the original ledger id back out of a legacy reversal idempotency key. */
function originalIdFromLegacyKey(key: string): string | null {
  const m = /^admin-revert:(?:point|coin|point-single):([0-9a-f-]{36}):/i.exec(key)
  return m ? m[1]! : null
}

export type LedgerRevertState = {
  /** Row is itself a reversal leg — never revertable. */
  isReversalRow: boolean
  /** Set when the row's source (transfer or the row itself) was already reverted. */
  reversal: ReversalSummary | null
}

/**
 * Batch revert state for a page of ledger rows (global explorer and per-user history). One query
 * per table; reads the rows' own idempotency keys, so callers don't need to select them.
 */
export async function loadLedgerRevertStates(params: {
  pointLedgerIds?: string[]
  coinLedgerIds?: string[]
}): Promise<Map<string, LedgerRevertState>> {
  const pointIds = [...new Set(params.pointLedgerIds ?? [])].filter((id) => UUID_RE.test(id))
  const coinIds = [...new Set(params.coinLedgerIds ?? [])].filter((id) => UUID_RE.test(id))
  const out = new Map<string, LedgerRevertState>()
  if (pointIds.length === 0 && coinIds.length === 0) return out

  const [pointRows, coinRows, coinTransfers] = await Promise.all([
    pointIds.length
      ? prismaRead.pointLedgerEntry.findMany({
          where: { id: { in: pointIds } },
          select: { id: true, idempotencyKey: true, txType: true, refId: true },
        })
      : [],
    coinIds.length
      ? prismaRead.coinLedgerEntry.findMany({
          where: { id: { in: coinIds } },
          select: { id: true, idempotencyKey: true, txType: true },
        })
      : [],
    coinIds.length
      ? prismaRead.coinTradingTransfer.findMany({
          where: {
            OR: [
              { senderLedgerEntryId: { in: coinIds } },
              { recipientLedgerEntryId: { in: coinIds } },
            ],
          },
          select: {
            id: true,
            senderLedgerEntryId: true,
            recipientLedgerEntryId: true,
            reversedAt: true,
            coinsCredited: true,
          },
        })
      : [],
  ])

  // Agent point transfers: both rows carry refId = transfer id.
  const pointTransferIds = [
    ...new Set(
      pointRows
        .filter(
          (r) => r.txType === PointTxType.AGENT_POINT_TRANSFER && r.refId && UUID_RE.test(r.refId),
        )
        .map((r) => r.refId as string),
    ),
  ]
  const pointTransfers = pointTransferIds.length
    ? await prismaRead.agentPointTransfer.findMany({
        where: { id: { in: pointTransferIds } },
        select: { id: true, senderLedgerEntryId: true, recipientLedgerEntryId: true },
      })
    : []
  const pointTransferById = new Map(pointTransfers.map((t) => [t.id, t]))
  const coinTransferByLedger = new Map<string, (typeof coinTransfers)[number]>()
  for (const t of coinTransfers) {
    coinTransferByLedger.set(t.senderLedgerEntryId, t)
    coinTransferByLedger.set(t.recipientLedgerEntryId, t)
  }

  // Every original ledger id whose legacy reversal would count, per currency.
  const legacyPointLedgerIds = new Set<string>(pointIds)
  for (const t of pointTransfers) {
    legacyPointLedgerIds.add(t.senderLedgerEntryId)
    legacyPointLedgerIds.add(t.recipientLedgerEntryId)
  }
  const pointKeys = [
    ...legacyReversalKeys('point', [...legacyPointLedgerIds]),
    ...legacyReversalKeys('point-single', pointIds),
  ]
  const coinKeys = legacyReversalKeys('coin', coinIds)

  const sourceIds = [
    ...pointIds,
    ...coinIds,
    ...pointTransferIds,
    ...coinTransfers.map((t) => t.id),
  ]
  const [records, legacyPoint, legacyCoin] = await Promise.all([
    prismaRead.adminTransactionReversal.findMany({
      where: { sourceId: { in: sourceIds } },
      select: {
        sourceKind: true,
        sourceId: true,
        createdAt: true,
        forced: true,
        recoveredAmount: true,
        shortfallAmount: true,
      },
    }),
    pointKeys.length
      ? prismaRead.pointLedgerEntry.findMany({
          where: { idempotencyKey: { in: pointKeys } },
          select: { idempotencyKey: true, createdAt: true },
        })
      : [],
    coinKeys.length
      ? prismaRead.coinLedgerEntry.findMany({
          where: { idempotencyKey: { in: coinKeys } },
          select: { idempotencyKey: true, createdAt: true },
        })
      : [],
  ])
  const recordByKey = new Map(records.map((r) => [`${r.sourceKind}:${r.sourceId}`, r]))
  const legacyPointAt = new Map<string, Date>()
  for (const r of legacyPoint) {
    const id = originalIdFromLegacyKey(r.idempotencyKey)
    if (id) legacyPointAt.set(id, r.createdAt)
  }
  const legacyCoinAt = new Map<string, Date>()
  for (const r of legacyCoin) {
    const id = originalIdFromLegacyKey(r.idempotencyKey)
    if (id) legacyCoinAt.set(id, r.createdAt)
  }

  for (const row of pointRows) {
    const transfer =
      row.txType === PointTxType.AGENT_POINT_TRANSFER && row.refId
        ? pointTransferById.get(row.refId)
        : undefined
    let reversal: ReversalSummary | null = null
    if (transfer) {
      const rec = recordByKey.get(`AGENT_POINT_TRANSFER:${transfer.id}`)
      const legacyAt =
        legacyPointAt.get(transfer.senderLedgerEntryId) ??
        legacyPointAt.get(transfer.recipientLedgerEntryId)
      reversal = rec ? toSummary(rec) : legacyAt ? legacySummary(legacyAt) : null
    } else {
      const rec =
        recordByKey.get(`POINT_LEDGER:${row.id}`) ?? recordByKey.get(`POINT_SINGLE:${row.id}`)
      const legacyAt = legacyPointAt.get(row.id)
      reversal = rec ? toSummary(rec) : legacyAt ? legacySummary(legacyAt) : null
    }
    out.set(row.id, { isReversalRow: isReversalLedgerRow(row), reversal })
  }

  for (const row of coinRows) {
    const transfer = coinTransferByLedger.get(row.id)
    let reversal: ReversalSummary | null = null
    if (transfer) {
      const rec = recordByKey.get(`COIN_TRADING_TRANSFER:${transfer.id}`)
      reversal = rec
        ? toSummary(rec)
        : transfer.reversedAt
          ? legacySummary(transfer.reversedAt, transfer.coinsCredited)
          : null
    } else {
      const rec = recordByKey.get(`COIN_LEDGER:${row.id}`)
      const legacyAt = legacyCoinAt.get(row.id)
      reversal = rec ? toSummary(rec) : legacyAt ? legacySummary(legacyAt) : null
    }
    out.set(row.id, { isReversalRow: isReversalLedgerRow(row), reversal })
  }

  return out
}

/** Batch reversal state for coin-trading transfer rows (Trading coins → transfers tab). */
export async function loadCoinTradingTransferReversals(
  transfers: { id: string; reversedAt: Date | null; coinsCredited: bigint }[],
): Promise<Map<string, ReversalSummary>> {
  const out = new Map<string, ReversalSummary>()
  if (transfers.length === 0) return out
  const records = await prismaRead.adminTransactionReversal.findMany({
    where: { sourceKind: 'COIN_TRADING_TRANSFER', sourceId: { in: transfers.map((t) => t.id) } },
  })
  const byId = new Map(records.map((r) => [r.sourceId, r]))
  for (const t of transfers) {
    const rec = byId.get(t.id)
    if (rec) out.set(t.id, toSummary(rec))
    else if (t.reversedAt) out.set(t.id, legacySummary(t.reversedAt, t.coinsCredited))
  }
  return out
}
