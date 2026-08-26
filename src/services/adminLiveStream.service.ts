import { EgressClient, RoomServiceClient } from 'livekit-server-sdk'
import { RedisKeys, redisClient } from '../config/redis'
import { prisma, prismaRead } from '../config/database'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import { userRepository } from '../repositories/user.repository'
import { rootLogger } from '../utils/rootLogger'
import { auditService } from './audit.service'
import { liveSessionService } from './liveSession.service'
import { formatUserName } from '../utils/user-display'
import {
  computeEffectiveDurationSeconds,
  readUncountedLiveSeconds,
} from '../utils/live-stream-effective-duration'

const hostBriefSelect = {
  id: true,
  publicId: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
} as const

function mapHostBrief(u: {
  id: string
  publicId: bigint
  username: string | null
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
}) {
  return {
    ...u,
    name: formatUserName(u),
    publicId: u.publicId?.toString(),
  }
}

export type AdminLiveStreamRow = {
  source: 'host_live_session' | 'live_stream'
  id: string
  roomId: string
  streamId: string | null
  title: string | null
  status: string
  startedAt: string | null
  isLive: boolean
}

/** Redis keys owned by the livestream process (shared Redis). Cleared here so we do not need Live-server changes. */
function liveRoomRedisKeys(roomId: string, dbId: string | null, hostUserId: string): string[] {
  return [
    `user:active_stream:${hostUserId}`,
    `stream:info:${roomId}`,
    ...(dbId ? [`stream:info:${dbId}`] : []),
    `stream:camera_off_at:${roomId}`,
    `stream:uncounted_seconds:${roomId}`,
    `stream:active:${roomId}`,
    `stream:history:${roomId}`,
    `stream:chats:${roomId}`,
    `stream:admins:${roomId}`,
    `stream:kicked:${roomId}`,
    `stream:password:${roomId}`,
    `stream:sheet:${roomId}`,
    `stream:mic_permission:${roomId}`,
    `stream:chat_permission:${roomId}`,
    `stream:chat_cleared:${roomId}`,
  ]
}

async function delByPattern(pattern: string): Promise<void> {
  let cursor = '0'
  do {
    const [next, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 80)
    cursor = next
    if (keys.length) await redisClient.del(...keys)
  } while (cursor !== '0')
}

async function persistLiveChats(roomId: string): Promise<void> {
  const raw = await redisClient.lrange(`stream:chats:${roomId}`, 0, -1)
  if (!raw.length) return
  const rows = []
  for (const c of raw) {
    try {
      const parsed = JSON.parse(c) as {
        id?: string
        streamId?: string
        senderId?: string
        message?: string
        createdAt?: string
        replyToMessageId?: string | null
        replyToUserId?: string | null
        replyToUsername?: string | null
        replyToText?: string | null
      }
      if (!parsed.id || !parsed.senderId || parsed.message == null) continue
      rows.push({
        id: parsed.id,
        streamId: parsed.streamId ?? roomId,
        senderId: parsed.senderId,
        message: parsed.message,
        createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
        replyToMessageId: parsed.replyToMessageId ?? null,
        replyToUserId: parsed.replyToUserId ?? null,
        replyToUsername: parsed.replyToUsername ?? null,
        replyToText: parsed.replyToText ?? null,
      })
    } catch {
      /* skip malformed */
    }
  }
  if (!rows.length) return
  await prisma.liveMessage.createMany({ data: rows, skipDuplicates: true })
}

async function tryDeleteLivekitRoom(roomName: string): Promise<boolean> {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return false
  try {
    const client = new RoomServiceClient(
      env.LIVEKIT_URL,
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    )
    await client.deleteRoom(roomName)
    return true
  } catch (err) {
    rootLogger.warn(
      { err, roomName },
      'admin live stop: LiveKit deleteRoom failed (room may already be gone)',
    )
    return false
  }
}

