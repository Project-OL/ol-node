import type { Job } from 'bullmq'
import { prismaRead } from '../config/database'
import { transactionalMessagingService } from '../services/transactionalMessaging.service'
import { platformMessagingService } from '../services/platformMessaging.service'
import { auditService } from '../services/audit.service'
import { randomUUID } from 'crypto'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'platform-message-job' })

export type PlatformLedgerMessageJobData = {
  kind: 'coin' | 'point'
  entryId: string
}

export type PlatformWithdrawalMessageJobData = {
  withdrawalId: string
  event: string
  hostUserId: string
  agentUserId?: string
  reason?: string
}

export type PlatformNotificationBroadcastJobData = {
  adminUserId: string
  message: string
  userIds?: string[]
  campaignId?: string
}

export async function processPlatformLedgerMessageJob(
  job: Job<PlatformLedgerMessageJobData>,
): Promise<void> {
  const { kind, entryId } = job.data
  if (kind === 'coin') {
    await transactionalMessagingService.sendFromCoinLedgerEntry(entryId)
  } else {
    await transactionalMessagingService.sendFromPointLedgerEntry(entryId)
  }
}

export async function processPlatformWithdrawalMessageJob(
  job: Job<PlatformWithdrawalMessageJobData>,
): Promise<void> {
  await transactionalMessagingService.sendWithdrawalEvent(job.data)
}

export async function processPlatformNotificationBroadcastJob(
  job: Job<PlatformNotificationBroadcastJobData>,
): Promise<void> {
  const campaignId = job.data.campaignId ?? `broadcast:${randomUUID()}`
  const userIds =
    job.data.userIds ??
    (
      await prismaRead.user.findMany({
        where: { status: 'active', isSupport: false },
        select: { id: true },
        take: 50_000,
      })
    ).map((u) => u.id)

  let sent = 0
  for (const userId of userIds) {
    const metadata: PlatformMessageMetadata = {
      category: 'notification',
      campaignId,
      adminUserId: job.data.adminUserId,
    }
    const result = await platformMessagingService.sendPlatformMessage({
      targetUserId: userId,
      type: 'NOTIFICATION',
      content: job.data.message,
      metadata,
      clientMessageId: `notify:${campaignId}:${userId}`,
    })
    if (result.created) sent += 1
  }

  auditService.log({
    userId: job.data.adminUserId,
    actionType: 'ADMIN_NOTIFICATION_BROADCAST',
    actionStatus: 'success',
    actionDetails: { campaignId, recipientCount: userIds.length, sent },
  })

  log.info({ campaignId, sent, total: userIds.length }, 'notification broadcast complete')
}
