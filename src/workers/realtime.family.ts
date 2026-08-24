import type Redis from 'ioredis'
import { Worker, type Job } from 'bullmq'
import { env } from '../config/env'
import { AGENCY_AUTO_REPLY_JOB, AGENCY_AUTO_REPLY_QUEUE } from '../queues/agencyAutoReply.constants'
import { processAgencyAutoReplyJob } from '../jobs/agencyAutoReply.job'
import { agencyAutoReplyQueue, type AutoReplyJobData } from '../queues/agencyAutoReply.queue'
import {
  PLATFORM_BROADCAST_SWEEP_JOB,
  PLATFORM_LEDGER_MESSAGE_JOB,
  PLATFORM_MESSAGE_QUEUE,
  PLATFORM_NOTIFICATION_BROADCAST_BATCH_JOB,
  PLATFORM_NOTIFICATION_BROADCAST_JOB,
  PLATFORM_WITHDRAWAL_MESSAGE_JOB,
} from '../queues/platform-message.constants'
import {
  platformMessageQueue,
  registerPlatformBroadcastSweep,
} from '../queues/platform-message.queue'
import {
  processPlatformLedgerMessageJob,
  processPlatformNotificationBroadcastBatchJob,
  processPlatformNotificationBroadcastJob,
  processPlatformWithdrawalMessageJob,
  sweepStalePlatformBroadcasts,
  type PlatformNotificationBroadcastBatchJobData,
} from '../jobs/platform-message.job'
import {
  PUSH_BROADCAST_BATCH_JOB,
  PUSH_BROADCAST_JOB,
  PUSH_BROADCAST_SWEEP_JOB,
  PUSH_NOTIFICATION_QUEUE,
} from '../queues/push-notification.constants'
import {
  pushNotificationQueue,
  registerPushBroadcastSweep,
} from '../queues/push-notification.queue'
import {
  processPushBroadcastBatchJob,
  processPushBroadcastJob,
  sweepStalePushBroadcasts,
  type PushBroadcastBatchJobData,
  type PushBroadcastJobData,
} from '../jobs/push-notification.job'
import {
  MESSAGE_OUTBOX_PUBLISH_JOB,
  MESSAGE_OUTBOX_QUEUE,
  MESSAGE_OUTBOX_SWEEP_JOB,
  READ_RECEIPT_SWEEP_JOB,
} from '../queues/messaging.constants'
import {
  messageOutboxQueue,
  registerMessageOutboxScheduledJobs,
  registerReadReceiptSweep,
} from '../queues/messaging.queue'
import {
  MESSAGE_MEDIA_AUDIO_PROCESS_JOB,
  MESSAGE_MEDIA_AUDIO_QUEUE,
} from '../queues/message-media-audio.constants'
import { messageMediaAudioQueue } from '../queues/message-media-audio.queue'
import { processMessageMediaAudioJob } from '../jobs/message-media-audio-processing.job'
import {
  publishMessageOutboxRow,
  sweepStaleMessageOutbox,
} from '../services/messaging-outbox.service'
import { sweepStaleReadReceipts } from '../services/messaging.service'
import type { WorkerFamily } from './family'

/**
 * Chat / push / inbox workers. Scale this process independently of payroll.
 */
