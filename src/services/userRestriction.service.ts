import type { UserRestriction, UserRestrictionType } from '@prisma/client'
import { RedisKeys, redisClient } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { userRepository } from '../repositories/user.repository'
import { userRestrictionRepository } from '../repositories/userRestriction.repository'
import { prismaRead } from '../config/database'
import { auditService } from './audit.service'
import { publishServerFrameToUser } from '../utils/ws-publisher'

const ERROR_BY_TYPE: Record<
  UserRestrictionType,
  { code: string; message: string }
> = {
  LIVE_CHAT_MUTE: {
    code: 'LIVE_CHAT_MUTED',
    message: 'Live stream chatting is muted for this account',
  },
  LIVE_AUDIO_MUTE: {
    code: 'LIVE_AUDIO_MUTED',
    message: 'Live stream audio is muted for this account',
  },
  MESSAGING_DISABLE: {
    code: 'MESSAGING_DISABLED',
    message: 'Messaging other users is disabled for this account',
  },
  LIVE_STREAM_START_BAN: {
    code: 'LIVE_STREAM_START_BANNED',
    message: 'Starting a live stream is disabled for this account',
  },
}

function ttlSecondsUntil(until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000))
}

function toDto(row: UserRestriction) {
  const now = new Date()
  const active = row.clearedAt == null && row.restrictedUntil > now
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    restrictedUntil: row.restrictedUntil.toISOString(),
    reason: row.reason,
    reportId: row.reportId,
    createdByAdminId: row.createdByAdminId,
    clearedAt: row.clearedAt?.toISOString() ?? null,
    clearedByAdminId: row.clearedByAdminId,
    createdAt: row.createdAt.toISOString(),
    active,
  }
}

async function cacheActive(userId: string, type: UserRestrictionType, until: Date): Promise<void> {
  const key = RedisKeys.userRestriction(userId, type)
  await redisClient.set(key, until.toISOString(), 'EX', ttlSecondsUntil(until))
}

async function clearCache(userId: string, type: UserRestrictionType): Promise<void> {
  await redisClient.del(RedisKeys.userRestriction(userId, type))
}

async function refreshCacheForType(userId: string, type: UserRestrictionType): Promise<void> {
  const active = await userRestrictionRepository.findActiveByUserAndType(userId, type)
  if (active) {
    await cacheActive(userId, type, active.restrictedUntil)
  } else {
    await clearCache(userId, type)
  }
}

async function notifyUserRestrictionChanged(
  userId: string,
  frame: Extract<import('../realtime/types').ServerFrame, { t: 'USER_RESTRICTION' }>,
): Promise<void> {
  try {
    await publishServerFrameToUser(userId, frame)
  } catch {
    /* best-effort realtime */
  }
}

