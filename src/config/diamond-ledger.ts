import { CoinTxType, WalletCurrencyType } from '@prisma/client'

/**
 * The COIN-wallet legs of a Coin↔Diamond conversion. The diamond half of the pair lands
 * on the DIAMOND wallet; these two are the matching rows on the user's COIN wallet.
 */
const DIAMOND_CONVERSION_COIN_TX_TYPES = new Set<CoinTxType>([
  CoinTxType.DIAMOND_PURCHASE_OUT,
  CoinTxType.DIAMOND_REDEEM_IN,
])

/**
 * True for every ledger row that moves diamonds: the whole DIAMOND wallet (game wagers,
 * payouts, refunds, admin adjustments, purchase-in, redeem-out — user and house alike)
 * plus the COIN legs of a conversion.
 *
 * Diamond movement produces no transactional inbox message and no push. Game play writes
 * several ledger rows per round on both the player and GAME_HOUSE wallets, so messaging
 * them buries the inbox in noise the user never asked for. The ledger rows themselves are
 * untouched — `/wallet/diamonds/history` and the admin explorer still show everything.
 */
export function isDiamondLedgerMovement(
  currencyType: WalletCurrencyType,
  txType: CoinTxType,
): boolean {
  return currencyType === WalletCurrencyType.DIAMOND || DIAMOND_CONVERSION_COIN_TX_TYPES.has(txType)
}
