/**
 * Infer whether a ledger row came from a known app / admin / unknown path.
 * No first-class `source` column — use idempotencyKey prefixes + metadata.source.
 */

/** Prefixes used by app / system money paths (coins + points). */
export const APP_LEDGER_IDEM_PREFIXES = [
  'vip-membership-purchase:',
  'vip-daily-claim:',
  'gift-send:',
  'gift:',
  'gift-msg:',
  'store-purchase:',
  'store-rare-id:',
  'ct-topup:',
  'ct-exchange:',
  'trading-topup:',
  'trading-transfer:',
  'trading-reversal:',
  'exchange-pts:',
  'exchange-ct:',
  'exchange-coin:',
  'withdrawal-',
  'withdrawal:',
  'payroll-',
  'sub:create:',
  'sub-renewal:',
  'sub-grace:',
  'custom-gift:',
  'custom-gift-refund:',
  'username-change:',
  'agency-force-exit:',
  'agency-commission:',
  'agent-point-transfer:',
  'guardian-purchase:',
  'videocall-',
  'livestream-reward:',
  'epay-personal-topup:',
] as const

/** Coin / point tx types that are always produced by product flows (even with client-raw keys). */
export const APP_COIN_TX_TYPES = new Set([
  'TOPUP',
  'TRADING_TOPUP',
  'GIFT_SEND',
  'GIFT_REFUND',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'TRADING_TRANSFER_OUT',
  'TRADING_TRANSFER_IN',
  'TRADING_EXCHANGE_FROM_POINTS',
  'TRADING_TRANSFER_REVERSAL',
  'VIP_PURCHASE',
  'VIP_REWARD',
  'DAILY_LOGIN',
  'WEEKLY_TOPUP',
  'PLATFORM_REWARD',
  'EXPIRE',
  'VIDEO_CALL',
  'USERNAME_CHANGE',
  'CREATOR_SUBSCRIPTION',
  'GUARDIAN_PURCHASE',
  'STORE_ITEM_PURCHASE',
  'VIP_MEMBERSHIP_PURCHASE',
  'POINT_EXCHANGE_TO_COINS',
  'CUSTOM_GIFT_REQUEST',
  'CUSTOM_GIFT_REFUND',
])

export const APP_POINT_TX_TYPES = new Set([
  'LIVESTREAM_GIFT',
  'SUBSCRIPTION',
  'GUARDIAN_PURCHASE',
  'COMMISSION',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'PLATFORM_REWARD',
  'WITHDRAWAL',
  'WITHDRAWAL_REFUND',
  'VIDEO_CALL',
  'GIFT_RECEIVE',
  'AGENCY_FORCE_EXIT_PENALTY',
  'AGENT_COMMISSION',
  'AGENT_POINT_TRANSFER',
  'PAYROLL_PROCESSING_REWARD',
  'WITHDRAWAL_ESCROW',
  'WITHDRAWAL_ESCROW_SETTLED',
  'PAYROLL_HOST_PAYOUT',
  'PAYROLL_TAKEOVER_INVENTORY',
  'LIVESTREAM_STREAK_REWARD',
])

export type LedgerOriginClass = 'APP' | 'ADMIN' | 'UNKNOWN'

export function isAdminLedgerProvenance(
  idempotencyKey: string,
  metadata: unknown,
): boolean {
  if (idempotencyKey.startsWith('admin-wallet-')) return true
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const source = (metadata as Record<string, unknown>).source
    if (typeof source === 'string' && source.startsWith('admin_wallet_')) return true
  }
  return false
}

export function matchesAppIdemPrefix(idempotencyKey: string): boolean {
  return APP_LEDGER_IDEM_PREFIXES.some((p) => idempotencyKey.startsWith(p))
}

export function classifyCoinLedgerOrigin(args: {
  idempotencyKey: string
  metadata: unknown
  txType: string
}): LedgerOriginClass {
  if (isAdminLedgerProvenance(args.idempotencyKey, args.metadata)) return 'ADMIN'
  if (matchesAppIdemPrefix(args.idempotencyKey)) return 'APP'
  if (APP_COIN_TX_TYPES.has(args.txType) && args.txType !== 'ADJUSTMENT') return 'APP'
  return 'UNKNOWN'
}

export function classifyPointLedgerOrigin(args: {
  idempotencyKey: string
  metadata: unknown
  txType: string
}): LedgerOriginClass {
  if (isAdminLedgerProvenance(args.idempotencyKey, args.metadata)) return 'ADMIN'
  if (matchesAppIdemPrefix(args.idempotencyKey)) return 'APP'
  if (APP_POINT_TX_TYPES.has(args.txType) && args.txType !== 'ADJUSTMENT') return 'APP'
  return 'UNKNOWN'
}
