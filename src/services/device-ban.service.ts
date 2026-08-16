import { redisClient, RedisKeys } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { bannedDeviceRepository } from '../repositories/bannedDevice.repository'
import { sessionRepository } from '../repositories/session.repository'
import { userRepository } from '../repositories/user.repository'
import { auditService } from './audit.service'

const BAN_CACHE_TTL_SEC = 300

export async function isDeviceBanned(
  deviceId: string,
  prefetched?: string | null,
): Promise<boolean> {
  const normalized = deviceId.trim()
  if (!normalized) return false

  const cacheKey = RedisKeys.deviceBanned(normalized)
  const cached = prefetched !== undefined ? prefetched : await redisClient.get(cacheKey)
  if (cached === '1') return true
  if (cached === '0') return false

  const row = await bannedDeviceRepository.findByDeviceId(normalized)
  const banned = row != null
  await redisClient.set(cacheKey, banned ? '1' : '0', 'EX', BAN_CACHE_TTL_SEC)
  return banned
}

export async function assertDeviceNotBanned(
  deviceId: string | undefined | null,
  prefetched?: string | null,
): Promise<void> {
  const normalized = deviceId?.trim()
  if (!normalized) return
  if (await isDeviceBanned(normalized, prefetched)) {
    throw new AppError(403, 'This device has been banned from the platform', 'DEVICE_BANNED')
  }
}

export const deviceBanService = {
  isDeviceBanned,
  assertDeviceNotBanned,

  async banDevice(params: {
    deviceId: string
    adminUserId: string
    reason?: string
    relatedUserId?: string
  }) {
    const deviceId = params.deviceId.trim()
    if (!deviceId) {
      throw new AppError(400, 'deviceId is required', 'INVALID_REQUEST')
    }

    await bannedDeviceRepository.ban({
      deviceId,
      reason: params.reason?.trim() || null,
      bannedByAdminId: params.adminUserId,
      relatedUserId: params.relatedUserId ?? null,
    })
    await redisClient.set(RedisKeys.deviceBanned(deviceId), '1', 'EX', BAN_CACHE_TTL_SEC)

    const sessions = await sessionRepository.findActiveByDeviceId(deviceId)
    const sessionIds = await sessionRepository.revokeAllByDeviceId(deviceId)
    const userIds = [...new Set(sessions.map((s) => s.userId))]

    if (sessionIds.length > 0) {
      const pipe = redisClient.pipeline()
      for (const id of sessionIds) {
        pipe.del(RedisKeys.session(id))
      }
      pipe.del(RedisKeys.deviceLinkedAccounts(deviceId))
      await pipe.exec()
    }

    for (const userId of userIds) {
      await userRepository.incrementTokenVersion(userId)
      await redisClient.del(RedisKeys.userTokenVersion(userId))
    }

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.relatedUserId ?? userIds[0] ?? null,
      actionType: 'ADMIN_DEVICE_BANNED',
      actionStatus: 'success',
      actionDetails: {
        deviceId,
        reason: params.reason ?? null,
        sessionsRevoked: sessionIds.length,
        affectedUserIds: userIds,
      },
      deviceId,
    })

    return {
      ok: true as const,
      deviceId,
      bannedAt: new Date().toISOString(),
      sessionsRevoked: sessionIds.length,
      affectedUserIds: userIds,
    }
  },

  async unbanDevice(deviceId: string, adminUserId: string) {
    const normalized = deviceId.trim()
    const deleted = await bannedDeviceRepository.unban(normalized)
    await redisClient.del(RedisKeys.deviceBanned(normalized))

    auditService.logAdmin({
      adminUserId,
      actionType: 'ADMIN_DEVICE_UNBANNED',
      actionStatus: 'success',
      actionDetails: { deviceId: normalized, removed: deleted.count },
      deviceId: normalized,
    })

    return { ok: true as const, deviceId: normalized, removed: deleted.count > 0 }
  },
}
