import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { WALLET_WITHDRAWAL_QUEUE } from './wallet-withdrawal.constants'

export { WALLET_WITHDRAWAL_QUEUE }

export const walletWithdrawalQueue = new Queue(WALLET_WITHDRAWAL_QUEUE, {
  connection: redisClient,
})
