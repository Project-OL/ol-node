import type { Prisma, ReportReason } from '@prisma/client'
import { prismaRead } from '../config/database'
import { RedisKeys, redisClient } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { userRepository } from '../repositories/user.repository'
import { storageService } from './storage.service'
import { auditService } from './audit.service'
import { formatUserName } from '../utils/user-display'
import type {
  AdminLiveModerationListQuery,
  AdminUserLiveModerationQuery,
} from '../models/admin-live-moderation.schemas'

const NUDITY_REASONS: ReportReason[] = ['INAPPROPRIATE_CONTENT', 'CHILD_SAFETY_VIOLATION']
const ABUSE_REASONS: ReportReason[] = ['HARASSMENT', 'VIOLENCE']
const FAKE_REASONS: ReportReason[] = ['FAKE_ACCOUNT']
const LIVE_VIOLATION_REASONS: ReportReason[] = ['LIVE_BROADCAST_VIOLATION']

const userBriefSelect = {
  id: true,
  publicId: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
} as const

function evidenceUrl(key: string | null | undefined): string | null {
  if (!key) return null
  try {
    return storageService.getCdnOrS3PublicUrl(key)
  } catch {
    return null
  }
}

function mapUserBrief<T extends { firstName?: string | null; lastName?: string | null } | null | undefined>(
  u: T,
) {
  if (u == null) return u
  return { ...u, name: formatUserName(u), publicId: (u as { publicId?: bigint }).publicId?.toString() }
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, jsonValue) =>
      typeof jsonValue === 'bigint' ? jsonValue.toString() : jsonValue,
    ),
  ) as T
}

async function mapLiveNudityLogs(
  logs: Array<{
    id: string
    streamId: string
    detectedLabel: string
    confidence: number
    action: string
    s3Key: string | null
    s3Bucket: string | null
    checkedAt: Date
  }>,
) {
  const streamIds = [...new Set(logs.map((l) => l.streamId))]
  const streams = streamIds.length
    ? await prismaRead.liveStream.findMany({
        where: { id: { in: streamIds } },
        select: {
          id: true,
          streamId: true,
          title: true,
          userId: true,
          startedAt: true,
          endedAt: true,
          isLive: true,
          user: { select: userBriefSelect },
        },
      })
    : []
  const byId = new Map(streams.map((s) => [s.id, s]))
  return logs.map((log) => {
    const stream = byId.get(log.streamId)
    return {
      kind: 'nudity' as const,
      id: log.id,
      streamDbId: log.streamId,
      roomId: stream?.streamId ?? null,
      title: stream?.title ?? null,
      isLive: stream?.isLive ?? false,
      detectedLabel: log.detectedLabel,
      confidence: log.confidence,
      action: log.action,
      evidenceUrl: evidenceUrl(log.s3Key),
      s3Key: log.s3Key,
      checkedAt: log.checkedAt.toISOString(),
      host: mapUserBrief(stream?.user) ?? null,
      hostUserId: stream?.userId ?? null,
    }
  })
}

async function mapVideoCallLogs(
  logs: Array<{
    id: string
    sessionId: string
    detectedLabel: string
    confidence: number
    action: string
    s3Key: string | null
    checkedAt: Date
    session?: {
      id: string
      callerId: string
      creatorId: string
      livekitRoom: string
      status: string
      startedAt: Date
      endedAt: Date | null
      caller: {
        id: string
        publicId: bigint
        username: string | null
        firstName: string | null
        lastName: string | null
        avatarUrl: string | null
      }
      creator: {
        id: string
        publicId: bigint
        username: string | null
        firstName: string | null
        lastName: string | null
        avatarUrl: string | null
      }
    }
  }>,
) {
  return logs.map((log) => ({
    kind: 'video_call' as const,
    id: log.id,
    sessionId: log.sessionId,
    livekitRoom: log.session?.livekitRoom ?? null,
    sessionStatus: log.session?.status ?? null,
    detectedLabel: log.detectedLabel,
    confidence: log.confidence,
    action: log.action,
    evidenceUrl: evidenceUrl(log.s3Key),
    checkedAt: log.checkedAt.toISOString(),
    caller: mapUserBrief(log.session?.caller) ?? null,
    creator: mapUserBrief(log.session?.creator) ?? null,
  }))
}

function mapHostBan(row: {
  id: string
  userId: string
  streamId: string
  banNumber: number
  banDuration: number
  suspendedUntil: Date
  createdAt: Date
}) {
  return {
    kind: 'host_ban' as const,
    id: row.id,
    userId: row.userId,
    streamId: row.streamId,
    banNumber: row.banNumber,
    banDurationHours: row.banDuration,
    suspendedUntil: row.suspendedUntil.toISOString(),
    createdAt: row.createdAt.toISOString(),
    active: row.suspendedUntil > new Date(),
  }
}

