import { randomUUID } from 'crypto'
import type { CoinTxType, CustomGiftRequestStatus } from '@prisma/client'
import { LevelType } from '@prisma/client'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import {
  customGiftRepository,
  type CustomGiftRequestWithGift,
} from '../repositories/customGift.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { coinWalletService } from './coin-wallet.service'
import { walletService } from './wallet.service'
import { syncLevelCacheFromApplyResult, type LevelApplyResult } from './user-level.service'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'
import type { CreateCustomGiftRequestBody } from '../models/custom-gift.schemas'
import {
  buildCustomGiftPackages,
  coinCostForDuration,
  resolveCustomGiftDuration,
  validityDaysForDuration,
  type CustomGiftDurationMonths,
} from '../utils/custom-gift-pricing'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

export interface CustomGiftRequestDto {
  id: string
  whatsappNumber: string
  note: string | null
  /** Requested gift validity in days; null when the user did not specify. */
  validityDays: number | null
  /** Package duration that was charged (1 or 3). Null on legacy rows. */
  durationMonths: CustomGiftDurationMonths | null
  coinCost: string
  status: CustomGiftRequestStatus
  failureReason: string | null
  refunded: boolean
  gift: { id: string; name: string; code: string; displayImageUrl: string } | null
  createdAt: string
  resolvedAt: string | null
}

function inferDurationMonths(validityDays: number | null): CustomGiftDurationMonths | null {
  if (validityDays === 90) return 3
  if (validityDays === 30) return 1
  return null
}

export function toRequestDto(row: CustomGiftRequestWithGift): CustomGiftRequestDto {
  return {
    id: row.id,
    whatsappNumber: row.whatsappNumber,
    note: row.note,
    validityDays: row.validityDays,
    durationMonths: inferDurationMonths(row.validityDays),
    coinCost: row.coinCost.toString(),
    status: row.status,
    failureReason: row.failureReason,
    refunded: row.refunded,
    gift: row.gift
      ? {
          id: row.gift.id,
          name: row.gift.name,
          code: row.gift.code,
          displayImageUrl: row.gift.displayImageUrl,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }
}

export const customGiftService = {
  /**
   * Public config: duration packages (1 month / 3 months) with coin costs,
   * plus legacy `coinCost` (= 1-month price) for older clients.
   */
  async getConfig(): Promise<{
    coinCost: string
    enabled: boolean
    description: string | null
    packages: ReturnType<typeof buildCustomGiftPackages>
  }> {
    const config = await customGiftRepository.getOrCreateConfig()
    const packages = buildCustomGiftPackages(config)
    return {
      coinCost: packages[0]!.coinCost,
      enabled: config.enabled,
      description: config.description,
      packages,
    }
  },

  /**
   * Raise a custom gift request: debits the package coin cost for the selected
   * duration (1 or 3 months) immediately (this is the "payment"), then CS reaches
   * out on WhatsApp. One PENDING request per user (partial unique index backstops
   * the pre-check).
   *
   * Read Committed: the buyer's COIN wallet FOR UPDATE inside `debit` is the
   * serializer; the ledger idempotency key makes retries replay (the request
   * row is found via its unique ledgerEntryId), and parallel duplicates
   * converge via one P2002 re-run — same envelope as VIP purchase.
   */
  async createRequest(
    userId: string,
    body: CreateCustomGiftRequestBody,
  ): Promise<CustomGiftRequestDto> {
    const config = await customGiftRepository.getOrCreateConfig()
    if (!config.enabled) {
      throw new AppError(403, 'Custom gift requests are currently disabled', 'CUSTOM_GIFT_DISABLED')
    }

    const durationMonths = resolveCustomGiftDuration({
      durationMonths: body.durationMonths,
      validityDays: body.validityDays,
    })
    const validityDays = validityDaysForDuration(durationMonths)
    const coinCost = coinCostForDuration(config, durationMonths)
    const idempotencyKey = `custom-gift:${userId}:${body.idempotencyKey ?? randomUUID()}`

    let wealthResult: LevelApplyResult | null = null
    const runTransaction = () =>
      prisma.$transaction(
        async (tx) => {
          // Replay before the pending gate: a same-key retry of a request that
          // already settled must return the original row, not the 409.
          if (body.idempotencyKey) {
            const priorLedger = await coinLedgerRepository.findByIdempotencyKey(tx, idempotencyKey)
            if (priorLedger) {
              const prior = await customGiftRepository.findByLedgerEntryId(priorLedger.id, tx)
              if (prior) return prior
            }
          }

          const pending = await customGiftRepository.findPendingByUserId(userId, tx)
          if (pending) {
            throw new AppError(
              409,
              'You already have a pending custom gift request',
              'CUSTOM_GIFT_REQUEST_PENDING',
              { requestId: pending.id },
            )
          }

          const { ledgerEntryId, wealthLevelResult } = await coinWalletService.debit(
            userId,
            coinCost,
            'CUSTOM_GIFT_REQUEST' as CoinTxType,
            tx,
            {
              idempotencyKey,
              description: `Custom gift request (${durationMonths} month${durationMonths === 1 ? '' : 's'})`,
              metadata: {
                whatsappNumber: body.whatsappNumber,
                durationMonths,
                validityDays,
              },
              applyWealthXp: true,
            },
          )
          wealthResult = wealthLevelResult

          // Replay: the debit returned an existing ledger row for this key.
          const existing = await customGiftRepository.findByLedgerEntryId(ledgerEntryId, tx)
          if (existing) return existing

          return customGiftRepository.create(
            {
              userId,
              whatsappNumber: body.whatsappNumber,
              note: body.note,
              validityDays,
              coinCost,
              ledgerEntryId,
            },
            tx,
          )
        },
        { timeout: INTERACTIVE_TX_TIMEOUT_MS },
      )

    let request
    try {
      request = await withSerializationRetry(runTransaction)
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Either a parallel duplicate idempotency key (debit now replays) or a
        // parallel first request (pre-check now throws the 409). One re-run
        // converges both.
        request = await runTransaction()
      } else {
        throw err
      }
    }

    await walletService.adjustCoinBalanceCache(userId, coinCost)
    await syncLevelCacheFromApplyResult(userId, LevelType.WEALTH, wealthResult)

    const withGift = await customGiftRepository.findByIdWithGift(request.id)
    return toRequestDto(withGift!)
  },

  async listMyRequests(
    userId: string,
    params: { status?: CustomGiftRequestStatus; limit: number; cursor?: string },
  ): Promise<{ requests: CustomGiftRequestDto[]; nextCursor: string | null }> {
    const rows = await customGiftRepository.listByUser({ userId, ...params })
    const hasMore = rows.length > params.limit
    const page = hasMore ? rows.slice(0, params.limit) : rows
    return {
      requests: page.map(toRequestDto),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    }
  },
}
