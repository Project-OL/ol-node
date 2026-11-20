import crypto from 'crypto'

/**
 * Our `merchantOrderNo` for Epay. Epay callbacks carry no order type, so the 2-letter prefix
 * routes a callback to the right table:
 *   CP = personal COIN top-up (coin_topup_orders)
 *   CT = agency TRADING_COIN top-up (coin_trading_topup_orders)
 *   WD = Epay-to-Epay withdrawal payout (epay_payout_orders)
 * Format: prefix + yyMMdd (UTC) + 16 uppercase hex = 24 chars, short enough for any sane
 * gateway limit (Epay has not stated one yet).
 */
export const EPAY_ORDER_PREFIX = {
  PERSONAL_TOPUP: 'CP',
  TRADING_TOPUP: 'CT',
  WITHDRAWAL_PAYOUT: 'WD',
} as const

export type EpayOrderKind = keyof typeof EPAY_ORDER_PREFIX

const ORDER_NO_RE = /^(CP|CT|WD)\d{6}[0-9A-F]{16}$/

export function makeEpayMerchantOrderNo(kind: EpayOrderKind, now: Date = new Date()): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0')
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase()
  return `${EPAY_ORDER_PREFIX[kind]}${yy}${mm}${dd}${rand}`
}

/** Strict parse: anything not minted by {@link makeEpayMerchantOrderNo} returns null. */
export function epayOrderKindOf(merchantOrderNo: unknown): EpayOrderKind | null {
  if (typeof merchantOrderNo !== 'string' || !ORDER_NO_RE.test(merchantOrderNo)) return null
  switch (merchantOrderNo.slice(0, 2)) {
    case 'CP':
      return 'PERSONAL_TOPUP'
    case 'CT':
      return 'TRADING_TOPUP'
    case 'WD':
      return 'WITHDRAWAL_PAYOUT'
    default:
      return null
  }
}
