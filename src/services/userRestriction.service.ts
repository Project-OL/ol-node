import type { UserRestrictionType } from '@prisma/client'
import { RedisKeys, redisClient } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { userRepository } from '../repositories/user.repository'
import {
  userRestrictionRepository,
  type UserRestrictionWithTargets,
} from '../repositories/userRestriction.repository'
import { prismaRead } from '../config/database'
import { auditService } from './audit.service'
import { publishServerFrameToUser } from '../utils/ws-publisher'
import { formatUserName } from '../utils/user-display'

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

const MAX_MESSAGING_TARGETS = 100

type RestrictionCachePayload = {
  until: string
  /** null = every recipient (global send ban). */
  targetUserIds: string[] | null
}

function ttlSecondsUntil(until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000))
}

/** Empty target rows = global (all recipients). */
export function targetUserIdsFromRow(row: UserRestrictionWithTargets): string[] | null {
  if (row.type !== 'MESSAGING_DISABLE') return null
  if (!row.targets?.length) return null
  return row.targets.map((t) => t.targetUserId)
}

function toDto(row: UserRestrictionWithTargets) {
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
    /** null = applies to every recipient (MESSAGING_DISABLE global, or non-messaging types). */
    targetUserIds: targetUserIdsFromRow(row),
  }
}

function serializeCache(until: Date, targetUserIds: string[] | null): string {
  const iso = until.toISOString()
  const payload: RestrictionCachePayload & { restrictedUntil: string } = {
    until: iso,
    /** Live-server `isUserRestrictedFast` reads this field. */
    restrictedUntil: iso,
    targetUserIds,
  }
  return JSON.stringify(payload)
}

function parseCache(raw: string): { until: Date; targetUserIds: string[] | null } | null {
  if (!raw.startsWith('{')) {
    const until = new Date(raw)
    if (Number.isNaN(until.getTime())) return null
    return { until, targetUserIds: null }
  }
  try {
    const parsed = JSON.parse(raw) as RestrictionCachePayload & { restrictedUntil?: string }
    const until = new Date(parsed.until ?? parsed.restrictedUntil ?? '')
    if (Number.isNaN(until.getTime())) return null
    return {
      until,
      targetUserIds: Array.isArray(parsed.targetUserIds) ? parsed.targetUserIds : null,
    }
  } catch {
    return null
  }
}

async function cacheActive(
  userId: string,
  type: UserRestrictionType,
  until: Date,
  targetUserIds: string[] | null,
): Promise<void> {
  const key = RedisKeys.userRestriction(userId, type)
  await redisClient.set(key, serializeCache(until, targetUserIds), 'EX', ttlSecondsUntil(until))
}

async function clearCache(userId: string, type: UserRestrictionType): Promise<void> {
  await redisClient.del(RedisKeys.userRestriction(userId, type))
}