export const userRestrictionService = {
  toDto,

  async listForAdmin(userId: string, includeCleared: boolean) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    const rows = await userRestrictionRepository.listByUser(userId, includeCleared)
    const active = rows.filter((r) => r.clearedAt == null && r.restrictedUntil > new Date())
    return {
      userId,
      active: active.map(toDto),
      history: includeCleared ? rows.map(toDto) : active.map(toDto),
    }
  },

  async listActiveForUser(userId: string) {
    const rows = await userRestrictionRepository.findActiveByUser(userId)
    return {
      restrictions: rows.map((r) => ({
        type: r.type,
        restrictedUntil: r.restrictedUntil.toISOString(),
        reason: r.reason,
      })),
    }
  },

  /**
   * Apply one restriction type until `restrictedUntil`.
   * Replaces any currently-active restriction of the same type (prior row is cleared).
   * Other types are untouched — restrictions are independent per type / report.
   */
  async apply(params: {
    userId: string
    type: UserRestrictionType
    restrictedUntil: Date
    reason?: string
    reportId?: string
    adminUserId: string
  }) {
    if (params.restrictedUntil <= new Date()) {
      throw new AppError(400, 'restrictedUntil must be in the future', 'INVALID_REQUEST')
    }

    const user = await userRepository.findById(params.userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    if (params.reportId) {
      const report = await prismaRead.messageReport.findUnique({
        where: { id: params.reportId },
        select: { id: true, reportedUserId: true },
      })
      if (!report) throw new AppError(404, 'Report not found', 'REPORT_NOT_FOUND')
      if (report.reportedUserId !== params.userId) {
        throw new AppError(
          400,
          'reportId does not belong to this user',
          'REPORT_USER_MISMATCH',
        )
      }
    }

    await userRestrictionRepository.clearActiveOfType(
      params.userId,
      params.type,
      params.adminUserId,
    )

    const row = await userRestrictionRepository.create({
      userId: params.userId,
      type: params.type,
      restrictedUntil: params.restrictedUntil,
      reason: params.reason ?? null,
      reportId: params.reportId ?? null,
      createdByAdminId: params.adminUserId,
    })

    await cacheActive(params.userId, params.type, params.restrictedUntil)

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_USER_RESTRICTION_APPLIED',
      actionStatus: 'success',
      actionDetails: {
        targetUserId: params.userId,
        type: params.type,
        restrictedUntil: params.restrictedUntil.toISOString(),
        reportId: params.reportId ?? null,
        restrictionId: row.id,
      },
    })

    const dto = toDto(row)
    await notifyUserRestrictionChanged(params.userId, {
      t: 'USER_RESTRICTION',
      event: 'restriction.applied',
      restriction: dto,
    })

    return dto
  },

  async clearById(params: { restrictionId: string; adminUserId: string }) {
    const row = await userRestrictionRepository.findById(params.restrictionId)
    if (!row) throw new AppError(404, 'Restriction not found', 'RESTRICTION_NOT_FOUND')
    if (row.clearedAt) {
      return toDto(row)
    }

    const cleared = await userRestrictionRepository.clear(row.id, params.adminUserId)
    await refreshCacheForType(row.userId, row.type)

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_USER_RESTRICTION_CLEARED',
      actionStatus: 'success',
      actionDetails: {
        targetUserId: row.userId,
        type: row.type,
        restrictionId: row.id,
      },
    })

    const dto = toDto(cleared)
    await notifyUserRestrictionChanged(row.userId, {
      t: 'USER_RESTRICTION',
      event: 'restriction.cleared',
      restriction: dto,
    })
    return dto
  },

  async clearType(params: {
    userId: string
    type: UserRestrictionType
    adminUserId: string
  }) {
    const user = await userRepository.findById(params.userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const clearedCount = await userRestrictionRepository.clearActiveOfType(
      params.userId,
      params.type,
      params.adminUserId,
    )
    await clearCache(params.userId, params.type)

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_USER_RESTRICTION_CLEARED',
      actionStatus: 'success',
      actionDetails: {
        targetUserId: params.userId,
        type: params.type,
        clearedCount,
      },
    })

    await notifyUserRestrictionChanged(params.userId, {
      t: 'USER_RESTRICTION',
      event: 'restriction.cleared',
      type: params.type,
      clearedCount,
    })

    return { ok: true as const, userId: params.userId, type: params.type, clearedCount }
  },

  /**
   * Fast path for send/live checks. Prefers Redis; falls back to DB.
   */
  async assertNotRestricted(userId: string, type: UserRestrictionType): Promise<void> {
    const key = RedisKeys.userRestriction(userId, type)
    const cached = await redisClient.get(key)
    if (cached) {
      const until = new Date(cached)
      if (until > new Date()) {
        const err = ERROR_BY_TYPE[type]
        throw new AppError(403, err.message, err.code, {
          restrictedUntil: until.toISOString(),
          type,
        })
      }
      await redisClient.del(key)
      return
    }

    const active = await userRestrictionRepository.findActiveByUserAndType(userId, type)
    if (!active) return

    await cacheActive(userId, type, active.restrictedUntil)
    const err = ERROR_BY_TYPE[type]
    throw new AppError(403, err.message, err.code, {
      restrictedUntil: active.restrictedUntil.toISOString(),
      type,
    })
  },

  async getActiveUntil(
    userId: string,
    type: UserRestrictionType,
  ): Promise<Date | null> {
    const key = RedisKeys.userRestriction(userId, type)
    const cached = await redisClient.get(key)
    if (cached) {
      const until = new Date(cached)
      if (until > new Date()) return until
      await redisClient.del(key)
      return null
    }
    const active = await userRestrictionRepository.findActiveByUserAndType(userId, type)
    if (!active) return null
    await cacheActive(userId, type, active.restrictedUntil)
    return active.restrictedUntil
  },
}
