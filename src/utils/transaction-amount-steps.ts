import { AppError } from '../middlewares/errorHandler'

/** Points → COIN / TRADING_COIN exchange (`POST /coin-trading/exchange`). */
export const POINTS_EXCHANGE_STEP = 10_000n

/** Agent trading-coin transfer (`POST /coin-trading/transfer`). */
export const TRADING_COIN_TRANSFER_STEP = 100n

/** Agent peer point transfer (`POST /agency/transfer-points`). */
export const AGENT_POINT_TRANSFER_STEP = 100_000n

/** Video call host price per minute (points). */
export const VIDEO_CALL_PRICE_STEP = 1800

/**
 * Require `amount` to be a positive exact multiple of `step`.
 * Withdrawal intentionally does not use this — any gross above min is allowed.
 */
export function assertPositiveAmountMultiple(
  amount: bigint,
  step: bigint,
  opts: { belowMinCode: string; unitLabel: string },
): void {
  if (amount < step) {
    throw new AppError(400, `Minimum ${opts.unitLabel} is ${step.toString()}`, opts.belowMinCode, {
      step: step.toString(),
      minimum: step.toString(),
    })
  }
  if (amount % step !== 0n) {
    throw new AppError(
      400,
      `${opts.unitLabel} must be an exact multiple of ${step.toString()}`,
      'INVALID_AMOUNT_STEP',
      { step: step.toString(), amount: amount.toString() },
    )
  }
}

export function assertPositiveIntMultiple(
  amount: number,
  step: number,
  opts: { belowMinCode: string; unitLabel: string },
): void {
  if (!Number.isInteger(amount) || amount < step) {
    throw new AppError(400, `Minimum ${opts.unitLabel} is ${step}`, opts.belowMinCode, {
      step: String(step),
      minimum: String(step),
    })
  }
  if (amount % step !== 0) {
    throw new AppError(
      400,
      `${opts.unitLabel} must be an exact multiple of ${step}`,
      'INVALID_AMOUNT_STEP',
      { step: String(step), amount: String(amount) },
    )
  }
}
