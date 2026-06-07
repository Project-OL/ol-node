import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { VIP_MEMBERSHIP_EXPIRY_JOB, VIP_MEMBERSHIP_EXPIRY_QUEUE } from './vip-membership.constants'

export const vipMembershipExpiryQueue = new Queue(VIP_MEMBERSHIP_EXPIRY_QUEUE, {
  connection: redisClient,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 500,
  },
})

/** BullMQ rejects custom `jobId` values with `:` unless they split into 3 segments (repeatable jobs). */
const expiryJobId = (userId: string) => `vipm-expiry-${userId}`

export async function removeVipMembershipExpiry(userId: string) {
  const job = await vipMembershipExpiryQueue.getJob(expiryJobId(userId))
  await job?.remove()
}

export async function enqueueVipMembershipExpiry(userId: string, expiresAt: Date): Promise<void> {
  await removeVipMembershipExpiry(userId)
  const delay = Math.max(0, expiresAt.getTime() - Date.now())
  await vipMembershipExpiryQueue.add(
    VIP_MEMBERSHIP_EXPIRY_JOB,
    { userId },
    {
      jobId: expiryJobId(userId),
      delay,
    },
  )
}
