import { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'
import type { ListPushUsersQuery, ListPushDeliveriesQuery } from '../models/push-notification.schemas'
import { pushNotificationService } from './pushNotification.service'
import { pushDeliveryLogService } from './pushDeliveryLog.service'
import { enqueuePushBroadcast } from '../queues/push-notification.queue'

export type PushEligibleUser = {
  userId: string
  username: string
  name: string
  publicId: string
  displayPublicId: string
  avatarUrl: string | null
  country: string | null
  status: string
  hasFcmToken: true
  fcmTokenUpdatedAt: string | null
}

export const pushNotificationAdminService = {
  async listUsersWithFcmToken(
    query: ListPushUsersQuery,
  ): Promise<{
    users: PushEligibleUser[]
    pagination: { page: number; limit: number; total: number; hasMore: boolean }
  }> {
    const where: Prisma.UserWhereInput = {
      fcmToken: { not: null },
      ...(query.activeOnly
        ? { status: 'active', isSupport: false }
        : {}),
      ...(query.country
        ? { country: { equals: query.country, mode: 'insensitive' } }
        : {}),
    }

    if (query.q) {
      const q = query.q.trim()
      const or: Prisma.UserWhereInput[] = [
        { username: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
      ]
      if (/^\d+$/.test(q)) {
        try {
          or.push({ publicId: BigInt(q) })
        } catch {
          /* ignore invalid bigint */
        }
      }
      where.OR = or
    }

    const skip = (query.page - 1) * query.limit
    const [total, rows] = await Promise.all([
      prismaRead.user.count({ where }),
      prismaRead.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          publicId: true,
          defaultPublicId: true,
          currentVipPublicId: true,
          avatarUrl: true,
          country: true,
          status: true,
          fcmTokenUpdatedAt: true,
        },
        orderBy: [{ fcmTokenUpdatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take: query.limit,
      }),
    ])

    const users: PushEligibleUser[] = rows.map((u) => ({
      userId: u.id,
      username: u.username,
      name: buildUserDisplayName(u),
      publicId: u.publicId.toString(),
      displayPublicId: resolveDisplayPublicId(u),
      avatarUrl: u.avatarUrl,
      country: u.country,
      status: u.status,
      hasFcmToken: true as const,
      fcmTokenUpdatedAt: u.fcmTokenUpdatedAt?.toISOString() ?? null,
    }))

    return {
      users,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasMore: skip + users.length < total,
      },
    }
  },

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
      await pushDeliveryLogService.record({
        userId: params.targetUserId,
        adminUserId: params.adminUserId,
        source: 'ADMIN_SINGLE',
        status: 'SKIPPED',
        title: params.title,
        body: params.body,
        data: params.data,
        errorCode: 'NO_PUSH_TOKEN',
      })
      throw new AppError(404, 'User has no registered push token', 'NO_PUSH_TOKEN')
    }
    const result = await pushNotificationService.sendToToken(
      params.targetUserId,
      target.fcmToken,
      {
        title: params.title,
        body: params.body,
        data: params.data,
      },
      {
        source: 'ADMIN_SINGLE',
        adminUserId: params.adminUserId,
      },
    )
    if (!result.success) {
      if (
        result.error === 'FIREBASE_NOT_CONFIGURED' ||
        result.error === 'FIREBASE_PRIVATE_KEY_INVALID'
      ) {
        throw new AppError(
          503,
          result.errorMessage ?? 'Firebase not configured',
          result.error,
          { reason: result.error, message: result.errorMessage },
        )
      }
      throw new AppError(502, 'Push send failed', 'PUSH_SEND_FAILED', {
        reason: result.error,
        message: result.errorMessage,
      })
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

  getTodayStats() {
    return pushDeliveryLogService.getTodayStats()
  },

  listDeliveries(query: ListPushDeliveriesQuery) {
    return pushDeliveryLogService.listDeliveries({
      page: query.page,
      limit: query.limit,
      status: query.status,
      source: query.source,
      todayOnly: query.todayOnly,
      campaignId: query.campaignId,
    })
  },
}