export async function startRealtimeWorkerFamily(connection: Redis): Promise<WorkerFamily> {
  await registerMessageOutboxScheduledJobs()
  await registerReadReceiptSweep()
  await registerPlatformBroadcastSweep()
  await registerPushBroadcastSweep()

  const autoReplyWorker = new Worker(
    AGENCY_AUTO_REPLY_QUEUE,
    async (job: Job<AutoReplyJobData>) => {
      if (job.name === AGENCY_AUTO_REPLY_JOB) {
        await processAgencyAutoReplyJob(job)
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_AGENCY_AUTO_REPLY },
  )

  const platformMessageWorker = new Worker(
    PLATFORM_MESSAGE_QUEUE,
    async (job: Job) => {
      if (job.name === PLATFORM_LEDGER_MESSAGE_JOB) {
        await processPlatformLedgerMessageJob(
          job as Job<{ kind: 'coin' | 'point'; entryId: string }>,
        )
      } else if (job.name === PLATFORM_WITHDRAWAL_MESSAGE_JOB) {
        await processPlatformWithdrawalMessageJob(
          job as Job<{
            withdrawalId: string
            event: string
            hostUserId: string
            agentUserId?: string
            reason?: string
          }>,
        )
      } else if (job.name === PLATFORM_NOTIFICATION_BROADCAST_JOB) {
        await processPlatformNotificationBroadcastJob(
          job as Job<{
            adminUserId: string
            message: string
            userIds?: string[]
            campaignId?: string
          }>,
        )
      } else if (job.name === PLATFORM_NOTIFICATION_BROADCAST_BATCH_JOB) {
        await processPlatformNotificationBroadcastBatchJob(
          job as Job<PlatformNotificationBroadcastBatchJobData>,
        )
      } else if (job.name === PLATFORM_BROADCAST_SWEEP_JOB) {
        await sweepStalePlatformBroadcasts()
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_PLATFORM_MESSAGE },
  )

  const pushNotificationWorker = new Worker(
    PUSH_NOTIFICATION_QUEUE,
    async (job: Job) => {
      if (job.name === PUSH_BROADCAST_JOB) {
        await processPushBroadcastJob(job as Job<PushBroadcastJobData>)
      } else if (job.name === PUSH_BROADCAST_BATCH_JOB) {
        await processPushBroadcastBatchJob(job as Job<PushBroadcastBatchJobData>)
      } else if (job.name === PUSH_BROADCAST_SWEEP_JOB) {
        await sweepStalePushBroadcasts()
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_PUSH },
  )

  const messageOutboxWorker = new Worker(
    MESSAGE_OUTBOX_QUEUE,
    async (job: Job<{ outboxId?: string }>) => {
      if (job.name === MESSAGE_OUTBOX_PUBLISH_JOB) {
        const id = job.data?.outboxId
        if (id) await publishMessageOutboxRow(BigInt(id))
      } else if (job.name === MESSAGE_OUTBOX_SWEEP_JOB) {
        await sweepStaleMessageOutbox()
      } else if (job.name === READ_RECEIPT_SWEEP_JOB) {
        await sweepStaleReadReceipts()
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_OUTBOX },
  )

  const messageMediaAudioWorker = new Worker(
    MESSAGE_MEDIA_AUDIO_QUEUE,
    async (job: Job<{ messageMediaId?: string }>) => {
      if (job.name === MESSAGE_MEDIA_AUDIO_PROCESS_JOB && job.data?.messageMediaId) {
        await processMessageMediaAudioJob(job.data.messageMediaId)
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_MESSAGE_MEDIA },
  )

  autoReplyWorker.on('failed', (job, err) => {
    console.error('[Agency auto-reply] Job failed:', job?.id, err)
  })
  messageOutboxWorker.on('failed', (job, err) => {
    console.error('[Message outbox] Job failed:', job?.id, err)
  })
  messageMediaAudioWorker.on('failed', (job, err) => {
    console.error('[Message media audio] Job failed:', job?.id, err)
  })
  pushNotificationWorker.on('failed', (job, err) => {
    console.error('[Push notification] Job failed:', job?.id, err)
  })
  platformMessageWorker.on('failed', (job, err) => {
    console.error('[Platform message] Job failed:', job?.id, err)
  })

  return {
    name: 'realtime',
    close: async () => {
      await pushNotificationWorker.close()
      await pushNotificationQueue.close()
      await messageMediaAudioWorker.close()
      await messageMediaAudioQueue.close()
      await autoReplyWorker.close()
      await agencyAutoReplyQueue.close()
      await platformMessageWorker.close()
      await platformMessageQueue.close()
      await messageOutboxWorker.close()
      await messageOutboxQueue.close()
    },
  }
}
