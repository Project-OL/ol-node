import { LIVE_ACTIVE_SESSION_TTL, RedisKeys, redisClient } from '../config/redis'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { userRepository } from '../repositories/user.repository'
import { auditService } from './audit.service'

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

/**
 * Admin live-stream listing + stop request.
 *
 * TODO(livestream-backend): Coordinate the actual LiveKit/room kill with the
 * livestream service. This API currently records a Redis force-stop flag and
 * audits the request; the remote backend must honor `live:force-stop:{roomId}`
 * and then call POST /webhooks/live/session-end.
 */
export const adminLiveStreamService = {
  async listActiveForUser(userId: string): Promise<{ userId: string; streams: AdminLiveStreamRow[] }> {
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

    // Redis-only active pointer (webhook set) — include if not already listed
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

  /**
   * Request stop of an ongoing stream.
   * Does NOT yet force-disconnect LiveKit — see class TODO.
   */
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
      ? null
      : await prismaRead.liveStream.findFirst({
          where: {
            userId: params.userId,
            isLive: true,
            OR: [{ id: params.streamRef }, { streamId: params.streamRef }],
          },
        })

    if (!hostSession && !liveStream) {
      throw new AppError(404, 'No active live stream found for this reference', 'LIVE_STREAM_NOT_FOUND')
    }

    const roomId = hostSession?.roomId ?? liveStream!.streamId
    const payload = {
      requestedAt: new Date().toISOString(),
      adminUserId: params.adminUserId,
      reason: params.reason ?? null,
      hostUserId: params.userId,
      source: hostSession ? 'host_live_session' : 'live_stream',
      sessionId: hostSession?.id ?? liveStream!.id,
      pendingLiveBackend: true,
    }

    // TODO(livestream-backend): livestream service must consume this key and kill the room.
    await redisClient.set(
      RedisKeys.liveForceStop(roomId),
      JSON.stringify(payload),
      'EX',
      LIVE_ACTIVE_SESSION_TTL,
    )

    // Soft-mark live_streams row so admin list clears; host_live_sessions wait for webhook end.
    if (liveStream) {
      await prisma.liveStream.update({
        where: { id: liveStream.id },
        data: { isLive: false, endedAt: new Date() },
      })
    }

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_LIVE_STREAM_STOP_REQUESTED',
      actionStatus: 'success',
      actionDetails: {
        targetUserId: params.userId,
        roomId,
        streamRef: params.streamRef,
        reason: params.reason ?? null,
        pendingLiveBackend: true,
      },
    })

    return {
      ok: true as const,
      status: 'STOP_REQUESTED' as const,
      roomId,
      pendingLiveBackend: true,
      message:
        'Stop requested. Livestream backend must honor live:force-stop:{roomId} and call session-end webhook.',
    }
  },
}
