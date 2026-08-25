import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { env } from '../config/env'
import { videoCallRepository } from '../repositories/video-call.repository'
import { walletRepository } from '../repositories/wallet.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { walletService } from './wallet.service'
import { walletLevelService, syncLevelCacheFromApplyResult } from './user-level.service'
import { walletUserLevelRepository } from '../repositories/wallet-user-level.repository'
import { userRepository } from '../repositories/user.repository'
import { auditService } from './audit.service'
import { assertNotBlockedEitherWay } from '../utils/block-relationship'
import {
  WalletCurrencyType,
  CoinTxType,
  PointTxType,
  LedgerDirection,
  LevelType,
} from '@prisma/client'
import { MIN_CALL_PRICE, type UpdateCallSettingsInput } from '../models/call.schemas'
import { utcDayFromTimestamp } from '../utils/datetime'
import { callerCoinDebitForCall } from '../config/host-revenue-shares'
import { hostRevenueShareConfigService } from './hostRevenueShareConfig.service'
import { videoCallPriceCapService } from './videoCallPriceCap.service'
import { livekitCircuitBreaker } from '../utils/circuitBreaker'
import { assertCoinDebitAllowed } from './wallet-freeze.service'
import { lockWalletsInOrder } from '../utils/wallet-lock-order'

/** Public call-settings shape — always populated (virtual defaults when no DB row). */
export type VideoCallSettingsDto = {
  userId: string
  pricePerMin: number
  blockLv5: boolean
  blockLv10: boolean
  acceptVideoCalls: boolean
  /** Host livestream level used to resolve allowedPrices (additive). */
  livestreamLevel?: number
  /** Discrete pricePerMin values this host may choose (additive). */
  allowedPrices?: number[]
}

const DEFAULT_CALL_SETTINGS = {
  pricePerMin: MIN_CALL_PRICE,
  blockLv5: false,
  blockLv10: false,
  acceptVideoCalls: true,
} as const

function toPublicSettings(
  userId: string,
  row: {
    pricePerMin?: number | null
    blockLv5?: boolean | null
    blockLv10?: boolean | null
    acceptVideoCalls?: boolean | null
  } | null,
): VideoCallSettingsDto {
  return {
    userId,
    pricePerMin: row?.pricePerMin ?? DEFAULT_CALL_SETTINGS.pricePerMin,
    blockLv5: row?.blockLv5 ?? DEFAULT_CALL_SETTINGS.blockLv5,
    blockLv10: row?.blockLv10 ?? DEFAULT_CALL_SETTINGS.blockLv10,
    acceptVideoCalls: row?.acceptVideoCalls ?? DEFAULT_CALL_SETTINGS.acceptVideoCalls,
  }
}

async function withAllowedPrices(
  userId: string,
  base: VideoCallSettingsDto,
): Promise<VideoCallSettingsDto> {
  const record = await walletUserLevelRepository.getByUser(userId, LevelType.LIVESTREAM)
  const livestreamLevel = record?.currentLevel ?? 1
  const allowedPrices = await videoCallPriceCapService.getAllowedPricesForLevel(livestreamLevel)
  return { ...base, livestreamLevel, allowedPrices }
}

// ── LiveKit helpers ───────────────────────────────────────────────────────────

function getLivekitClient(): RoomServiceClient {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new AppError(503, 'Video call service not configured', 'LIVEKIT_NOT_CONFIGURED')
  }
  return new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
}

async function buildToken(userId: string, roomName: string): Promise<string> {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new AppError(503, 'Video call service not configured', 'LIVEKIT_NOT_CONFIGURED')
  }
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: userId,
    ttl: '2h',
  })
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })
  return at.toJwt()
}

// ── Settings ──────────────────────────────────────────────────────────────────

