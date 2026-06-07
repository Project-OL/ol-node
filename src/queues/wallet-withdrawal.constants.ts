/** BullMQ queue name for async withdrawal processing — shared by API (producer) and worker (consumer). */
/** BullMQ disallows `:` in queue names. */
export const WALLET_WITHDRAWAL_QUEUE = 'wallet-withdrawals'
