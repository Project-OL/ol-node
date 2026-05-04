import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import {
  RARE_ID_EXPIRY_JOB,
  STORE_ITEM_EXPIRY_JOB,
  STORE_ITEM_EXPIRY_QUEUE,
} from './store-item-expiry.constants'

export const storeItemExpiryQueue = new Queue(STORE_ITEM_EXPIRY_QUEUE, {
  connection: redisClient,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: 500 },
})

export async function enqueueStoreItemExpiry(
  userStoreItemId: string,
  expiresAt: Date,
): Promise<void> {
  const delay = Math.max(0, expiresAt.getTime() - Date.now())
  await storeItemExpiryQueue.add(
    STORE_ITEM_EXPIRY_JOB,
    { userStoreItemId },
    { jobId: `store-expiry-${userStoreItemId}`, delay },
  )
}

export async function enqueueRareIdAssignmentExpiry(
  assignmentId: string,
  expiresAt: Date,
): Promise<void> {
  const delay = Math.max(0, expiresAt.getTime() - Date.now())
  await storeItemExpiryQueue.add(
    RARE_ID_EXPIRY_JOB,
    { assignmentId },
    { jobId: `rare-id-expiry-${assignmentId}`, delay },
  )
}
