import type { Job } from 'bullmq'
import { prismaRead } from '../config/database'
import { messagingService, buildAutoReplyClientMessageId } from '../services/messaging.service'
import type { AutoReplyJobData } from '../queues/agencyAutoReply.queue'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'agency-auto-reply' })

export async function processAgencyAutoReplyJob(job: Job<AutoReplyJobData>): Promise<void> {
  const { conversationId, agencyUserId, autoReplyText, triggerMessageSeq } = job.data
  const clientMessageId = buildAutoReplyClientMessageId(conversationId, triggerMessageSeq)

  const existing = await prismaRead.message.findFirst({
    where: {
      conversationId,
      clientMessageId,
    },
    select: { id: true },
  })
  if (existing) {
    log.info({ jobId: job.id, clientMessageId }, 'auto-reply already sent, skipping')
    return
  }

  await messagingService.sendAutoReply({
    conversationId,
    senderUserId: agencyUserId,
    content: autoReplyText,
    clientMessageId,
  })

  log.info({ conversationId, agencyUserId, seq: triggerMessageSeq }, 'auto-reply sent')
}