function mapUserReport(row: {
  id: string
  reason: ReportReason
  context: string
  status: string
  additionalInfo: string | null
  evidenceS3Keys: string[]
  liveSessionId: string | null
  hostUserId: string | null
  createdAt: Date
  reporter?: Parameters<typeof mapUserBrief>[0]
  reportedUser?: Parameters<typeof mapUserBrief>[0]
  hostUser?: Parameters<typeof mapUserBrief>[0]
}) {
  return {
    kind: 'user_report' as const,
    id: row.id,
    reason: row.reason,
    context: row.context,
    status: row.status,
    additionalInfo: row.additionalInfo,
    liveSessionId: row.liveSessionId,
    hostUserId: row.hostUserId,
    evidenceUrls: row.evidenceS3Keys.map((k) => evidenceUrl(k)).filter((u): u is string => Boolean(u)),
    createdAt: row.createdAt.toISOString(),
    reporter: mapUserBrief(row.reporter) ?? null,
    reportedUser: mapUserBrief(row.reportedUser) ?? null,
    hostUser: mapUserBrief(row.hostUser) ?? null,
  }
}

export const adminLiveModerationService = {
  async getUserDossier(userId: string, query: AdminUserLiveModerationQuery) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const skip = (query.page - 1) * query.limit
    const take = query.limit
    const now = new Date()

    const hostedStreams = await prismaRead.liveStream.findMany({
      where: { userId },
      select: { id: true },
    })
    const hostedStreamIds = hostedStreams.map((s) => s.id)

    const [
      liveLogs,
      liveLogTotal,
      hostBans,
      hostBanTotal,
      videoLogs,
      videoLogTotal,
      reportsAsReported,
      reportTotal,
      summaryCounts,
    ] = await Promise.all([
      hostedStreamIds.length
        ? prismaRead.liveStreamModerationLog.findMany({
            where: { streamId: { in: hostedStreamIds } },
            orderBy: { checkedAt: 'desc' },
            skip,
            take,
          })
        : Promise.resolve([]),
      hostedStreamIds.length
        ? prismaRead.liveStreamModerationLog.count({ where: { streamId: { in: hostedStreamIds } } })
        : Promise.resolve(0),
      prismaRead.hostStreamBan.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prismaRead.hostStreamBan.count({ where: { userId } }),
      prismaRead.videoCallModerationLog.findMany({
        where: {
          session: { OR: [{ callerId: userId }, { creatorId: userId }] },
        },
        include: {
          session: {
            select: {
              id: true,
              callerId: true,
              creatorId: true,
              livekitRoom: true,
              status: true,
              startedAt: true,
              endedAt: true,
              caller: { select: userBriefSelect },
              creator: { select: userBriefSelect },
            },
          },
        },
        orderBy: { checkedAt: 'desc' },
        skip,
        take,
      }),
      prismaRead.videoCallModerationLog.count({
        where: { session: { OR: [{ callerId: userId }, { creatorId: userId }] } },
      }),
      prismaRead.messageReport.findMany({
        where: { OR: [{ reportedUserId: userId }, { hostUserId: userId }] },
        include: {
          reporter: { select: userBriefSelect },
          reportedUser: { select: userBriefSelect },
          hostUser: { select: userBriefSelect },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prismaRead.messageReport.count({
        where: { OR: [{ reportedUserId: userId }, { hostUserId: userId }] },
      }),
      prismaRead.messageReport.groupBy({
        by: ['reason', 'context'],
        where: { OR: [{ reportedUserId: userId }, { hostUserId: userId }] },
        _count: { _all: true },
      }),
    ])

    let nudityReports = 0
    let abuseReports = 0
    let fakeStreaming = 0
    let liveBroadcast = 0
    for (const row of summaryCounts) {
      const n = row._count._all
      if (NUDITY_REASONS.includes(row.reason)) nudityReports += n
      if (ABUSE_REASONS.includes(row.reason)) abuseReports += n
      if (FAKE_REASONS.includes(row.reason) && row.context === 'LIVE') fakeStreaming += n
      if (LIVE_VIOLATION_REASONS.includes(row.reason)) liveBroadcast += n
    }

    const accountStatus = user.status
    const suspendedUntil = user.suspendedUntil
    const hostStreamSuspended =
      accountStatus === 'active' && suspendedUntil != null && suspendedUntil > now

    return toJsonSafe({
      userId,
      hostStreamSuspendedUntil: hostStreamSuspended ? suspendedUntil.toISOString() : null,
      accountStatus,
      summary: {
        nudity: liveLogTotal + nudityReports,
        liveNudityDetections: liveLogTotal,
        videoCallNudity: videoLogTotal,
        abuse: abuseReports,
        fakeStreaming,
        liveBroadcast,
        hostBans: hostBanTotal,
        userReports: reportTotal,
      },
      liveNudityLogs: await mapLiveNudityLogs(liveLogs),
      liveNudityPagination: {
        page: query.page,
        limit: query.limit,
        total: liveLogTotal,
        hasMore: skip + liveLogs.length < liveLogTotal,
      },
      videoCallLogs: await mapVideoCallLogs(videoLogs),
      videoCallPagination: {
        page: query.page,
        limit: query.limit,
        total: videoLogTotal,
        hasMore: skip + videoLogs.length < videoLogTotal,
      },
      hostBans: hostBans.map(mapHostBan),
      hostBanPagination: {
        page: query.page,
        limit: query.limit,
        total: hostBanTotal,
        hasMore: skip + hostBans.length < hostBanTotal,
      },
      userReports: reportsAsReported.map(mapUserReport),
      userReportPagination: {
        page: query.page,
        limit: query.limit,
        total: reportTotal,
        hasMore: skip + reportsAsReported.length < reportTotal,
      },
    })
  },

  async listGlobal(query: AdminLiveModerationListQuery) {
    const skip = (query.page - 1) * query.limit
    const take = query.limit
    const kind = query.kind ?? 'nudity'
    const userId = query.userId

    if (kind === 'nudity') {
      const streamFilter: Prisma.LiveStreamModerationLogWhereInput = userId
        ? { streamId: { in: (await prismaRead.liveStream.findMany({ where: { userId }, select: { id: true } })).map((s) => s.id) } }
        : {}
      const [rows, total] = await Promise.all([
        prismaRead.liveStreamModerationLog.findMany({
          where: streamFilter,
          orderBy: { checkedAt: 'desc' },
          skip,
          take,
        }),
        prismaRead.liveStreamModerationLog.count({ where: streamFilter }),
      ])
      return toJsonSafe({
        kind,
        items: await mapLiveNudityLogs(rows),
        pagination: { page: query.page, limit: query.limit, total, hasMore: skip + rows.length < total },
      })
    }

    if (kind === 'video_call') {
      const where: Prisma.VideoCallModerationLogWhereInput = userId
        ? { session: { OR: [{ callerId: userId }, { creatorId: userId }] } }
        : {}
      const [rows, total] = await Promise.all([
        prismaRead.videoCallModerationLog.findMany({
          where,
          include: {
            session: {
              select: {
                id: true,
                callerId: true,
                creatorId: true,
                livekitRoom: true,
                status: true,
                startedAt: true,
                endedAt: true,
                caller: { select: userBriefSelect },
                creator: { select: userBriefSelect },
              },
            },
          },
          orderBy: { checkedAt: 'desc' },
          skip,
          take,
        }),
        prismaRead.videoCallModerationLog.count({ where }),
      ])
      return toJsonSafe({
        kind,
        items: await mapVideoCallLogs(rows),
        pagination: { page: query.page, limit: query.limit, total, hasMore: skip + rows.length < total },
      })
    }

    if (kind === 'host_ban') {
      const where = userId ? { userId } : {}
      const [rows, total] = await Promise.all([
        prismaRead.hostStreamBan.findMany({
          where,
          include: { user: { select: userBriefSelect } },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        prismaRead.hostStreamBan.count({ where }),
      ])
      return toJsonSafe({
        kind,
        items: rows.map((r) => ({
          ...mapHostBan(r),
          user: mapUserBrief(r.user),
        })),
        pagination: { page: query.page, limit: query.limit, total, hasMore: skip + rows.length < total },
      })
    }

    const where: Prisma.MessageReportWhereInput = {
      AND: [
        userId ? { OR: [{ reportedUserId: userId }, { hostUserId: userId }] } : {},
        {
          OR: [
            { context: 'LIVE' },
            { reason: { in: [...NUDITY_REASONS, ...LIVE_VIOLATION_REASONS, ...FAKE_REASONS] } },
          ],
        },
      ],
    }
    const [rows, total] = await Promise.all([
      prismaRead.messageReport.findMany({
        where,
        include: {
          reporter: { select: userBriefSelect },
          reportedUser: { select: userBriefSelect },
          hostUser: { select: userBriefSelect },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prismaRead.messageReport.count({ where }),
    ])
    return toJsonSafe({
      kind,
      items: rows.map(mapUserReport),
      pagination: { page: query.page, limit: query.limit, total, hasMore: skip + rows.length < total },
    })
  },

  async clearHostStreamSuspension(params: { userId: string; adminUserId: string }) {
    const user = await userRepository.findById(params.userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    if (user.status !== 'active') {
      throw new AppError(
        409,
        'Account is not active; clear account suspension from user status instead',
        'ACCOUNT_NOT_ACTIVE',
      )
    }

    await userRepository.update(params.userId, { suspendedUntil: null })
    await redisClient.del(RedisKeys.liveUserSuspended(params.userId))

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_HOST_STREAM_SUSPENSION_CLEARED',
      actionStatus: 'success',
      actionDetails: { targetUserId: params.userId },
    })

    return {
      ok: true as const,
      userId: params.userId,
      hostStreamSuspendedUntil: null,
    }
  },
}
