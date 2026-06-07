import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { SUBSCRIPTION_GRACE_QUEUE, SUBSCRIPTION_RENEWAL_QUEUE } from './subscription.constants'

export const renewalQueue = new Queue(SUBSCRIPTION_RENEWAL_QUEUE, {
  connection: redisClient,
})

export const graceQueue = new Queue(SUBSCRIPTION_GRACE_QUEUE, {
  connection: redisClient,
})

export async function enqueueSubscriptionRenewal(subscriptionId: string, runAt: Date) {
  const delay = Math.max(0, runAt.getTime() - Date.now())
  await renewalQueue.add(
    'renew',
    { subscriptionId },
    {
      delay,
      jobId: `sub-renewal-${subscriptionId}`,
      removeOnComplete: true,
    },
  )
}

export async function cancelSubscriptionRenewalJob(subscriptionId: string) {
  const job = await renewalQueue.getJob(`sub-renewal-${subscriptionId}`)
  await job?.remove()
}

export async function enqueueSubscriptionGrace(subscriptionId: string, runAt: Date) {
  const delay = Math.max(0, runAt.getTime() - Date.now())
  await graceQueue.add(
    'grace',
    { subscriptionId },
    {
      delay,
      jobId: `sub-grace-${subscriptionId}`,
      removeOnComplete: true,
    },
  )
}

export async function cancelSubscriptionGraceJob(subscriptionId: string) {
  const job = await graceQueue.getJob(`sub-grace-${subscriptionId}`)
  await job?.remove()
}
