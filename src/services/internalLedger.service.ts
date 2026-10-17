/**
 * BE-20 (option B): the single money service for Live-server.
 *
 * Live-server used to write coin/point ledger rows, levels and agency commission itself, a copy of
 * this repo's money rules that drifted (LIVE-24 unlocked agency credit, LIVE-25 minute-1 commission
 * outside the accept transaction, LIVE-56 wallet create race, commission keys admin reversal can't
 * find, paused agencies still paid). Live-server now calls these operations over the internal,
 * HMAC-signed API (`routes/internal/ledger.routes.ts`) when `LIVE_LEDGER_MODE=remote`.
 *
 * Each operation keeps Live-server's ledger shapes exactly (tx types, idempotency keys, refIds,
 * descriptions, metadata, gift_transactions rows), so switching an operation between local and
 * remote mode never double-bills: both write the same unique keys. What changes is how it is
 * written: every wallet the transaction touches (agency included) is created atomically and locked
 * in one id-sorted pass, and commission + levels settle in the same transaction.
 *
 * Amounts are always read here (gift cost, call price, revenue shares), never taken from the
 * caller, except the lucky reward: the RTP draw lives in Live-server (reserve pool), so the reward
 * is passed in and bounded by the engine's maximum multiplier.
 *
 * Replays: every request carries a `requestId` (constant across the client's retries), stored in
 * the primary ledger row's metadata. When the primary row already exists, the same requestId gets
 * its committed result back (`replayed: true`); a different requestId is a real duplicate and gets
 * 409 DUPLICATE_LEDGER_KEY, which Live-server maps to its existing 409 IDEM_CONFLICT.
 */
import { randomUUID } from 'crypto'
import {
  CoinTxType,
  LedgerDirection,
  LevelType,
  PointTxType,
  Prisma,
  WalletCurrencyType,
} from '@prisma/client'
import { prisma } from '../config/database'
import { callerCoinDebitForCall, hostPointsFromGift } from '../config/host-revenue-shares'
import { AppError } from '../middlewares/errorHandler'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { walletRepository } from '../repositories/wallet.repository'
import { utcDayFromTimestamp } from '../utils/datetime'
import { isLuckyGift } from '../utils/lucky-gift'
import { isSerializationAbort, isUniqueViolation } from '../utils/txRetry'
import { lockWalletsInOrder } from '../utils/wallet-lock-order'
import { agencyCommissionService } from './agencyCommission.service'
import { hostRevenueShareConfigService } from './hostRevenueShareConfig.service'
import { rankingService } from './ranking.service'
import { walletLevelService } from './user-level.service'
import { walletService } from './wallet.service'
import { assertCoinDebitAllowedInTx } from './wallet-freeze.service'

const TX_TIMEOUT_MS = 15_000
const TX_MAX_ATTEMPTS = 3

/** Live-server's fixed global-message price (serviceLive.js sendGlobalMessageService). */
export const GLOBAL_MESSAGE_COST = 10_000n
/** Largest lucky payout the RTP engine can draw: single JACKPOT 10x, combo WINNER 1.5x + 0.05 boost. */
export const LUCKY_MAX_REWARD_MULTIPLE = { single: 10n, combo: 2n } as const

type LevelResult = { newLevel: number; previousLevel: number; newCumulative: bigint }

type Tx = Prisma.TransactionClient

// ---------------------------------------------------------------------------------------------
// In-transaction helpers
// ---------------------------------------------------------------------------------------------

/**
 * Wallet row for (user, currency), created if missing. `INSERT ... ON CONFLICT DO NOTHING` waits for
 * a concurrent creator instead of failing with P2002 (which aborts the whole transaction: LIVE-56).
 */
async function ensureWallet(tx: Tx, userId: string, currencyType: WalletCurrencyType) {
  await tx.$executeRaw`
    INSERT INTO wallets (id, user_id, currency_type, version, unconfirmed_points, created_at, updated_at)
    VALUES (gen_random_uuid(), ${userId}::uuid, ${currencyType}::"WalletCurrencyType", 0, 0, NOW(), NOW())
    ON CONFLICT (user_id, currency_type) DO NOTHING
  `
  const wallet = await tx.wallet.findUnique({
    where: { userId_currencyType: { userId, currencyType } },
  })
  if (!wallet) throw new AppError(500, 'Wallet missing after ensure', 'WALLET_ENSURE_FAILED')
  return wallet
}

