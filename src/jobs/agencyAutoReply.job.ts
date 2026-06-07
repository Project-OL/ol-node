import type { Job } from 'bullmq'
import { prismaRead } from '../config/database'
import { messagingService } from '../services/messaging.service'
import type { AutoReplyJobData } from '../queues/agencyAutoReply.queue'
import { rootLogger } from '../utils/rootLogger'
import { randomUUID } from 'crypto'

const log = rootLogger.child({ module: 'agency-auto-reply' })

export async function processAgencyAutoReplyJob(job: Job<AutoReplyJobData>): Promise<void> {
  const { conversationId, agencyUserId, autoReplyText, triggerMessageSeq } = job.data

  const existing = await prismaRead.message.findFirst({
    where: {
      conversationId,
      senderId: agencyUserId,
      isAutoReply: true,
      seq: { gte: BigInt(triggerMessageSeq) },
    },
    select: { id: true },
  })
  if (existing) {
    log.info({ jobId: job.id }, 'auto-reply already sent, skipping')
    return
  }

  await messagingService.sendAutoReply({
    conversationId,
    senderUserId: agencyUserId,
    content: autoReplyText,
    clientMessageId: randomUUID(),
  })

  log.info({ conversationId, agencyUserId, seq: triggerMessageSeq }, 'auto-reply sent')
}
