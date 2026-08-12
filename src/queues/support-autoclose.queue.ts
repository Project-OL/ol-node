import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { SUPPORT_AUTOCLOSE_QUEUE, SUPPORT_AUTOCLOSE_JOB } from './support-autoclose.constants'
import { supportConfigService } from '../services/supportConfig.service'

export const supportAutocloseQueue = new Queue(SUPPORT_AUTOCLOSE_QUEUE, {
  connection: redisClient,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: 500 },
})

/**
 * Schedule the auto-close for a ticket that just entered PENDING_REVIEW.
 * Delay reads the admin-configured contest window (`support_config.review_window_ms`).
 */
export async function enqueueSupportTicketAutoclose(
  ticketId: bigint,
  resolvedAt: Date,
): Promise<void> {
  const delayMs = await supportConfigService.getReviewWindowMs()
  await supportAutocloseQueue.add(
    SUPPORT_AUTOCLOSE_JOB,
    { ticketId: ticketId.toString(), resolvedAt: resolvedAt.toISOString() },
    {
      jobId: `support-autoclose-${ticketId}-${resolvedAt.getTime()}`,
      delay: delayMs,
    },
  )
}