async function refreshCacheForType(userId: string, type: UserRestrictionType): Promise<void> {
  const active = await userRestrictionRepository.findActiveByUserAndType(userId, type)
  if (active) {
    await cacheActive(userId, type, active.restrictedUntil, targetUserIdsFromRow(active))
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

function throwMessagingDisabled(until: Date, targetUserIds: string[] | null): never {
  const err = ERROR_BY_TYPE.MESSAGING_DISABLE
  throw new AppError(403, err.message, err.code, {
    restrictedUntil: until.toISOString(),
    type: 'MESSAGING_DISABLE',
    targetUserIds,
  })
}

async function validateMessagingTargets(params: {
  userId: string
  targetUserIds: string[]
}): Promise<string[]> {
  const unique = [...new Set(params.targetUserIds)]
  if (unique.length > MAX_MESSAGING_TARGETS) {
    throw new AppError(
      400,
      `targetUserIds cannot exceed ${MAX_MESSAGING_TARGETS}`,
      'INVALID_REQUEST',
    )
  }
  if (unique.includes(params.userId)) {
    throw new AppError(400, 'Cannot target the restricted user themselves', 'INVALID_REQUEST')
  }
  const rows = await userRepository.findDisplayRowsByIds(unique)
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((r) => r.id))
    const missing = unique.filter((id) => !found.has(id))
    throw new AppError(404, 'One or more target users were not found', 'USER_NOT_FOUND', {
      missingUserIds: missing,
    })
  }
  return unique
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

  async listGlobalForAdmin(query: {
    type?: UserRestrictionType
    userId?: string
    active?: boolean
    page: number
    limit: number
  }) {
    const skip = (query.page - 1) * query.limit
    const { rows, total } = await userRestrictionRepository.findManyForAdmin({
      type: query.type,
      userId: query.userId,
      activeOnly: query.active !== false,
      skip,
      take: query.limit,
    })
    return {
      items: rows.map((row) => ({
        ...toDto(row),
        user: {
          ...row.user,
          name: formatUserName(row.user),
          publicId: row.user.publicId?.toString(),
        },
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasMore: skip + rows.length < total,
      },
    }
  },

  async listActiveForUser(userId: string) {
    const rows = await userRestrictionRepository.findActiveByUser(userId)
    return {
      restrictions: rows.map((r) => ({
        type: r.type,
        restrictedUntil: r.restrictedUntil.toISOString(),
        reason: r.reason,
        targetUserIds: targetUserIdsFromRow(r),
      })),
    }
  },

  /**
   * Apply one restriction type until `restrictedUntil`.
   * Replaces any currently-active restriction of the same type (prior row is cleared),
   * unless `extend` is true for MESSAGING_DISABLE (union targets + later expiry).
   * Other types are untouched — restrictions are independent per type / report.
   */
  async apply(params: {
    userId: string
    type: UserRestrictionType
    restrictedUntil: Date
    reason?: string
    reportId?: string
    adminUserId: string
    targetUserIds?: string[]
    extend?: boolean
  }) {
    if (params.restrictedUntil <= new Date()) {
      throw new AppError(400, 'restrictedUntil must be in the future', 'INVALID_REQUEST')
    }

    const incomingTargets = params.targetUserIds?.length ? params.targetUserIds : undefined
    if (incomingTargets && params.type !== 'MESSAGING_DISABLE') {
      throw new AppError(
        400,
        'targetUserIds is only valid for MESSAGING_DISABLE',
        'INVALID_REQUEST',
      )
    }
    if (params.extend && params.type !== 'MESSAGING_DISABLE') {
      throw new AppError(400, 'extend is only valid for MESSAGING_DISABLE', 'INVALID_REQUEST')
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

    let targetUserIds: string[] | undefined
    if (incomingTargets) {
      targetUserIds = await validateMessagingTargets({
        userId: params.userId,
        targetUserIds: incomingTargets,
      })
    }

    let restrictedUntil = params.restrictedUntil
    let reason = params.reason ?? null
    let reportId = params.reportId ?? null

    if (params.extend && params.type === 'MESSAGING_DISABLE') {
      const existing = await userRestrictionRepository.findActiveByUserAndType(
        params.userId,
        'MESSAGING_DISABLE',
      )
      if (existing) {
        const existingTargets = targetUserIdsFromRow(existing)
        if (existingTargets == null && targetUserIds) {
          throw new AppError(
            400,
            'Cannot add specific target users to a global messaging ban; clear it first or omit targetUserIds to extend the expiry',
            'CANNOT_NARROW_GLOBAL_MESSAGING_BAN',
          )
        }
        if (existing.restrictedUntil > restrictedUntil) {
          restrictedUntil = existing.restrictedUntil
        }
        if (existingTargets && targetUserIds) {
          targetUserIds = [...new Set([...existingTargets, ...targetUserIds])]
          if (targetUserIds.length > MAX_MESSAGING_TARGETS) {
            throw new AppError(
              400,
              `targetUserIds cannot exceed ${MAX_MESSAGING_TARGETS}`,
              'INVALID_REQUEST',
            )
          }
        } else if (existingTargets && !targetUserIds) {
          targetUserIds = existingTargets
        }
        if (reason == null) reason = existing.reason
        if (reportId == null) reportId = existing.reportId
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
      restrictedUntil,
      reason,
      reportId,
      createdByAdminId: params.adminUserId,
      targetUserIds,
    })

    await cacheActive(
      params.userId,
      params.type,
      restrictedUntil,
      targetUserIdsFromRow(row),
    )

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.userId,
      actionType: 'ADMIN_USER_RESTRICTION_APPLIED',
      actionStatus: 'success',
      actionDetails: {
        restrictionType: params.type,
        type: params.type,
        restrictedUntil: restrictedUntil.toISOString(),
        reportId: params.reportId ?? null,
        restrictionId: row.id,
        targetUserIds: targetUserIdsFromRow(row),
        extend: params.extend === true,
      },
    })

    const dto = toDto(row)
    await notifyUserRestrictionChanged(params.userId, {
      t: 'USER_RESTRICTION',
      event: 'restriction.applied',
      restriction: dto,
    })

    if (params.type === 'LIVE_STREAM_START_BAN') {
      void import('./adminLiveStream.service')
        .then(({ adminLiveStreamService }) =>
          adminLiveStreamService.stopAllActiveForUser({
            userId: params.userId,
            adminUserId: params.adminUserId,
            reason: params.reason ?? 'LIVE_STREAM_START_BAN',
          }),
        )
        .catch(() => {
          /* best-effort room close */
        })
    }

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

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: row.userId,
      actionType: 'ADMIN_USER_RESTRICTION_CLEARED',
      actionStatus: 'success',
      actionDetails: {
        restrictionType: row.type,
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

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.userId,
      actionType: 'ADMIN_USER_RESTRICTION_CLEARED',
      actionStatus: 'success',
      actionDetails: {
        restrictionType: params.type,
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
   * For MESSAGING_DISABLE, only a global (no-target) ban throws — use
   * `assertMessagingAllowed` when a recipient is known.
   */
  async assertNotRestricted(userId: string, type: UserRestrictionType): Promise<void> {
    const key = RedisKeys.userRestriction(userId, type)
    const cached = await redisClient.get(key)
    if (cached) {
      const parsed = parseCache(cached)
      if (parsed && parsed.until > new Date()) {
        if (type === 'MESSAGING_DISABLE' && parsed.targetUserIds != null) {
          return
        }
        const err = ERROR_BY_TYPE[type]
        throw new AppError(403, err.message, err.code, {
          restrictedUntil: parsed.until.toISOString(),
          type,
          ...(type === 'MESSAGING_DISABLE' ? { targetUserIds: parsed.targetUserIds } : {}),
        })
      }
      await redisClient.del(key)
      if (parsed) return
    }

    const active = await userRestrictionRepository.findActiveByUserAndType(userId, type)
    if (!active) return

    const targets = targetUserIdsFromRow(active)
    await cacheActive(userId, type, active.restrictedUntil, targets)
    if (type === 'MESSAGING_DISABLE' && targets != null) {
      return
    }
    const err = ERROR_BY_TYPE[type]
    throw new AppError(403, err.message, err.code, {
      restrictedUntil: active.restrictedUntil.toISOString(),
      type,
      ...(type === 'MESSAGING_DISABLE' ? { targetUserIds: targets } : {}),
    })
  },

  /**
   * Send-side messaging gate. Global MESSAGING_DISABLE blocks every recipient;
   * a targeted ban blocks only listed peers.
   */
  async assertMessagingAllowed(senderId: string, recipientId: string): Promise<void> {
    const key = RedisKeys.userRestriction(senderId, 'MESSAGING_DISABLE')
    const cached = await redisClient.get(key)
    if (cached) {
      const parsed = parseCache(cached)
      if (parsed && parsed.until > new Date()) {
        if (parsed.targetUserIds == null || parsed.targetUserIds.includes(recipientId)) {
          throwMessagingDisabled(parsed.until, parsed.targetUserIds)
        }
        return
      }
      await redisClient.del(key)
      if (parsed) return
    }

    const active = await userRestrictionRepository.findActiveByUserAndType(
      senderId,
      'MESSAGING_DISABLE',
    )
    if (!active) return

    const targets = targetUserIdsFromRow(active)
    await cacheActive(senderId, 'MESSAGING_DISABLE', active.restrictedUntil, targets)
    if (targets == null || targets.includes(recipientId)) {
      throwMessagingDisabled(active.restrictedUntil, targets)
    }
  },

  async getActiveUntil(
    userId: string,
    type: UserRestrictionType,
  ): Promise<Date | null> {
    const key = RedisKeys.userRestriction(userId, type)
    const cached = await redisClient.get(key)
    if (cached) {
      const parsed = parseCache(cached)
      if (parsed && parsed.until > new Date()) return parsed.until
      await redisClient.del(key)
      return null
    }
    const active = await userRestrictionRepository.findActiveByUserAndType(userId, type)
    if (!active) return null
    await cacheActive(userId, type, active.restrictedUntil, targetUserIdsFromRow(active))
    return active.restrictedUntil
  },
}
