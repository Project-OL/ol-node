import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { EPAY_WEBHOOK_RETRY_JOB, EPAY_WEBHOOK_RETRY_QUEUE } from './epay-webhook.constants'

export const epayWebhookRetryQueue = new Queue(EPAY_WEBHOOK_RETRY_QUEUE, {
  connection: redisClient,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 1000,
    removeOnFail: 500,
  },
})

export async function enqueueWebhookRetry(
  payload: unknown,
  orderType: 'PERSONAL_TOPUP' | 'TRADING_TOPUP',
) {
  await epayWebhookRetryQueue.add(EPAY_WEBHOOK_RETRY_JOB, { payload, orderType })
}
