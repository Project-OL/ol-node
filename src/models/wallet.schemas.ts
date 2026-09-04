import { z } from 'zod'
import { POINT_HISTORY_FILTER_VALUES } from '../config/point-earnings-categories'
import { COIN_HISTORY_FILTER_VALUES } from '../config/coin-earnings-categories'
import { GAME_DIAMOND_HISTORY_FILTER_VALUES } from '../config/game-diamond-transaction-filters'

function queryStringArray<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined
    return Array.isArray(v) ? v : [v]
  }, z.array(itemSchema).optional())
}

// ── Shared ──────────────────────────────────────────────────────────────────

export const CursorPaginationSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const DateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

// ── Coins ───────────────────────────────────────────────────────────────────

export const CoinTxTypeEnum = z.enum([
  'TOPUP',
  'TRADING_TRANSFER_IN',
  'GIFT_SEND',
  'GIFT_REFUND',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'VIP_PURCHASE',
  'VIP_REWARD',
  'DAILY_LOGIN',
  'WEEKLY_TOPUP',
  'PLATFORM_REWARD',
  'EXPIRE',
  'ADJUSTMENT',
  'VIDEO_CALL',
  'USERNAME_CHANGE',
  'CREATOR_SUBSCRIPTION',
  'GUARDIAN_PURCHASE',
  'STORE_ITEM_PURCHASE',
  'VIP_MEMBERSHIP_PURCHASE',
  'POINT_EXCHANGE_TO_COINS',
])

/** Category aliases (`topup`, `gift`, …) or raw `CoinTxType` values. */
export const CoinHistoryFilterEnum = z.enum(
  COIN_HISTORY_FILTER_VALUES as unknown as [string, ...string[]],
)

export const CoinHistoryQuerySchema = DateRangeSchema.merge(CursorPaginationSchema).extend({
  types: queryStringArray(CoinHistoryFilterEnum),
})

export const TopupInitiateSchema = z.object({
  packageId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
})

export const TopupConfirmSchema = z.object({
  orderId: z.string().uuid(),
  gatewayRef: z.string().max(256),
  idempotencyKey: z.string().min(8).max(128),
})

// ── Diamonds ───────────────────────────────────────────────────────────────

export const DiamondHistoryFilterEnum = z.enum(
  GAME_DIAMOND_HISTORY_FILTER_VALUES as unknown as [string, ...string[]],
)

export const DiamondHistoryQuerySchema = DateRangeSchema.merge(CursorPaginationSchema).extend({
  types: queryStringArray(DiamondHistoryFilterEnum),
})

export const DiamondBuySchema = z.object({
  coinAmount: z.coerce.bigint().positive(),
  idempotencyKey: z.string().min(8).max(128),
})

export const DiamondRedeemSchema = z.object({
  diamondAmount: z.coerce.bigint().positive(),
  idempotencyKey: z.string().min(8).max(128),
})

// ── Points ─────────────────────────────────────────────────────────────────

export const PointTxTypeEnum = z.enum([
  'LIVESTREAM_GIFT',
  'SUBSCRIPTION',
  'GUARDIAN_PURCHASE',
  'COMMISSION',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'PLATFORM_REWARD',
  'WITHDRAWAL',
  'WITHDRAWAL_REFUND',
  'ADJUSTMENT',
  'VIDEO_CALL',
  'GIFT_RECEIVE',
  'AGENCY_FORCE_EXIT_PENALTY',
  'AGENT_COMMISSION',
  'AGENT_POINT_TRANSFER',
  'PAYROLL_PROCESSING_REWARD',
  'WITHDRAWAL_ESCROW',
  'WITHDRAWAL_ESCROW_SETTLED',
  'PAYROLL_HOST_PAYOUT',
  'LIVESTREAM_STREAK_REWARD',
  'PAYROLL_TAKEOVER_INVENTORY',
])

/** Category aliases (`livestream`, `commission`, …) or raw `PointTxType` values. */
export const PointHistoryFilterEnum = z.enum(
  POINT_HISTORY_FILTER_VALUES as unknown as [string, ...string[]],
)

export const PointHistoryQuerySchema = DateRangeSchema.merge(CursorPaginationSchema).extend({
  types: queryStringArray(PointHistoryFilterEnum),
})

export const PointSummaryPeriodEnum = z.enum([
  'LAST_30_DAYS',
  'LAST_7_DAYS',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_WEEK',
  'LAST_WEEK',
])

export const PointSummaryQuerySchema = z.object({
  period: PointSummaryPeriodEnum.optional(),
})

export const PointLedgerEntryParamsSchema = z.object({
  entryId: z.string().uuid(),
})

/** Business refId (gift tx, withdrawal, subscription, transfer, …). */
export const PointLedgerRefParamsSchema = z.object({
  refId: z.string().min(1).max(255),
})

/** Display order number from point transaction detail (`YYMMDDHHmmss` + suffix). */
export const PointOrderNumberParamsSchema = z.object({
  orderNumber: z.string().regex(/^\d{15,20}$/),
})

export const ReportPointTransactionSchema = z.object({
  orderNumber: z.string().regex(/^\d{15,20}$/),
  description: z.string().min(1).max(250),
  imageUrl: z.string().url().optional(),
})

import { grossPointsFromUsd } from '../utils/withdrawal-amount'

export const WithdrawInitiateSchema = z
  .object({
    amountPoints: z.coerce.bigint().positive().optional(),
    amountUsd: z.coerce.number().positive().optional(),
    paymentMethodId: z.string().uuid(),
    idempotencyKey: z.string().min(8).max(128),
    notes: z.string().max(500).optional(),
  })
  .transform((data) => {
    let grossPoints: bigint
    if (data.amountUsd != null) {
      grossPoints = grossPointsFromUsd(data.amountUsd)
    } else if (data.amountPoints != null) {
      grossPoints = data.amountPoints
    } else {
      throw new z.ZodError([
        {
          code: 'custom',
          message: 'Provide amountUsd or amountPoints',
          path: ['amountUsd'],
        },
      ])
    }
    return {
      grossPoints,
      paymentMethodId: data.paymentMethodId,
      idempotencyKey: data.idempotencyKey,
      notes: data.notes,
    }
  })
