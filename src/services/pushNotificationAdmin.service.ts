import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { pushNotificationService } from './pushNotification.service'
import { enqueuePushBroadcast } from '../queues/push-notification.queue'

export const pushNotificationAdminService = {
  async sendToUser(params: {
    adminUserId: string
    targetUserId: string
    title: string
    body: string
    data?: Record<string, string>
  }): Promise<{ success: boolean }> {
    const target = await prismaRead.user.findUnique({
      where: { id: params.targetUserId },
      select: { fcmToken: true },
    })
    if (!target?.fcmToken) {
      throw new AppError(404, 'User has no registered push token', 'NO_PUSH_TOKEN')
    }
    const result = await pushNotificationService.sendToToken(params.targetUserId, target.fcmToken, {
      title: params.title,
      body: params.body,
      data: params.data,
    })
    if (!result.success) {
      throw new AppError(502, 'Push send failed', 'PUSH_SEND_FAILED', { reason: result.error })
    }
    return { success: true }
  },

  async broadcast(params: {
    adminUserId: string
    title: string
    body: string
    data?: Record<string, string>
    userIds?: string[]
    country?: string
    campaignId?: string
  }): Promise<{ ok: true; queued: true; campaignId: string }> {
    const campaignId = await enqueuePushBroadcast(params)
    return { ok: true, queued: true, campaignId }
  },
}