export const videoCallSettingsService = {
  /**
   * Effective settings for a user. Users without a `video_call_settings` row get:
   * `{ pricePerMin: 1800, blockLv5: false, blockLv10: false, acceptVideoCalls: true }`.
   */
  async get(userId: string): Promise<VideoCallSettingsDto> {
    const settings = await videoCallRepository.getSettings(userId)
    return withAllowedPrices(userId, toPublicSettings(userId, settings))
  },

  /**
   * Create default settings row if missing. Call on new-user registration so
   * Live-server initiate does not fail with "Receiver has not enabled video calls."
   */
  async ensureDefaults(userId: string): Promise<void> {
    await videoCallRepository.ensureDefaults(userId)
  },

  /** Whether the user currently wants to receive video calls (default true). */
  async getAcceptVideoCalls(userId: string): Promise<boolean> {
    const settings = await videoCallRepository.getSettings(userId)
    return settings?.acceptVideoCalls ?? DEFAULT_CALL_SETTINGS.acceptVideoCalls
  },

  /** Returns the configured allow-list (DB / admin) for the Call Price UI. */
  async priceTable() {
    return videoCallPriceCapService.priceTable()
  },

  async update(userId: string, input: UpdateCallSettingsInput): Promise<VideoCallSettingsDto> {
    if (input.pricePerMin !== undefined) {
      const record = await walletUserLevelRepository.getByUser(userId, LevelType.LIVESTREAM)
      const livestreamLevel = record?.currentLevel ?? 1
      await videoCallPriceCapService.assertPriceAllowed(livestreamLevel, input.pricePerMin)
    }

    const row = await videoCallRepository.upsertSettings(userId, input)
    return withAllowedPrices(userId, toPublicSettings(userId, row))
  },

  async setAcceptVideoCalls(
    userId: string,
    acceptVideoCalls: boolean,
  ): Promise<VideoCallSettingsDto> {
    const row = await videoCallRepository.upsertSettings(userId, { acceptVideoCalls })
    return withAllowedPrices(userId, toPublicSettings(userId, row))
  },
}

// ── Session ────────────────────────────────────────────────────────────────────

