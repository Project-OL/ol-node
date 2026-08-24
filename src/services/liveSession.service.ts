import { prisma } from '../config/database'
import { env } from '../config/env'
import { LIVE_ACTIVE_SESSION_TTL, RedisKeys, redisClient } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  enqueueLiveSessionSafetyNet,
  enqueueNotifyLiveSubscribers,
} from '../queues/live-session.queue'
import { liveSessionRepository } from '../repositories/liveSession.repository'
import { utcStartOfDay } from '../utils/datetime'

export const liveSessionService = {
  async handleSessionStart(data: {
    hostUserId: string
    agencyUserId: string
    roomId: string
    startedAt?: Date
  }) {
    // Enforce admin LIVE_STREAM_START_BAN before recording agency duration.
    const { userRestrictionService } = await import('./userRestriction.service')
    await userRestrictionService.assertNotRestricted(data.hostUserId, 'LIVE_STREAM_START_BAN')

    const startedAt = data.startedAt ?? new Date()

    const existingKey = await redisClient.get(RedisKeys.liveActiveSession(data.hostUserId))
    if (existingKey) {
      return { alreadyActive: true, session: JSON.parse(existingKey) }
    }

    let session
    try {
      session = await liveSessionRepository.createSession({
        hostUserId: data.hostUserId,
        agencyUserId: data.agencyUserId,
        roomId: data.roomId,
        startedAt,
      })
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new AppError(409, 'Session already active for this host', 'LIVE_SESSION_CONFLICT')
      }
      throw err
    }

    await redisClient.setex(
      RedisKeys.liveActiveSession(data.hostUserId),
      LIVE_ACTIVE_SESSION_TTL,
      JSON.stringify({
        sessionId: session.id,
        agencyUserId: data.agencyUserId,
        startedAt: startedAt.toISOString(),
        roomId: data.roomId,
      }),
    )

    await enqueueLiveSessionSafetyNet(session.id, data.hostUserId, env.LIVE_SESSION_TIMEOUT_HOURS)
    await enqueueNotifyLiveSubscribers(data.hostUserId, session.id)

    return { alreadyActive: false, session }
  },

  async handleSessionEnd(data: {
    hostUserId: string
    roomId: string
    endedAt?: Date
    durationSeconds: number
  }) {
    const endedAt = data.endedAt ?? new Date()
    const durationSeconds = BigInt(Math.max(0, Math.floor(data.durationSeconds)))

    const session = await liveSessionRepository.endSession(
      data.hostUserId,
      data.roomId,
      endedAt,
      durationSeconds,
      'ENDED',
    )

    if (!session) {
      return { alreadyEnded: true }
    }

    if (durationSeconds > 0n) {
      const day = utcStartOfDay(session.startedAt)
      await upsertLiveDuration(session.agencyUserId, data.hostUserId, day, durationSeconds)
    }

    await redisClient.del(RedisKeys.liveActiveSession(data.hostUserId))

    return { alreadyEnded: false, session }
  },

  async interruptStaleSession(sessionId: string, hostUserId: string, startedAt: Date) {
    const endedAt = new Date()
    const durationSeconds = BigInt(Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))

    const session = await prisma.hostLiveSession.findUnique({
      where: { id: sessionId },
      select: { agencyUserId: true, roomId: true, status: true },
    })

    if (!session || session.status !== 'ACTIVE') return

    await liveSessionRepository.interruptSession(sessionId, endedAt, durationSeconds)

    if (durationSeconds > 0n) {
      const day = utcStartOfDay(startedAt)
      await upsertLiveDuration(session.agencyUserId, hostUserId, day, durationSeconds)
    }

    await redisClient.del(RedisKeys.liveActiveSession(hostUserId))
  },
}

async function upsertLiveDuration(
  agencyUserId: string,
  hostUserId: string,
  day: Date,
  durationSeconds: bigint,
): Promise<void> {
  await prisma.agencyDailyEarning.upsert({
    where: {
      agencyUserId_hostUserId_day: { agencyUserId, hostUserId, day },
    },
    create: {
      agencyUserId,
      hostUserId,
      day,
      hostEarningsPoints: 0n,
      hostCommissionPoints: 0n,
      hostWasActive: false,
      liveDurationSeconds: durationSeconds,
    },
    update: {
      liveDurationSeconds: { increment: durationSeconds },
    },
  })
}
