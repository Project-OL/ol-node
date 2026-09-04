import { CoinTxType, LedgerDirection, PointTxType } from '@prisma/client'

export type LedgerWalletContext = 'POINT' | 'COIN' | 'TRADING_COIN' | 'DIAMOND'

type DirectionKey = 'CREDIT' | 'DEBIT'

function dirKey(direction: LedgerDirection | DirectionKey | 'credit' | 'debit'): DirectionKey {
  return String(direction).toUpperCase() as DirectionKey
}

const POINT_NAMES: Partial<Record<PointTxType, Partial<Record<DirectionKey, string>>>> = {
  GIFT_RECEIVE: { CREDIT: 'Gift received' },
  VIDEO_CALL: { CREDIT: 'Video call earnings' },
  SUBSCRIPTION: { CREDIT: 'Subscription earning' },
  GUARDIAN_PURCHASE: { CREDIT: 'Guardian earnings' },
  AGENT_COMMISSION: { CREDIT: 'Agent commission' },
  PAYROLL_HOST_PAYOUT: { CREDIT: 'Host payroll points' },
  PAYROLL_TAKEOVER_INVENTORY: { CREDIT: 'Payroll takeover inventory' },
  PAYROLL_PROCESSING_REWARD: { CREDIT: 'Payroll reward' },
  AGENT_POINT_TRANSFER: {
    CREDIT: 'Point transfer received',
    DEBIT: 'Point transfer sent',
  },
  WITHDRAWAL_REFUND: { CREDIT: 'Withdrawal refund' },
  PLATFORM_REWARD: { CREDIT: 'Platform reward' },
  LIVESTREAM_STREAK_REWARD: { CREDIT: 'Livestream daily reward' },
  ADJUSTMENT: { CREDIT: 'Admin point credit' },
  WITHDRAWAL_ESCROW: { DEBIT: 'Withdraw requested' },
  WITHDRAWAL_ESCROW_SETTLED: { DEBIT: 'Withdraw settled' },
  TRANSFER_OUT: { DEBIT: 'Point - coins exchange' },
  AGENCY_FORCE_EXIT_PENALTY: { DEBIT: 'Agency force exit penalty' },
  WITHDRAWAL: { DEBIT: 'Withdrawal' },
  TRANSFER_IN: { CREDIT: 'Point transfer received' },
  LIVESTREAM_GIFT: { CREDIT: 'Livestream gift' },
  COMMISSION: { CREDIT: 'Commission' },
}

const COIN_NAMES: Partial<Record<CoinTxType, Partial<Record<DirectionKey, string>>>> = {
  TOPUP: { CREDIT: 'Topup' },
  TRADING_TRANSFER_IN: { CREDIT: 'Coins received' },
  VIP_REWARD: { CREDIT: 'VIP reward' },
  POINT_EXCHANGE_TO_COINS: { CREDIT: 'Point - coins exchange' },
  ADJUSTMENT: { CREDIT: 'Admin coin received' },
  GIFT_SEND: { DEBIT: 'Gift sent' },
  VIDEO_CALL: { DEBIT: 'Video call charges' },
  CREATOR_SUBSCRIPTION: { DEBIT: 'Subscription payment' },
  GUARDIAN_PURCHASE: { DEBIT: 'Guardian payment' },
  STORE_ITEM_PURCHASE: { DEBIT: 'Store payment' },
  VIP_PURCHASE: { DEBIT: 'Rare ID payment' },
  VIP_MEMBERSHIP_PURCHASE: { DEBIT: 'VIP membership' },
  USERNAME_CHANGE: { DEBIT: 'Username update' },
  TRADING_TOPUP: { CREDIT: 'Topup' },
  TRADING_EXCHANGE_FROM_POINTS: { CREDIT: 'Point - coins exchange' },
  TRADING_TRANSFER_OUT: { DEBIT: 'Coins sent' },
  TRADING_TRANSFER_REVERSAL: {
    CREDIT: 'Transfer reversal',
    DEBIT: 'Transfer reversal',
  },
  TRANSFER_OUT: { DEBIT: 'Coins sent' },
  TRANSFER_IN: { CREDIT: 'Coins received' },
  GIFT_REFUND: { CREDIT: 'Gift refund' },
  PLATFORM_REWARD: { CREDIT: 'Platform reward' },
  DAILY_LOGIN: { CREDIT: 'Daily login reward' },
  WEEKLY_TOPUP: { CREDIT: 'Weekly topup bonus' },
  EXPIRE: { DEBIT: 'Coin expiry' },
  DIAMOND_PURCHASE_OUT: { DEBIT: 'Diamonds purchased' },
  DIAMOND_PURCHASE_IN: { CREDIT: 'Diamonds purchased' },
  DIAMOND_REDEEM_OUT: { DEBIT: 'Diamonds redeemed' },
  DIAMOND_REDEEM_IN: { CREDIT: 'Diamonds redeemed' },
  GAME_WAGER_OUT: { DEBIT: 'Game bet' },
  GAME_WAGER_IN: { CREDIT: 'Game bet received' },
  GAME_RESULT_OUT: { DEBIT: 'Game payout' },
  GAME_RESULT_IN: { CREDIT: 'Game winnings' },
  GAME_REFUND_OUT: { DEBIT: 'Game bet refund' },
  GAME_REFUND_IN: { CREDIT: 'Game bet refund' },
  GAME_ADJUSTMENT: { CREDIT: 'Admin diamond credit', DEBIT: 'Admin diamond debit' },
}

export function getTransactionName(
  walletContext: LedgerWalletContext,
  txType: PointTxType | CoinTxType | string,
  direction: LedgerDirection | DirectionKey | 'credit' | 'debit',
): string {
  const d = dirKey(direction)

  if (walletContext === 'POINT') {
    const label = POINT_NAMES[txType as PointTxType]?.[d]
    if (label) return label
  } else {
    const label = COIN_NAMES[txType as CoinTxType]?.[d]
    if (label) return label
  }

  return String(txType)
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