export const videoCallSessionService = {
  async initiate(callerId: string, creatorPublicId: string) {
    // Resolve creator
    const numericId = Number(creatorPublicId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
    }
    const creator = await userRepository.findByPublicId(numericId)
    if (!creator) throw new AppError(404, 'Creator not found', 'NOT_FOUND')
    if (creator.id === callerId) throw new AppError(400, 'Cannot call yourself', 'INVALID_REQUEST')

    await assertNotBlockedEitherWay(callerId, creator.id)

    // Get creator call settings
    const settings = await videoCallRepository.getSettings(creator.id)
    if (settings?.acceptVideoCalls === false) {
      throw new AppError(
        403,
        'This user is not accepting video calls right now',
        'VIDEO_CALLS_DISABLED',
      )
    }
    const pricePerMin = settings?.pricePerMin ?? MIN_CALL_PRICE

    // Check caller is not already in an active session with this creator
    const existing = await videoCallRepository.getActiveSessionBetween(callerId, creator.id)
    if (existing) {
      throw new AppError(409, 'Already in an active call with this user', 'CALL_ALREADY_ACTIVE')
    }

    // Check caller wealth level against creator restrictions
    if (settings?.blockLv5 || settings?.blockLv10) {
      const callerLevel = await walletUserLevelRepository.getByUser(callerId, LevelType.WEALTH)
      const wealthLevel = callerLevel?.currentLevel ?? 1

      if (settings.blockLv10 && wealthLevel <= 10) {
        throw new AppError(
          403,
          'Your wealth level is too low to call this creator',
          'LEVEL_RESTRICTED',
        )
      }
      if (settings.blockLv5 && wealthLevel <= 5) {
        throw new AppError(
          403,
          'Your wealth level is too low to call this creator',
          'LEVEL_RESTRICTED',
        )
      }
    }

    // Check caller has enough coins for the first minute. The host sets `pricePerMin`
    // in POINTS; the caller is charged coins at the markup rate.
    await assertCoinDebitAllowed(callerId, WalletCurrencyType.COIN)
    const callerBalance = await walletService.getCoinBalance(callerId)
    const shares = await hostRevenueShareConfigService.getShares()
    const firstMinuteCoinCost = callerCoinDebitForCall(
      BigInt(pricePerMin),
      shares.videoCallHostShareBp,
    )
    if (callerBalance < firstMinuteCoinCost) {
      throw new AppError(402, 'Insufficient coins for a one-minute call', 'INSUFFICIENT_COINS', {
        required: firstMinuteCoinCost.toString(),
        balance: callerBalance.toString(),
      })
    }

    // Create LiveKit room and tokens
    const roomName = `videocall-${uuidv4()}`
    const lk = getLivekitClient()
    if (livekitCircuitBreaker.shouldSkip()) {
      throw new AppError(502, 'Video call service temporarily unavailable', 'LIVEKIT_CIRCUIT_OPEN')
    }
    try {
      await lk.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 2 })
      livekitCircuitBreaker.recordSuccess()
    } catch (err) {
      livekitCircuitBreaker.recordFailure()
      throw err
    }

    const [callerToken, creatorToken] = await Promise.all([
      buildToken(callerId, roomName),
      buildToken(creator.id, roomName),
    ])

    // Persist session
    const session = await videoCallRepository.createSession({
      callerId,
      creatorId: creator.id,
      livekitRoom: roomName,
      pricePerMin,
    })

    auditService.log({
      userId: callerId,
      actionType: 'VIDEO_CALL_INITIATED',
      actionStatus: 'success',
      actionDetails: { sessionId: session.id, creatorId: creator.id, pricePerMin },
    })

    return {
      sessionId: session.id,
      roomName,
      pricePerMin,
      callerToken,
      creatorToken,
    }
  },

  /**
   * Called once per minute during an active call.
   * Deducts coins from caller, credits points to creator.
   * Returns canContinue=false when caller cannot afford the next minute.
   */
  async tick(sessionId: string, callerId: string) {
    const session = await videoCallRepository.getSession(sessionId)
    if (!session) throw new AppError(404, 'Session not found', 'NOT_FOUND')
    if (session.callerId !== callerId) throw new AppError(403, 'Forbidden', 'FORBIDDEN')
    if (session.status !== 'ACTIVE') {
      throw new AppError(409, 'Call is not active', 'CALL_NOT_ACTIVE')
    }

    // Host's set price per minute is denominated in POINTS (`hostPricePerMin`).
    // The caller is charged coins at the markup rate so the host receives exactly
    // their set price as points.
    const hostPricePerMin = BigInt(session.pricePerMin)
    const shares = await hostRevenueShareConfigService.getShares()
    const callerDebit = callerCoinDebitForCall(hostPricePerMin, shares.videoCallHostShareBp)
    const minuteNum = session.minsCharged + 1
    const idemBase = `videocall-${sessionId}-min-${minuteNum}`

    try {
      await assertCoinDebitAllowed(session.callerId, WalletCurrencyType.COIN)
    } catch (e) {
      if (e instanceof AppError && e.code === 'PERSONAL_COINS_FROZEN') {
        await this.endInternal(sessionId, 'ENDED', 'Caller personal coins frozen')
      }
      throw e
    }

    // Debit coins from caller
    const callerCoinWallet = await walletRepository.getOrCreate(
      session.callerId,
      WalletCurrencyType.COIN,
    )
    const creatorPointWallet = await walletRepository.getOrCreate(
      session.creatorId,
      WalletCurrencyType.POINT,
    )

    let bustAgentUserId: string | null = null
    let callerWealthResult: Awaited<ReturnType<typeof walletLevelService.applyCredit>> | null = null
    let creatorLivestreamResult: Awaited<ReturnType<typeof walletLevelService.applyCredit>> | null =
      null

    await prisma.$transaction(
      async (tx) => {
        // Deterministic id-order locking (not caller-then-creator) so this can
        // never lock-order-invert against another code path that locks these
        // two wallet types in the opposite order — see lockWalletsInOrder's
        // other call sites (admin revert, live transfer, coin-trading exchange).
        await lockWalletsInOrder(tx, [callerCoinWallet, creatorPointWallet])

        const lastCoin = await tx.coinLedgerEntry.findFirst({
          where: { walletId: callerCoinWallet.id },
          orderBy: { createdAt: 'desc' },
          select: { balanceAfter: true },
        })
        const coinBalance = lastCoin?.balanceAfter ?? 0n
        if (coinBalance < callerDebit) {
          throw new AppError(402, 'Insufficient coins', 'INSUFFICIENT_COINS')
        }

        await coinLedgerRepository.insert(tx, {
          walletId: callerCoinWallet.id,
          direction: LedgerDirection.DEBIT,
          txType: CoinTxType.VIDEO_CALL,
          amount: callerDebit,
          balanceAfter: coinBalance - callerDebit,
          refId: sessionId,
          counterpartyId: session.creatorId,
          description: `Video call min #${minuteNum}`,
          idempotencyKey: `${idemBase}-coin`,
        })
        await walletRepository.bumpVersion(tx, callerCoinWallet.id)

        // Wealth XP tracks coin SPEND: the caller's full coin debit for the minute.
        callerWealthResult = await walletLevelService.applyCredit(
          tx,
          session.callerId,
          LevelType.WEALTH,
          callerDebit,
        )

        // creatorPointWallet already locked above via lockWalletsInOrder.
        const lastPoint = await tx.pointLedgerEntry.findFirst({
          where: { walletId: creatorPointWallet.id },
          orderBy: { createdAt: 'desc' },
          select: { balanceAfter: true },
        })
        const pointBalance = lastPoint?.balanceAfter ?? 0n

        const ptEntry = await pointLedgerRepository.insert(tx, {
          walletId: creatorPointWallet.id,
          direction: LedgerDirection.CREDIT,
          txType: PointTxType.VIDEO_CALL,
          amount: hostPricePerMin,
          balanceAfter: pointBalance + hostPricePerMin,
          refId: sessionId,
          counterpartyId: session.callerId,
          description: `Video call min #${minuteNum}`,
          idempotencyKey: `${idemBase}-point`,
        })
        await walletRepository.bumpVersion(tx, creatorPointWallet.id)

        const { agencyCommissionService } = await import('./agencyCommission.service')
        const ac = await agencyCommissionService.applyCommission(
          {
            hostUserId: session.creatorId,
            hostLedgerEntryId: ptEntry.id,
            hostPointsCredited: hostPricePerMin,
            hostTxType: PointTxType.VIDEO_CALL,
            day: utcDayFromTimestamp(new Date()),
          },
          tx,
        )

        const { rankingService } = await import('./ranking.service')
        await rankingService.onHostPointCredit(
          {
            hostUserId: session.creatorId,
            amount: hostPricePerMin,
            txType: PointTxType.VIDEO_CALL,
            day: utcDayFromTimestamp(new Date()),
          },
          tx,
        )
        bustAgentUserId = ac.bustAgentUserId

        // Livestream XP tracks host earnings: the host's point credit (their set price).
        creatorLivestreamResult = await walletLevelService.applyCredit(
          tx,
          session.creatorId,
          LevelType.LIVESTREAM,
          hostPricePerMin,
        )
      },
      { timeout: 20_000 },
    )

    await syncLevelCacheFromApplyResult(session.callerId, LevelType.WEALTH, callerWealthResult)
    await syncLevelCacheFromApplyResult(
      session.creatorId,
      LevelType.LIVESTREAM,
      creatorLivestreamResult,
    )

    if (bustAgentUserId) {
      const { agencyCommissionService } = await import('./agencyCommission.service')
      await agencyCommissionService.afterCommissionCreditCommit(bustAgentUserId)
    }

    // Invalidate caches
    await walletService.adjustCoinBalanceCache(session.callerId, 0n)
    await walletService.adjustPointBalanceCache(session.creatorId, 0n)

    // Update session counters: coins deducted from caller, points awarded to host.
    await videoCallRepository.incrementMinute(sessionId, callerDebit, hostPricePerMin)

    // Check if caller can afford the next minute
    const remainingBalance = await walletService.getCoinBalance(session.callerId)
    const canContinue = remainingBalance >= callerDebit

    if (!canContinue) {
      await this.endInternal(sessionId, 'INSUFFICIENT_COINS', 'Caller ran out of coins')
    }

    return { canContinue, coinsRemaining: remainingBalance.toString() }
  },

  async end(sessionId: string, requesterId: string) {
    const session = await videoCallRepository.getSession(sessionId)
    if (!session) throw new AppError(404, 'Session not found', 'NOT_FOUND')
    if (session.callerId !== requesterId && session.creatorId !== requesterId) {
      throw new AppError(403, 'Forbidden', 'FORBIDDEN')
    }
    if (session.status !== 'ACTIVE') return { status: session.status } // idempotent

    await this.endInternal(sessionId, 'ENDED', 'Ended by participant')
    return { status: 'ENDED' }
  },

  async endInternal(sessionId: string, status: 'ENDED' | 'INSUFFICIENT_COINS', reason: string) {
    await videoCallRepository.endSession(sessionId, status, reason)

    // Best-effort: delete the LiveKit room
    try {
      const session = await videoCallRepository.getSession(sessionId)
      if (session && !livekitCircuitBreaker.shouldSkip()) {
        const lk = getLivekitClient()
        await lk.deleteRoom(session.livekitRoom)
        livekitCircuitBreaker.recordSuccess()
      }
    } catch {
      livekitCircuitBreaker.recordFailure()
      // Non-critical — room will auto-expire via emptyTimeout
    }
  },

  /** Return a fresh LiveKit token for a participant joining an active session. */
  async joinToken(sessionId: string, requesterId: string) {
    const session = await videoCallRepository.getSession(sessionId)
    if (!session) throw new AppError(404, 'Session not found', 'NOT_FOUND')
    if (session.callerId !== requesterId && session.creatorId !== requesterId) {
      throw new AppError(403, 'Forbidden', 'FORBIDDEN')
    }
    if (session.status !== 'ACTIVE') {
      throw new AppError(409, 'Call is not active', 'CALL_NOT_ACTIVE')
    }
    const token = await buildToken(requesterId, session.livekitRoom)
    return { token, roomName: session.livekitRoom }
  },
}
