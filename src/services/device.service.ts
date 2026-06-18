/**
 * Device Management: list devices, revoke one, logout-all (with security password), rename.
 * Uses DeviceRegistry + Session; cache-aside for list; audit on revoke/rename/logout-all.
 */

import { AppError } from '../middlewares/errorHandler'
import { deviceRepository } from '../repositories/device.repository'
import { sessionRepository } from '../repositories/session.repository'
import { securityPasswordRepository } from '../repositories/security-password.repository'
import { cacheService } from './cache.service'
import { passwordService } from './password.service'
import { auditService } from './audit.service'
import { redisClient, RedisKeys } from '../config/redis'
import type { LinkedAccountWithUser } from '../repositories/device.repository'

export interface DeviceInfo {
  id: string
  deviceId: string
  deviceName: string
  platform: string
  isCurrentDevice: boolean
  lastActiveAt: Date
  lastActiveTimeAgo: string
  loginAt: Date
  ipAddress: string | null
  userAgent: string | null
  sessionId: string | null
}

function formatTimeAgo(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

export const deviceService = {
  /**
   * Get all active devices for user (with active session). Cache-aside, TTL 5 min.
   */
  async getDevices(userId: string, currentDeviceId?: string): Promise<DeviceInfo[]> {
    const cached = await cacheService.getUserDevices(userId)
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as (Omit<DeviceInfo, 'lastActiveAt' | 'loginAt'> & {
          lastActiveAt: string
          loginAt: string
        })[]
        return parsed.map((d) => ({
          ...d,
          lastActiveAt: new Date(d.lastActiveAt),
          loginAt: new Date(d.loginAt),
        }))
      } catch {
        // invalid cache, fall through
      }
    }

    const [devices, sessions] = await Promise.all([
      deviceRepository.findByUserId(userId),
      sessionRepository.findActiveByUserId(userId),
    ])
    const activeSet = new Set(sessions.map((s) => s.deviceId))
    const sessionByDeviceId = new Map(sessions.map((s) => [s.deviceId, s]))

    const result: DeviceInfo[] = devices
      .filter((d) => activeSet.has(d.deviceId))
      .map((device) => {
        const session = sessionByDeviceId.get(device.deviceId)
        return {
          id: device.id,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          platform: device.platform,
          isCurrentDevice: device.deviceId === currentDeviceId,
          lastActiveAt: device.lastActiveAt,
          lastActiveTimeAgo: formatTimeAgo(device.lastActiveAt),
          loginAt: device.loginAt,
          ipAddress: device.ipAddress,
          userAgent: device.userAgent,
          sessionId: session?.id ?? null,
        }
      })

    await cacheService.setUserDevices(userId, JSON.stringify(result))
    return result
  },

  /**
   * Revoke a device by registry id. Cannot revoke current device.
   */
  async revokeDevice(
    userId: string,
    registryId: string,
    currentDeviceId: string,
  ): Promise<{
    success: boolean
    revokedDeviceName: string
    remainingDevices: number
  }> {
    const device = await deviceRepository.findById(registryId)
    if (!device || device.userId !== userId) {
      throw new AppError(404, 'Device not found', 'DEVICE_NOT_FOUND')
    }
    if (device.deviceId === currentDeviceId) {
      throw new AppError(400, 'Cannot revoke current device', 'CANNOT_REVOKE_CURRENT_DEVICE')
    }

    const session = await sessionRepository.findActiveByUserIdAndDeviceId(userId, device.deviceId)
    if (session) {
      await sessionRepository.revokeById(session.id)
      await redisClient.del(RedisKeys.session(session.id))
    }

    await cacheService.invalidateUserDevicesAndSessions(userId)
    const remainingDevices = await sessionRepository.countActiveByUserId(userId)

    await auditService.log({
      userId,
      actionType: 'DEVICE_REVOKED',
      actionStatus: 'success',
      actionDetails: {
        deviceName: device.deviceName,
        deviceId: device.deviceId,
        platform: device.platform,
      },
    })

    return {
      success: true,
      revokedDeviceName: device.deviceName,
      remainingDevices,
    }
  },

  /**
   * Logout from all other devices. Requires security password.
   */
  async logoutAllOtherDevices(
    userId: string,
    securityPassword: string,
    currentDeviceId: string,
  ): Promise<{
    success: boolean
    revokedDevices: Array<{ deviceName: string; lastActiveAt: Date }>
    revokedCount: number
    remainingDevices: number
  }> {
    const secPassword = await securityPasswordRepository.findByUserId(userId)
    if (!secPassword) {
      throw new AppError(400, 'Security password not set', 'SECURITY_PASSWORD_NOT_SET')
    }

    const verified = await passwordService.compare(securityPassword, secPassword.passwordHash)
    if (!verified) {
      throw new AppError(401, 'Wrong security password', 'SECURITY_PASSWORD_INCORRECT')
    }

    const sessions = await sessionRepository.findActiveByUserId(userId)
    const otherSessions = sessions.filter((s) => s.deviceId !== currentDeviceId)

    if (otherSessions.length === 0) {
      throw new AppError(400, 'No other devices to logout from', 'NO_OTHER_DEVICES')
    }

    const revokedDevices: Array<{ deviceName: string; lastActiveAt: Date }> = []
    for (const s of otherSessions) {
      await sessionRepository.revokeById(s.id)
      await redisClient.del(RedisKeys.session(s.id))
      revokedDevices.push({
        deviceName: s.deviceName,
        lastActiveAt: s.lastActiveAt,
      })
    }

    await cacheService.invalidateUserDevicesAndSessions(userId)

    await auditService.log({
      userId,
      actionType: 'ALL_DEVICES_REVOKED',
      actionStatus: 'success',
      actionDetails: {
        revokedCount: revokedDevices.length,
        revokedDeviceNames: revokedDevices.map((d) => d.deviceName),
      },
    })

    return {
      success: true,
      revokedDevices,
      revokedCount: revokedDevices.length,
      remainingDevices: 1,
    }
  },

  /**
   * Rename a device by registry id.
   */
  async renameDevice(
    userId: string,
    registryId: string,
    newName: string,
  ): Promise<{
    success: boolean
    deviceName: string
    updatedAt: Date
  }> {
    const device = await deviceRepository.findById(registryId)
    if (!device || device.userId !== userId) {
      throw new AppError(404, 'Device not found', 'DEVICE_NOT_FOUND')
    }

    await deviceRepository.update(registryId, { deviceName: newName })

    await auditService.log({
      userId,
      actionType: 'DEVICE_RENAMED',
      actionStatus: 'success',
      actionDetails: { deviceId: device.deviceId, newName },
    })

    return {
      success: true,
      deviceName: newName,
      updatedAt: new Date(),
    }
  },

  async linkAccountToDevice(deviceId: string, userId: string): Promise<void> {
    if (!deviceId) {
      return
    }

    const existingCount = await deviceRepository.countLinkedAccounts(deviceId)
    if (existingCount >= 3) {
      const existingAccounts = await deviceRepository.findLinkedAccounts(deviceId)
      const alreadyLinked = existingAccounts.some((acc) => acc.userId === userId)
      if (!alreadyLinked) {
        throw new AppError(
          400,
          'This device already has 3 linked accounts. Remove one to add another.',
          'DEVICE_ACCOUNT_LIMIT_REACHED',
        )
      }
    }

    await deviceRepository.upsertLinkedAccount(deviceId, userId)
    await cacheService.delete(RedisKeys.deviceLinkedAccounts(deviceId))

    await auditService.log({
      userId,
      actionType: 'DEVICE_ACCOUNT_LINKED',
      actionStatus: 'success',
      actionDetails: { deviceId },
      deviceId,
    })
  },

  async unlinkAccountFromDevice(
    deviceId: string,
    targetUserId: string,
    requestingUserId: string,
    meta: { request?: { ip?: string; headers?: Record<string, string | undefined> } },
  ): Promise<void> {
    if (targetUserId === requestingUserId) {
      throw new AppError(
        400,
        'Cannot unlink active account from device. Use logout instead.',
        'CANNOT_UNLINK_ACTIVE_ACCOUNT',
      )
    }

    await deviceRepository.deleteLinkedAccount(deviceId, targetUserId)
    const revokedSessionIds = await sessionRepository.revokeByUserAndDevice(targetUserId, deviceId)
    for (const id of revokedSessionIds) {
      await redisClient.del(RedisKeys.session(id))
    }

    await cacheService.delete(RedisKeys.deviceLinkedAccounts(deviceId))

    await auditService.log({
      userId: requestingUserId,
      actionType: 'DEVICE_ACCOUNT_UNLINKED',
      actionStatus: 'success',
      actionDetails: { targetUserId, deviceId },
      request: meta.request,
      deviceId,
    })
  },

  async getLinkedAccounts(deviceId: string): Promise<LinkedAccountWithUser[]> {
    const cacheKey = RedisKeys.deviceLinkedAccounts(deviceId)
    const cached = await cacheService.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as LinkedAccountWithUser[]
    }

    const accounts = await deviceRepository.findActiveSessionAccountsOnDevice(deviceId)
    await cacheService.set(cacheKey, JSON.stringify(accounts), 1800)
    return accounts
  },

  /**
   * Revoke every active session and linked account on the given physical device.
   * Caller must be authenticated from the same `deviceId` (JWT).
   */
  async flushDeviceSessions(
    requestingUserId: string,
    jwtDeviceId: string | undefined,
    deviceId: string,
    deviceName: string,
  ): Promise<{
    success: boolean
    revokedSessionCount: number
    unlinkedAccountCount: number
    affectedUserIds: string[]
  }> {
    if (!jwtDeviceId || jwtDeviceId !== deviceId) {
      throw new AppError(
        403,
        'Can only flush sessions on the current device',
        'DEVICE_ID_MISMATCH',
      )
    }

    const activeSessions = await sessionRepository.findActiveByDeviceId(deviceId)
    if (activeSessions.length === 0) {
      const unlinkedAccountCount = await deviceRepository.deleteAllLinkedAccounts(deviceId)
      await cacheService.delete(RedisKeys.deviceLinkedAccounts(deviceId))
      return {
        success: true,
        revokedSessionCount: 0,
        unlinkedAccountCount,
        affectedUserIds: [],
      }
    }

    const sessionOnDevice = activeSessions.find((s) => s.userId === requestingUserId)
    if (!sessionOnDevice) {
      throw new AppError(403, 'No active session on this device', 'DEVICE_SESSION_NOT_FOUND')
    }
    if (sessionOnDevice.deviceName.trim() !== deviceName.trim()) {
      throw new AppError(400, 'Device name does not match', 'DEVICE_NAME_MISMATCH')
    }

    const affectedUserIds = [...new Set(activeSessions.map((s) => s.userId))]
    const revokedSessionIds = await sessionRepository.revokeAllByDeviceId(deviceId)
    for (const sessionId of revokedSessionIds) {
      await redisClient.del(RedisKeys.session(sessionId))
    }

    const unlinkedAccountCount = await deviceRepository.deleteAllLinkedAccounts(deviceId)
    await cacheService.delete(RedisKeys.deviceLinkedAccounts(deviceId))

    await Promise.all(
      affectedUserIds.map((userId) => cacheService.invalidateUserDevicesAndSessions(userId)),
    )

    await auditService.log({
      userId: requestingUserId,
      actionType: 'DEVICE_SESSIONS_FLUSHED',
      actionStatus: 'success',
      actionDetails: {
        deviceId,
        deviceName,
        revokedSessionCount: revokedSessionIds.length,
        unlinkedAccountCount,
        affectedUserIds,
      },
      deviceId,
    })

    return {
      success: true,
      revokedSessionCount: revokedSessionIds.length,
      unlinkedAccountCount,
      affectedUserIds,
    }
  },
}