async function tryStopEgress(playbackId: string | null | undefined): Promise<void> {
  if (!playbackId || !env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return
  try {
    const egress = new EgressClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
    await egress.stopEgress(playbackId)
  } catch (err) {
    rootLogger.warn({ err, playbackId }, 'admin live stop: stopEgress failed')
  }
}

/**
 * Admin live-stream listing + stop.
 *
 * Stop is fully handled in ol-node-rest (shared Postgres + Redis + LiveKit).
 * Live-server does not need a subscriber: deleteRoom disconnects host/viewers,
 * and livestream Redis keys are cleared so the host is not stuck "already live".
 */
export const adminLiveStreamService = {
  async listActiveForUser(
    userId: string,
  ): Promise<{ userId: string; streams: AdminLiveStreamRow[] }> {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const [hostSessions, liveStreams, redisActive] = await Promise.all([
      prismaRead.hostLiveSession.findMany({
        where: { hostUserId: userId, status: 'ACTIVE' },
        orderBy: { startedAt: 'desc' },
      }),
      prismaRead.liveStream.findMany({
        where: { userId, isLive: true },
        orderBy: { startedAt: 'desc' },
      }),
      redisClient.get(RedisKeys.liveActiveSession(userId)),
    ])

    const streams: AdminLiveStreamRow[] = []
    const seenRoomIds = new Set<string>()

    for (const s of hostSessions) {
      seenRoomIds.add(s.roomId)
      streams.push({
        source: 'host_live_session',
        id: s.id,
        roomId: s.roomId,
        streamId: s.roomId,
        title: null,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        isLive: true,
      })
    }

    for (const s of liveStreams) {
      if (seenRoomIds.has(s.streamId)) continue
      seenRoomIds.add(s.streamId)
      streams.push({
        source: 'live_stream',
        id: s.id,
        roomId: s.streamId,
        streamId: s.streamId,
        title: s.title,
        status: s.isLive ? 'LIVE' : 'ENDED',
        startedAt: s.startedAt?.toISOString() ?? null,
        isLive: s.isLive,
      })
    }

    if (redisActive) {
      try {
        const meta = JSON.parse(redisActive) as {
          sessionId?: string
          roomId?: string
          startedAt?: string
        }
        const roomId = meta.roomId
        if (roomId && !seenRoomIds.has(roomId)) {
          streams.push({
            source: 'host_live_session',
            id: meta.sessionId ?? roomId,
            roomId,
            streamId: roomId,
            title: null,
            status: 'ACTIVE',
            startedAt: meta.startedAt ?? null,
            isLive: true,
          })
        }
      } catch {
        /* ignore malformed redis */
      }
    }

    return { userId, streams }
  },

  async listActiveGlobal(query: { page: number; limit: number; hostUserId?: string }) {
    const skip = (query.page - 1) * query.limit
    const take = query.limit
    const liveWhere = {
      isLive: true,
      ...(query.hostUserId ? { userId: query.hostUserId } : {}),
    }
    const sessionWhere = {
      status: 'ACTIVE' as const,
      ...(query.hostUserId ? { hostUserId: query.hostUserId } : {}),
    }

    const [liveStreams, liveTotal, hostSessions] = await Promise.all([
      prismaRead.liveStream.findMany({
        where: liveWhere,
        include: { user: { select: hostBriefSelect } },
        orderBy: { startedAt: 'desc' },
        skip,
        take,
      }),
      prismaRead.liveStream.count({ where: liveWhere }),
      prismaRead.hostLiveSession.findMany({
        where: sessionWhere,
        include: { host: { select: hostBriefSelect } },
        orderBy: { startedAt: 'desc' },
        take: 100,
      }),
    ])

    const seenRoomIds = new Set(liveStreams.map((s) => s.streamId))
    const items: Array<
      AdminLiveStreamRow & {
        hostUserId: string
        host: ReturnType<typeof mapHostBrief>
      }
    > = liveStreams.map((s) => ({
      source: 'live_stream' as const,
      id: s.id,
      roomId: s.streamId,
      streamId: s.streamId,
      title: s.title,
      status: 'LIVE',
      startedAt: s.startedAt?.toISOString() ?? null,
      isLive: true,
      hostUserId: s.userId,
      host: mapHostBrief(s.user),
    }))

    if (query.page === 1) {
      for (const s of hostSessions) {
        if (seenRoomIds.has(s.roomId)) continue
        seenRoomIds.add(s.roomId)
        items.push({
          source: 'host_live_session',
          id: s.id,
          roomId: s.roomId,
          streamId: s.roomId,
          title: null,
          status: s.status,
          startedAt: s.startedAt.toISOString(),
          isLive: true,
          hostUserId: s.hostUserId,
          host: mapHostBrief(s.host),
        })
      }
    }

    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: liveTotal,
        hasMore: skip + liveStreams.length < liveTotal,
      },
    }
  },

  async requestStopByRef(params: { streamRef: string; adminUserId: string; reason?: string }) {
    const hostSession = await prismaRead.hostLiveSession.findFirst({
      where: {
        status: 'ACTIVE',
        OR: [{ id: params.streamRef }, { roomId: params.streamRef }],
      },
    })
    const liveStream = await prismaRead.liveStream.findFirst({
      where: {
        isLive: true,
        OR: [{ id: params.streamRef }, { streamId: params.streamRef }],
      },
      orderBy: { startedAt: 'desc' },
    })
    const userId = hostSession?.hostUserId ?? liveStream?.userId
    if (!userId) {
      throw new AppError(
        404,
        'No active live stream found for this reference',
        'LIVE_STREAM_NOT_FOUND',
      )
    }
    return this.requestStop({
      userId,
      streamRef: params.streamRef,
      adminUserId: params.adminUserId,
      reason: params.reason,
    })
  },

  async requestStop(params: {
    userId: string
    streamRef: string
    adminUserId: string
    reason?: string
  }) {
    const user = await userRepository.findById(params.userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const hostSession = await prismaRead.hostLiveSession.findFirst({
      where: {
        hostUserId: params.userId,
        status: 'ACTIVE',
        OR: [{ id: params.streamRef }, { roomId: params.streamRef }],
      },
    })

    const liveStream = hostSession
      ? await prismaRead.liveStream.findFirst({
          where: {
            userId: params.userId,
            OR: [{ streamId: hostSession.roomId }, { id: hostSession.roomId }],
          },
          orderBy: { startedAt: 'desc' },
        })
      : await prismaRead.liveStream.findFirst({
          where: {
            userId: params.userId,
            isLive: true,
            OR: [{ id: params.streamRef }, { streamId: params.streamRef }],
          },
        })

    if (!hostSession && !liveStream) {
      throw new AppError(
        404,
        'No active live stream found for this reference',
        'LIVE_STREAM_NOT_FOUND',
      )
    }

    const roomId = hostSession?.roomId ?? liveStream!.streamId
    const dbId = liveStream?.id ?? null
    const endedAt = new Date()
    const startedAt =
      hostSession?.startedAt ?? liveStream?.startedAt ?? liveStream?.createdAt ?? endedAt

    const uncountedSec = await readUncountedLiveSeconds(roomId, endedAt)
    const grossDurationSeconds = Math.max(
      0,
      Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
    )
    const effectiveDurationSeconds = computeEffectiveDurationSeconds(
      startedAt,
      endedAt,
      uncountedSec,
    )

    try {
      await persistLiveChats(roomId)
    } catch (err) {
      rootLogger.warn({ err, roomId }, 'admin live stop: chat persist failed')
    }

    if (liveStream) {
      await prisma.liveStream.update({
        where: { id: liveStream.id },
        data: {
          isLive: false,
          endedAt,
          effectiveDurationSeconds,
        },
      })
      await tryStopEgress(liveStream.playbackId)
    }

    try {
      await liveSessionService.handleSessionEnd({
        hostUserId: params.userId,
        roomId,
        durationSeconds: grossDurationSeconds,
      })
    } catch (err) {
      rootLogger.warn({ err, roomId, userId: params.userId }, 'admin live stop: session-end failed')
    }

    const livekitRoomDeleted = await tryDeleteLivekitRoom(roomId)

    try {
      const keys = liveRoomRedisKeys(roomId, dbId, params.userId)
      if (keys.length) await redisClient.del(...keys)
      await Promise.all([
        delByPattern(`stream:kicked:${roomId}:*`),
        delByPattern(`stream:alias:${roomId}:*`),
        delByPattern(`stream:viewers_sorted:${roomId}:*`),
      ])
    } catch (err) {
      rootLogger.warn({ err, roomId }, 'admin live stop: Redis room cleanup failed')
    }

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.userId,
      actionType: 'ADMIN_LIVE_STREAM_STOP_REQUESTED',
      actionStatus: 'success',
      actionDetails: {
        roomId,
        streamId: roomId,
        streamRef: params.streamRef,
        reason: params.reason ?? null,
        livekitRoomDeleted,
      },
    })

    return {
      ok: true as const,
      status: 'STOP_REQUESTED' as const,
      roomId,
      pendingLiveBackend: false,
      livekitRoomDeleted,
      liveBackendNotified: false,
      message: livekitRoomDeleted
        ? 'Room closed. Host and viewers were disconnected; live Redis keys were cleared.'
        : 'Stream marked ended and Redis cleared. Configure LIVEKIT_* on this API to also disconnect the LiveKit room.',
    }
  },

  async stopAllActiveForUser(params: {
    userId: string
    adminUserId: string
    reason?: string
  }): Promise<{ stopped: number }> {
    const { streams } = await this.listActiveForUser(params.userId)
    let stopped = 0
    for (const stream of streams) {
      try {
        await this.requestStop({
          userId: params.userId,
          streamRef: stream.id,
          adminUserId: params.adminUserId,
          reason: params.reason,
        })
        stopped += 1
      } catch (err) {
        if (err instanceof AppError && err.code === 'LIVE_STREAM_NOT_FOUND') continue
        rootLogger.warn(
          { err, userId: params.userId, streamRef: stream.id },
          'admin live stop-all: one stream failed',
        )
      }
    }
    return { stopped }
  },
}
