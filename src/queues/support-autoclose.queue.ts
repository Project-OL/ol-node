import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import {
  SUPPORT_AUTOCLOSE_QUEUE,
  SUPPORT_AUTOCLOSE_JOB,
  SUPPORT_AUTOCLOSE_DELAY_MS,
} from './support-autoclose.constants'

export const supportAutocloseQueue = new Queue(SUPPORT_AUTOCLOSE_QUEUE, {
  connection: redisClient,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: 500 },
})

/**
 * Schedule the auto-close for a ticket that just entered PENDING_REVIEW.
 * The worker re-checks status, so a contested (re-opened) ticket makes the
 * job a no-op — no cancellation needed. Deterministic jobId + resolvedAt
 * timestamp so a re-resolve after a contest schedules a fresh job.
 */
export async function enqueueSupportTicketAutoclose(ticketId: bigint, resolvedAt: Date): Promise<void> {
  await supportAutocloseQueue.add(
    SUPPORT_AUTOCLOSE_JOB,
    { ticketId: ticketId.toString(), resolvedAt: resolvedAt.toISOString() },
    {
      jobId: `support-autoclose-${ticketId}-${resolvedAt.getTime()}`,
      delay: SUPPORT_AUTOCLOSE_DELAY_MS,
    },
  )
}