async function latestCoinBalance(tx: Tx, walletId: string): Promise<bigint> {
  const last = await tx.coinLedgerEntry.findFirst({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  return last?.balanceAfter ?? 0n
}

async function latestPointBalance(tx: Tx, walletId: string): Promise<bigint> {
  const last = await tx.pointLedgerEntry.findFirst({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  return last?.balanceAfter ?? 0n
}

/**
 * The agency that will be paid commission for this host (same resolution as
 * agencyCommissionService.applyCommission), so its POINT wallet can join the sorted lock.
 */
async function resolveCommissionAgency(tx: Tx, hostUserId: string): Promise<string | null> {
  const host = await tx.user.findUnique({
    where: { id: hostUserId },
    select: { currentAgencyId: true },
  })
  if (host?.currentAgencyId) return host.currentAgencyId
  const owned = await tx.agency.findUnique({
    where: { userId: hostUserId },
    select: { userId: true },
  })
  return owned?.userId ?? null
}

/**
 * Lock every wallet the operation writes, agency included, in one id-sorted pass (LIVE-24: the
 * agency credit used to read its balance unlocked, so two hosts of one agency lost a credit).
 * Then re-check the freeze flag under the lock.
 */
async function lockForOperation(
  tx: Tx,
  params: { payerUserId: string; hostUserId?: string | null; withCommission: boolean },
) {
  const payerCoin = await ensureWallet(tx, params.payerUserId, WalletCurrencyType.COIN)
  const hostPoint = params.hostUserId
    ? await ensureWallet(tx, params.hostUserId, WalletCurrencyType.POINT)
    : null
  const agencyUserId =
    params.withCommission && params.hostUserId
      ? await resolveCommissionAgency(tx, params.hostUserId)
      : null
  const agencyPoint = agencyUserId
    ? await ensureWallet(tx, agencyUserId, WalletCurrencyType.POINT)
    : null
  await lockWalletsInOrder(
    tx,
    [payerCoin, hostPoint, agencyPoint].filter((w): w is NonNullable<typeof w> => w !== null),
  )
  await assertCoinDebitAllowedInTx(tx, params.payerUserId, WalletCurrencyType.COIN)
  return { payerCoin, hostPoint }
}

/**
 * walletLevelService.applyCredit + Live-server's legacy `user_levels` mirror, which Live-server
 * still reads (kick permission compares livestream levels).
 */
async function applyLevel(
  tx: Tx,
  userId: string,
  levelType: LevelType,
  increment: bigint,
): Promise<LevelResult> {
  const r = await walletLevelService.applyCredit(tx, userId, levelType, increment)
  if (levelType === LevelType.LIVESTREAM) {
    await tx.$executeRaw`
      INSERT INTO user_levels (id, user_id, livestream_level, livestream_xp, updated_at)
      VALUES (${randomUUID()}, ${userId}::uuid, ${r.newLevel}, ${r.newCumulative}, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET livestream_level = EXCLUDED.livestream_level,
          livestream_xp = EXCLUDED.livestream_xp,
          updated_at = NOW()
    `
  } else if (levelType === LevelType.WEALTH) {
    await tx.$executeRaw`
      INSERT INTO user_levels (id, user_id, wealth_level, wealth_xp, updated_at)
      VALUES (${randomUUID()}, ${userId}::uuid, ${r.newLevel}, ${r.newCumulative}, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET wealth_level = EXCLUDED.wealth_level,
          wealth_xp = EXCLUDED.wealth_xp,
          updated_at = NOW()
    `
  }
  return r
}

/** Host point credit side effects shared by every host-earning operation (in the same tx). */
async function settleHostCredit(
  tx: Tx,
  params: {
    hostUserId: string
    hostLedgerEntryId: string
    points: bigint
    txType: PointTxType
    withCommission: boolean
  },
): Promise<string | null> {
  const day = utcDayFromTimestamp(new Date())
  let agencyUserId: string | null = null
  if (params.withCommission) {
    const ac = await agencyCommissionService.applyCommission(
      {
        hostUserId: params.hostUserId,
        hostLedgerEntryId: params.hostLedgerEntryId,
        hostPointsCredited: params.points,
        hostTxType: params.txType,
        day,
      },
      tx,
    )
    agencyUserId = ac.bustAgentUserId
  }
  await rankingService.onHostPointCredit(
    { hostUserId: params.hostUserId, amount: params.points, txType: params.txType, day },
    tx,
  )
  return agencyUserId
}

export const LUCKY_RESERVE_POOL_SLOTS = 8

/**
 * LIVE-31: add one lucky gift to the reserve-pool counters (`lucky_reserve_pool`, summed over its
 * slots by Live-server's draw engine). Pool inflow = cost x RTP target; outflow = the reward.
 */
async function addToLuckyReservePool(
  tx: Tx,
  p: { cost: bigint; reward: bigint; targetRtpBp: number },
) {
  const slot = Math.floor(Math.random() * LUCKY_RESERVE_POOL_SLOTS)
  // Upsert: the migration seeds the 8 rows, but a DB built with `prisma db push` (tests) has none.
  await tx.$executeRaw`
    INSERT INTO lucky_reserve_pool (slot, total_spent, total_rewarded, pool_balance, updated_at)
    VALUES (${slot}, ${p.cost}, ${p.reward},
            (${p.cost}::numeric * ${p.targetRtpBp} / 10000) - ${p.reward}, NOW())
    ON CONFLICT (slot) DO UPDATE
    SET total_spent = lucky_reserve_pool.total_spent + EXCLUDED.total_spent,
        total_rewarded = lucky_reserve_pool.total_rewarded + EXCLUDED.total_rewarded,
        pool_balance = lucky_reserve_pool.pool_balance + EXCLUDED.pool_balance,
        updated_at = NOW()
  `
}

async function runMoneyTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS, maxWait: 10_000 })
    } catch (err) {
      if (attempt < TX_MAX_ATTEMPTS && isSerializationAbort(err)) {
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)))
        continue
      }
      throw err
    }
  }
}

