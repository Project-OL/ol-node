import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { GUARDIAN_EXPIRY_QUEUE } from './guardian.constants'

export const guardianExpiryQueue = new Queue(GUARDIAN_EXPIRY_QUEUE, {
  connection: redisClient,
})

export async function enqueueGuardianExpiry(guardianId: string, expiresAt: Date) {
  await cancelGuardianExpiryJob(guardianId)
  const delay = Math.max(0, expiresAt.getTime() - Date.now())
  await guardianExpiryQueue.add(
    'expire',
    { guardianId },
    {
      delay,
      jobId: `guardian-expiry-${guardianId}`,
      removeOnComplete: true,
    },
  )
}

export async function cancelGuardianExpiryJob(guardianId: string) {
  const job = await guardianExpiryQueue.getJob(`guardian-expiry-${guardianId}`)
  await job?.remove()
}