/** Post-commit, best effort: shared balance caches, level caches, agency tier + caches. */
async function afterCommit(params: {
  coinUserId?: string
  coinBalance?: bigint
  pointUserId?: string | null
  pointBalance?: bigint | null
  wealthUserId?: string
  livestreamUserId?: string | null
  agencyUserId?: string | null
}) {
  try {
    if (params.coinUserId && params.coinBalance != null) {
      await walletService.writeCoinBalanceCache(params.coinUserId, params.coinBalance)
    }
    if (params.pointUserId && params.pointBalance != null) {
      await walletService.writePointBalanceCache(params.pointUserId, params.pointBalance)
    }
    if (params.wealthUserId) {
      await walletLevelService.invalidateCache(params.wealthUserId, LevelType.WEALTH)
    }
    if (params.livestreamUserId) {
      await walletLevelService.invalidateCache(params.livestreamUserId, LevelType.LIVESTREAM)
    }
    if (params.agencyUserId) {
      await walletService.adjustPointBalanceCache(params.agencyUserId, 0n)
      await agencyCommissionService.afterCommissionCreditCommit(params.agencyUserId)
    }
  } catch {
    // Caches only; the ledger already committed.
  }
}

/** Current level of a user without writing anything (replay responses). */
async function currentLevel(userId: string, levelType: LevelType): Promise<LevelResult> {
  const row = await prisma.walletUserLevel.findUnique({
    where: { userId_levelType: { userId, levelType } },
    select: { currentLevel: true, cumulativeTotal: true },
  })
  const level = row?.currentLevel ?? 1
  return { newLevel: level, previousLevel: level, newCumulative: row?.cumulativeTotal ?? 0n }
}

function metaRequestId(metadata: Prisma.JsonValue | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const v = (metadata as Record<string, unknown>).requestId
  return typeof v === 'string' ? v : null
}

const duplicate = () =>
  new AppError(409, 'Duplicate ledger operation (already processed)', 'DUPLICATE_LEDGER_KEY')

/**
 * The primary row of an operation already exists. Same requestId: return the committed result.
 * Otherwise it is a real duplicate.
 */
async function replayOrDuplicate<T>(
  primaryKey: string,
  requestId: string,
  rebuild: (row: { balanceAfter: bigint; refId: string | null }) => Promise<T>,
): Promise<T & { replayed: true }> {
  const row = await prisma.coinLedgerEntry.findUnique({
    where: { idempotencyKey: primaryKey },
    select: { balanceAfter: true, refId: true, metadata: true },
  })
  if (!row || metaRequestId(row.metadata) !== requestId) throw duplicate()
  return { ...(await rebuild(row)), replayed: true }
}

async function pointBalanceAfterKey(key: string): Promise<bigint | null> {
  const row = await prisma.pointLedgerEntry.findUnique({
    where: { idempotencyKey: key },
    select: { balanceAfter: true },
  })
  return row?.balanceAfter ?? null
}

async function loadSendableGift(giftId: string, opts: { lucky: boolean }) {
  const gift = await prisma.gift.findUnique({
    where: { id: giftId },
    include: { category: { select: { name: true, slug: true } } },
  })
  if (!gift || !gift.isActive)
    throw new AppError(404, 'Gift not found or is inactive.', 'GIFT_NOT_FOUND')
  if (opts.lucky !== isLuckyGift(gift)) {
    throw new AppError(
      400,
      opts.lucky ? 'This gift is not a lucky gift.' : 'Lucky gifts use the lucky-gift operation.',
      'WRONG_GIFT_KIND',
    )
  }
  return gift
}

function insufficient(required: bigint, balance: bigint) {
  return new AppError(402, 'Insufficient coins', 'INSUFFICIENT_COINS', {
    required: required.toString(),
    balance: balance.toString(),
  })
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export type GiftSendInput = {
  requestId: string
  context: 'live_stream' | 'video_call'
  senderId: string
  receiverId: string
  giftId: string
  quantity: number
  /** Live-server's gift_transactions id, generated once per logical send. */
  giftTransactionId: string
  /** Ledger key base: `gift-stream:<sender>:<clientTxId>` / `gift-stream:<txid>` (live), `gift:...` (call). */
  idemBase: string
  /** video_call only: the session the gift is sent in. */
  sessionId?: string
}

export type GiftSendResult = {
  transactionId: string
  coinCost: string
  pointsAwarded: string
  balanceAfterCoins: string
  balanceAfterPoints: string
  wealth: { newLevel: number; previousLevel: number }
  agencyUserId: string | null
  replayed: boolean
}

async function giftSend(input: GiftSendInput): Promise<GiftSendResult> {
  // Live-server parity: a host may gift in their own live room (PARK-01, 2026-09-20; sender COIN
  // and receiver POINT are different wallets). A video-call gift always has two participants.
  if (input.context === 'video_call' && input.senderId === input.receiverId) {
    throw new AppError(400, 'Cannot send a gift to yourself', 'INVALID_REQUEST')
  }
  if (input.context === 'video_call') {
    if (!input.sessionId) throw new AppError(400, 'sessionId is required', 'INVALID_REQUEST')
    const session = await prisma.videoCallSession.findUnique({ where: { id: input.sessionId } })
    if (!session) throw new AppError(404, 'Video call session not found.', 'CALL_NOT_FOUND')
    if (session.status !== 'ACTIVE') {
      throw new AppError(409, 'Video call session is not active.', 'CALL_NOT_ACTIVE')
    }
    const participants = [session.callerId, session.creatorId]
    if (!participants.includes(input.senderId) || !participants.includes(input.receiverId)) {
      throw new AppError(403, 'Not a participant of this call', 'FORBIDDEN')
    }
  }

  const gift = await loadSendableGift(input.giftId, { lucky: false })
  const qty = BigInt(input.quantity)
  const coinCost = BigInt(gift.coinCost) * qty
  const shares = await hostRevenueShareConfigService.getShares()
  const points = hostPointsFromGift(coinCost, shares.giftReceiveBp)
  const isLive = input.context === 'live_stream'
  const coinKey = `${input.idemBase}-coin`
  const pointKey = `${input.idemBase}-point`

  let settled
  try {
    settled = await runMoneyTx(async (tx) => {
      const { payerCoin, hostPoint } = await lockForOperation(tx, {
        payerUserId: input.senderId,
        hostUserId: input.receiverId,
        withCommission: true,
      })
      const coins = await latestCoinBalance(tx, payerCoin.id)
      if (coins < coinCost) throw insufficient(coinCost, coins)
      const balanceAfterCoins = coins - coinCost
      const pointsBefore = await latestPointBalance(tx, hostPoint!.id)
      const balanceAfterPoints = pointsBefore + points

      await coinLedgerRepository.insert(tx, {
        walletId: payerCoin.id,
        direction: LedgerDirection.DEBIT,
        txType: CoinTxType.GIFT_SEND,
        amount: coinCost,
        balanceAfter: balanceAfterCoins,
        idempotencyKey: coinKey,
        refId: input.giftTransactionId,
        counterpartyId: input.receiverId,
        description: isLive
          ? `Sent gift ${gift.name} in live stream`
          : `Sent gift ${gift.name} x${input.quantity} in video call`,
        metadata: {
          giftId: gift.id,
          giftTransactionId: input.giftTransactionId,
          context: input.context,
          quantity: input.quantity,
          requestId: input.requestId,
        },
      })
      await walletRepository.bumpVersion(tx, payerCoin.id)

      const hostLedger = await pointLedgerRepository.insert(tx, {
        walletId: hostPoint!.id,
        direction: LedgerDirection.CREDIT,
        txType: PointTxType.GIFT_RECEIVE,
        amount: points,
        balanceAfter: balanceAfterPoints,
        idempotencyKey: pointKey,
        refId: input.giftTransactionId,
        counterpartyId: input.senderId,
        description: isLive
          ? `Received gift ${gift.name} in live stream`
          : `Received gift ${gift.name} x${input.quantity} in video call`,
        metadata: {
          giftId: gift.id,
          giftName: gift.name,
          context: input.context,
          quantity: input.quantity,
          unitCoinCost: gift.coinCost,
          giftTransactionId: input.giftTransactionId,
        },
      })
      await walletRepository.bumpVersion(tx, hostPoint!.id)

      await tx.giftTransaction.create({
        data: {
          id: input.giftTransactionId,
          senderUserId: input.senderId,
          receiverUserId: input.receiverId,
          giftId: gift.id,
          // Live-server parity: the live-stream row has always stored the unit cost (with
          // `quantity` beside it), the video-call row the total.
          coinCost: isLive ? gift.coinCost : Number(coinCost),
          quantity: input.quantity,
          pointsAwarded: Number(points),
          context: input.context,
        },
      })

      const wealth = await applyLevel(tx, input.senderId, LevelType.WEALTH, coinCost)
      await applyLevel(tx, input.receiverId, LevelType.LIVESTREAM, points)
      const agencyUserId = await settleHostCredit(tx, {
        hostUserId: input.receiverId,
        hostLedgerEntryId: hostLedger.id,
        points,
        txType: PointTxType.GIFT_RECEIVE,
        withCommission: true,
      })
      return { balanceAfterCoins, balanceAfterPoints, wealth, agencyUserId }
    })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    return replayOrDuplicate(coinKey, input.requestId, async (row) => ({
      transactionId: row.refId ?? input.giftTransactionId,
      coinCost: coinCost.toString(),
      pointsAwarded: points.toString(),
      balanceAfterCoins: row.balanceAfter.toString(),
      balanceAfterPoints: ((await pointBalanceAfterKey(pointKey)) ?? 0n).toString(),
      wealth: await currentLevel(input.senderId, LevelType.WEALTH),
      agencyUserId: null,
    }))
  }

  await afterCommit({
    coinUserId: input.senderId,
    coinBalance: settled.balanceAfterCoins,
    pointUserId: input.receiverId,
    pointBalance: settled.balanceAfterPoints,
    wealthUserId: input.senderId,
    livestreamUserId: input.receiverId,
    agencyUserId: settled.agencyUserId,
  })

  return {
    transactionId: input.giftTransactionId,
    coinCost: coinCost.toString(),
    pointsAwarded: points.toString(),
    balanceAfterCoins: settled.balanceAfterCoins.toString(),
    balanceAfterPoints: settled.balanceAfterPoints.toString(),
    wealth: { newLevel: settled.wealth.newLevel, previousLevel: settled.wealth.previousLevel },
    agencyUserId: settled.agencyUserId,
    replayed: false,
  }
}

export type LuckyGiftInput = {
  requestId: string
  senderId: string
  /** null = the sender (Live-server's `receiverId || senderId`). */
  receiverId: string | null
  giftId: string
  count: number
  giftTransactionId: string
  /** `lucky:<sender>:<clientTxId>` or `lucky:<txid>`. */
  txKeyBase: string
  /** Drawn by Live-server's RTP engine. */
  rewardCoins: string
  category: string
}

export type LuckyGiftResult = {
  transactionId: string
  totalCost: string
  hostPoints: string
  rewardCoins: string
  finalBalanceCoins: string
  pointsAfterHost: string | null
  effectiveReceiverId: string
  wealth: { newLevel: number; previousLevel: number }
  agencyUserId: string | null
  replayed: boolean
}

async function luckyGiftSend(input: LuckyGiftInput): Promise<LuckyGiftResult> {
  const gift = await loadSendableGift(input.giftId, { lucky: true })
  const count = input.count
  const isCombo = count > 1
  const totalCost = BigInt(gift.coinCost) * BigInt(count)
  const reward = BigInt(input.rewardCoins)
  const maxReward =
    totalCost * (isCombo ? LUCKY_MAX_REWARD_MULTIPLE.combo : LUCKY_MAX_REWARD_MULTIPLE.single)
  if (reward < 0n || reward > maxReward) {
    throw new AppError(400, 'Lucky reward out of range', 'INVALID_LUCKY_REWARD', {
      rewardCoins: reward.toString(),
      max: maxReward.toString(),
    })
  }
  // Admin setting (host_revenue_share_config.lucky_host_share_bp, default 400 = 4%).
  const { luckyHostShareBp, luckyTargetRtpBp } = await hostRevenueShareConfigService.getShares()
  const hostPoints = (totalCost * BigInt(luckyHostShareBp)) / 10_000n
  const receiverId = input.receiverId || input.senderId
  const context = isCombo ? 'LUCKY_COMBO' : 'LUCKY_SINGLE'
  const debitKey = `${input.txKeyBase}-debit`
  const hostKey = `${input.txKeyBase}-host-cut`
  // Single lucky gifts pay no agency commission; combos do (decision 2026-10-17).
  const withCommission = isCombo && hostPoints > 0n

  let settled
  try {
    settled = await runMoneyTx(async (tx) => {
      const { payerCoin, hostPoint } = await lockForOperation(tx, {
        payerUserId: input.senderId,
        hostUserId: receiverId,
        withCommission,
      })
      const coins = await latestCoinBalance(tx, payerCoin.id)
      if (coins < totalCost) throw insufficient(totalCost, coins)
      const coinsAfterDebit = coins - totalCost

      await coinLedgerRepository.insert(tx, {
        walletId: payerCoin.id,
        amount: totalCost,
        direction: LedgerDirection.DEBIT,
        txType: CoinTxType.GIFT_SEND,
        balanceAfter: coinsAfterDebit,
        idempotencyKey: debitKey,
        refId: input.giftTransactionId,
        counterpartyId: receiverId,
        description: `Lucky Gift Sent: ${gift.name} x${count}`,
        metadata: {
          giftId: gift.id,
          giftTransactionId: input.giftTransactionId,
          context,
          quantity: count,
          requestId: input.requestId,
        },
      })
      // Wealth XP tracks the full spend; the reward is a separate credit, not a discount.
      const wealth = await applyLevel(tx, input.senderId, LevelType.WEALTH, totalCost)

      let finalBalanceCoins = coinsAfterDebit
      if (reward > 0n) {
        finalBalanceCoins = coinsAfterDebit + reward
        await coinLedgerRepository.insert(tx, {
          walletId: payerCoin.id,
          amount: reward,
          direction: LedgerDirection.CREDIT,
          txType: CoinTxType.PLATFORM_REWARD,
          balanceAfter: finalBalanceCoins,
          idempotencyKey: `${input.txKeyBase}-reward`,
          refId: input.giftTransactionId,
          description: `Lucky Winner: ${gift.name} (${input.category})`,
        })
      }
      await walletRepository.bumpVersion(tx, payerCoin.id)

      let pointsAfterHost: bigint | null = null
      let agencyUserId: string | null = null
      if (hostPoints > 0n) {
        pointsAfterHost = (await latestPointBalance(tx, hostPoint!.id)) + hostPoints
        const hostLedger = await pointLedgerRepository.insert(tx, {
          walletId: hostPoint!.id,
          amount: hostPoints,
          direction: LedgerDirection.CREDIT,
          txType: PointTxType.LIVESTREAM_GIFT,
          balanceAfter: pointsAfterHost,
          idempotencyKey: hostKey,
          refId: input.giftTransactionId,
          counterpartyId: input.senderId,
          description: `Received Lucky Gift: ${gift.name}`,
          metadata: {
            giftId: gift.id,
            giftName: gift.name,
            context,
            quantity: count,
            unitCoinCost: gift.coinCost,
            giftTransactionId: input.giftTransactionId,
          },
        })
        await walletRepository.bumpVersion(tx, hostPoint!.id)
        // Host livestream XP = the host's points (decision 2026-10-17).
        await applyLevel(tx, receiverId, LevelType.LIVESTREAM, hostPoints)
        agencyUserId = await settleHostCredit(tx, {
          hostUserId: receiverId,
          hostLedgerEntryId: hostLedger.id,
          points: hostPoints,
          txType: PointTxType.LIVESTREAM_GIFT,
          withCommission,
        })
      }

      await tx.giftTransaction.create({
        data: {
          id: input.giftTransactionId,
          senderUserId: input.senderId,
          receiverUserId: receiverId,
          giftId: gift.id,
          coinCost: Number(totalCost),
          quantity: count,
          pointsAwarded: Number(hostPoints),
          context,
        },
      })
      // LIVE-31: the RTP counters commit with the gift. Last statement, so the slot's row lock is
      // held for the shortest time; a random slot keeps concurrent lucky gifts off one row.
      await addToLuckyReservePool(tx, { cost: totalCost, reward, targetRtpBp: luckyTargetRtpBp })
      return { finalBalanceCoins, pointsAfterHost, wealth, agencyUserId }
    })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    return replayOrDuplicate(debitKey, input.requestId, async () => {
      const rewardRow = await prisma.coinLedgerEntry.findUnique({
        where: { idempotencyKey: `${input.txKeyBase}-reward` },
        select: { balanceAfter: true, amount: true },
      })
      const debitRow = await prisma.coinLedgerEntry.findUnique({
        where: { idempotencyKey: debitKey },
        select: { balanceAfter: true },
      })
      const hostAfter = await pointBalanceAfterKey(hostKey)
      return {
        transactionId: input.giftTransactionId,
        totalCost: totalCost.toString(),
        hostPoints: hostPoints.toString(),
        rewardCoins: (rewardRow?.amount ?? 0n).toString(),
        finalBalanceCoins: (rewardRow?.balanceAfter ?? debitRow?.balanceAfter ?? 0n).toString(),
        pointsAfterHost: hostAfter?.toString() ?? null,
        effectiveReceiverId: receiverId,
        wealth: await currentLevel(input.senderId, LevelType.WEALTH),
        agencyUserId: null,
      }
    })
  }

  await afterCommit({
    coinUserId: input.senderId,
    coinBalance: settled.finalBalanceCoins,
    pointUserId: settled.pointsAfterHost != null ? receiverId : null,
    pointBalance: settled.pointsAfterHost,
    wealthUserId: input.senderId,
    livestreamUserId: hostPoints > 0n ? receiverId : null,
    agencyUserId: settled.agencyUserId,
  })

  return {
    transactionId: input.giftTransactionId,
    totalCost: totalCost.toString(),
    hostPoints: hostPoints.toString(),
    rewardCoins: reward.toString(),
    finalBalanceCoins: settled.finalBalanceCoins.toString(),
    pointsAfterHost: settled.pointsAfterHost?.toString() ?? null,
    effectiveReceiverId: receiverId,
    wealth: { newLevel: settled.wealth.newLevel, previousLevel: settled.wealth.previousLevel },
    agencyUserId: settled.agencyUserId,
    replayed: false,
  }
}

type SessionRow = {
  id: string
  callerId: string
  creatorId: string
  pricePerMin: number
  status: string
  minsCharged: number
  coinsDeducted: bigint
  pointsAwarded: bigint
  startedAt: Date
}

/** The call row, locked: accept/minute/end serialize on it (closes the bill-after-end race). */
async function lockSession(tx: Tx, sessionId: string): Promise<SessionRow | null> {
  const rows = await tx.$queryRaw<SessionRow[]>`
    SELECT id, caller_id AS "callerId", creator_id AS "creatorId", price_per_min AS "pricePerMin",
           status, mins_charged AS "minsCharged", coins_deducted AS "coinsDeducted",
           points_awarded AS "pointsAwarded", started_at AS "startedAt"
    FROM video_call_sessions WHERE id = ${sessionId} FOR UPDATE
  `
  return rows[0] ?? null
}

function serializeSession(s: {
  id: string
  callerId: string
  creatorId: string
  livekitRoom: string
  pricePerMin: number
  status: string
  minsCharged: number
  coinsDeducted: bigint
  pointsAwarded: bigint
  startedAt: Date
  endedAt: Date | null
  endReason: string | null
}) {
  return {
    ...s,
    coinsDeducted: s.coinsDeducted.toString(),
    pointsAwarded: s.pointsAwarded.toString(),
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
  }
}

/** Bill one call minute inside `tx` (caller COIN debit, host POINT credit, XP, commission). */
async function billMinute(tx: Tx, session: SessionRow, minute: number, requestId: string) {
  const shares = await hostRevenueShareConfigService.getShares()
  const pointRate = BigInt(session.pricePerMin)
  const coinRate = callerCoinDebitForCall(pointRate, shares.videoCallHostShareBp)

  const { payerCoin, hostPoint } = await lockForOperation(tx, {
    payerUserId: session.callerId,
    hostUserId: session.creatorId,
    withCommission: true,
  })
  const coins = await latestCoinBalance(tx, payerCoin.id)
  if (coins < coinRate) throw insufficient(coinRate, coins)
  const balanceAfterCoins = coins - coinRate

  await coinLedgerRepository.insert(tx, {
    walletId: payerCoin.id,
    direction: LedgerDirection.DEBIT,
    txType: CoinTxType.VIDEO_CALL,
    amount: coinRate,
    balanceAfter: balanceAfterCoins,
    idempotencyKey: `call-${session.id}-min-${minute}-coins`,
    refId: session.id,
    counterpartyId: session.creatorId,
    description: `Video call minute ${minute} charge`,
    metadata: { requestId },
  })
  await walletRepository.bumpVersion(tx, payerCoin.id)

  const balanceAfterPoints = (await latestPointBalance(tx, hostPoint!.id)) + pointRate
  const hostLedger = await pointLedgerRepository.insert(tx, {
    walletId: hostPoint!.id,
    direction: LedgerDirection.CREDIT,
    txType: PointTxType.VIDEO_CALL,
    amount: pointRate,
    balanceAfter: balanceAfterPoints,
    idempotencyKey: `call-${session.id}-min-${minute}-points`,
    refId: session.id,
    counterpartyId: session.callerId,
    description: `Points for video call minute ${minute}`,
  })
  await walletRepository.bumpVersion(tx, hostPoint!.id)

  await applyLevel(tx, session.callerId, LevelType.WEALTH, coinRate)
  await applyLevel(tx, session.creatorId, LevelType.LIVESTREAM, pointRate)
  // LIVE-25: minute 1 included, the commission commits with the minute it derives from.
  const agencyUserId = await settleHostCredit(tx, {
    hostUserId: session.creatorId,
    hostLedgerEntryId: hostLedger.id,
    points: pointRate,
    txType: PointTxType.VIDEO_CALL,
    withCommission: true,
  })
  return {
    coinRate,
    pointRate,
    balanceAfterCoins,
    balanceAfterPoints,
    agencyUserId,
    hostLedgerId: hostLedger.id,
  }
}

export type CallAcceptInput = { requestId: string; sessionId: string; receiverId: string }

async function callAccept(input: CallAcceptInput) {
  const minute1Key = `call-${input.sessionId}-min-1-coins`
  let settled
  try {
    settled = await runMoneyTx(async (tx) => {
      const session = await lockSession(tx, input.sessionId)
      if (!session || session.creatorId !== input.receiverId) {
        throw new AppError(409, 'Invalid session or unauthorized.', 'INVALID_CALL_STATE')
      }
      if (session.status !== 'RINGING') {
        // A retry of an accept that already committed gets its result; anything else is stale.
        throw new AppError(409, 'Invalid session or unauthorized.', 'INVALID_CALL_STATE', {
          replayable: true,
        })
      }
      const bill = await billMinute(tx, session, 1, input.requestId)
      const updated = await tx.videoCallSession.update({
        where: { id: session.id },
        data: {
          status: 'ACTIVE',
          startedAt: new Date(),
          minsCharged: 1,
          coinsDeducted: bill.coinRate,
          pointsAwarded: bill.pointRate,
        },
      })
      return { ...bill, session: updated }
    })
  } catch (err) {
    const replayable =
      isUniqueViolation(err) || (err instanceof AppError && err.details?.replayable === true)
    if (!replayable) throw err
    try {
      return await replayOrDuplicate(minute1Key, input.requestId, async () => {
        const session = await prisma.videoCallSession.findUniqueOrThrow({
          where: { id: input.sessionId },
        })
        const shares = await hostRevenueShareConfigService.getShares()
        const pointRate = BigInt(session.pricePerMin)
        return {
          session: serializeSession(session),
          hostLedgerId: null as string | null,
          coinRate: callerCoinDebitForCall(pointRate, shares.videoCallHostShareBp).toString(),
          pointRate: pointRate.toString(),
          balanceAfterCoins: null as string | null,
          agencyUserId: null as string | null,
        }
      })
    } catch (replayErr) {
      if (replayErr instanceof AppError && replayErr.code === 'DUPLICATE_LEDGER_KEY') {
        throw new AppError(409, 'Invalid session or unauthorized.', 'INVALID_CALL_STATE')
      }
      throw replayErr
    }
  }

  await afterCommit({
    coinUserId: settled.session.callerId,
    coinBalance: settled.balanceAfterCoins,
    pointUserId: settled.session.creatorId,
    pointBalance: settled.balanceAfterPoints,
    wealthUserId: settled.session.callerId,
    livestreamUserId: settled.session.creatorId,
    agencyUserId: settled.agencyUserId,
  })

  return {
    session: serializeSession(settled.session),
    hostLedgerId: settled.hostLedgerId as string | null,
    coinRate: settled.coinRate.toString(),
    pointRate: settled.pointRate.toString(),
    balanceAfterCoins: settled.balanceAfterCoins.toString() as string | null,
    agencyUserId: settled.agencyUserId,
    replayed: false,
  }
}

export type CallMinuteInput = { requestId: string; sessionId: string; minute: number }

/**
 * Bill minute `minute` (>= 2) of an ACTIVE call. Under the session row lock: a call that is no
 * longer ACTIVE is never billed (LIVE-26 half), and a minute already billed returns
 * `alreadyBilled` instead of writing again.
 */
async function callMinute(input: CallMinuteInput) {
  const settled = await runMoneyTx(async (tx) => {
    const session = await lockSession(tx, input.sessionId)
    if (!session) throw new AppError(404, 'Session not found', 'CALL_NOT_FOUND')
    if (session.minsCharged >= input.minute) {
      return { alreadyBilled: true as const, session }
    }
    if (session.status !== 'ACTIVE') {
      throw new AppError(409, 'Call is not active', 'CALL_NOT_ACTIVE')
    }
    if (session.minsCharged !== input.minute - 1) {
      throw new AppError(409, 'Minutes must be billed in order', 'MINUTE_OUT_OF_ORDER', {
        minsCharged: session.minsCharged,
      })
    }
    const bill = await billMinute(tx, session, input.minute, input.requestId)
    await tx.videoCallSession.update({
      where: { id: session.id },
      data: {
        minsCharged: input.minute,
        coinsDeducted: { increment: bill.coinRate },
        pointsAwarded: { increment: bill.pointRate },
      },
    })
    return { alreadyBilled: false as const, session, ...bill }
  })

  if (settled.alreadyBilled) {
    return {
      alreadyBilled: true,
      minute: input.minute,
      balanceAfterCoins: null,
      agencyUserId: null,
    }
  }
  await afterCommit({
    coinUserId: settled.session.callerId,
    coinBalance: settled.balanceAfterCoins,
    pointUserId: settled.session.creatorId,
    pointBalance: settled.balanceAfterPoints,
    wealthUserId: settled.session.callerId,
    livestreamUserId: settled.session.creatorId,
    agencyUserId: settled.agencyUserId,
  })
  return {
    alreadyBilled: false,
    minute: input.minute,
    coinRate: settled.coinRate.toString(),
    pointRate: settled.pointRate.toString(),
    balanceAfterCoins: settled.balanceAfterCoins.toString(),
    agencyUserId: settled.agencyUserId,
  }
}

export type GlobalMessageInput = {
  requestId: string
  senderId: string
  messageTxId: string
  /** `global-msg:<sender>:<clientTxId>` or `global-msg:<messageTxId>`. */
  idemKey: string
  /** Used for the ledger description only (first 30 chars). */
  message: string
}

async function globalMessage(input: GlobalMessageInput) {
  let settled
  try {
    settled = await runMoneyTx(async (tx) => {
      const { payerCoin } = await lockForOperation(tx, {
        payerUserId: input.senderId,
        withCommission: false,
      })
      const coins = await latestCoinBalance(tx, payerCoin.id)
      if (coins < GLOBAL_MESSAGE_COST) throw insufficient(GLOBAL_MESSAGE_COST, coins)
      const balanceAfterCoins = coins - GLOBAL_MESSAGE_COST
      await coinLedgerRepository.insert(tx, {
        walletId: payerCoin.id,
        direction: LedgerDirection.DEBIT,
        txType: CoinTxType.GLOBAL_MESSAGE,
        amount: GLOBAL_MESSAGE_COST,
        balanceAfter: balanceAfterCoins,
        idempotencyKey: input.idemKey,
        refId: input.messageTxId,
        description: `Sent global message: "${input.message.substring(0, 30)}..."`,
        metadata: { requestId: input.requestId },
      })
      await walletRepository.bumpVersion(tx, payerCoin.id)
      const wealth = await applyLevel(tx, input.senderId, LevelType.WEALTH, GLOBAL_MESSAGE_COST)
      return { balanceAfterCoins, wealth }
    })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    return replayOrDuplicate(input.idemKey, input.requestId, async (row) => ({
      transactionId: input.messageTxId,
      balanceAfterCoins: row.balanceAfter.toString(),
      wealthLevel: (await currentLevel(input.senderId, LevelType.WEALTH)).newLevel,
    }))
  }

  await afterCommit({
    coinUserId: input.senderId,
    coinBalance: settled.balanceAfterCoins,
    wealthUserId: input.senderId,
  })
  return {
    transactionId: input.messageTxId,
    balanceAfterCoins: settled.balanceAfterCoins.toString(),
    wealthLevel: settled.wealth.newLevel,
    replayed: false,
  }
}

export const internalLedgerService = {
  giftSend,
  luckyGiftSend,
  callAccept,
  callMinute,
  globalMessage,
}
