import { RedisKeys } from '../config/redis'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { AppError } from '../middlewares/errorHandler'
import {
  userSettingsRepository,
  type UserSettingsUpdateData,
} from '../repositories/userSettings.repository'

export interface MessagePrivacyFlags {
  allowMsgFromMutual?: boolean
  allowMsgFromFollowing?: boolean
  allowMsgFromStranger?: boolean
}

export interface AuditMeta {
  request?: { ip?: string; headers?: Record<string, string | undefined> }
  deviceId?: string | null
}

const USER_SETTINGS_CACHE_TTL_SEC = 3600

export const userSettingsService = {
  async getOrCreateSettings(userId: string) {
    const cacheKey = RedisKeys.userSettings(userId)
    const cached = await cacheService.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as {
        id: string
        userId: string
        language: string
        allowMsgFromMutual: boolean
        allowMsgFromFollowing: boolean
        allowMsgFromStranger: boolean
        createdAt: string
        updatedAt: string
      }
    }

    const settings = await userSettingsRepository.upsertSettings(userId, {})
    const payload = {
      id: settings.id,
      userId: settings.userId,
      language: settings.language,
      allowMsgFromMutual: settings.allowMsgFromMutual,
      allowMsgFromFollowing: settings.allowMsgFromFollowing,
      allowMsgFromStranger: settings.allowMsgFromStranger,
      createdAt: settings.createdAt.toISOString(),
      updatedAt: settings.updatedAt.toISOString(),
    }
    await cacheService.set(cacheKey, JSON.stringify(payload), USER_SETTINGS_CACHE_TTL_SEC)
    return payload
  },

  async updateLanguage(userId: string, language: 'en' | 'ne', meta: AuditMeta) {
    if (language !== 'en' && language !== 'ne') {
      throw new AppError(400, 'Invalid language', 'INVALID_LANGUAGE')
    }

    const updated = await userSettingsRepository.upsertSettings(userId, { language })
    const cacheKey = RedisKeys.userSettings(userId)
    await cacheService.delete(cacheKey)

    await auditService.log({
      userId,
      actionType: 'USER_LANGUAGE_UPDATED',
      actionStatus: 'success',
      actionDetails: { language },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })

    return {
      id: updated.id,
      userId: updated.userId,
      language: updated.language,
      allowMsgFromMutual: updated.allowMsgFromMutual,
      allowMsgFromFollowing: updated.allowMsgFromFollowing,
      allowMsgFromStranger: updated.allowMsgFromStranger,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    }
  },

  async updateMessagePrivacy(
    userId: string,
    flags: MessagePrivacyFlags,
    meta: AuditMeta,
  ) {
    const hasAnyField =
      typeof flags.allowMsgFromMutual === 'boolean' ||
      typeof flags.allowMsgFromFollowing === 'boolean' ||
      typeof flags.allowMsgFromStranger === 'boolean'

    if (!hasAnyField) {
      throw new AppError(400, 'No fields to update', 'NO_UPDATE_FIELDS')
    }

    const updateData: UserSettingsUpdateData = {}
    if (typeof flags.allowMsgFromMutual === 'boolean') {
      updateData.allowMsgFromMutual = flags.allowMsgFromMutual
    }
    if (typeof flags.allowMsgFromFollowing === 'boolean') {
      updateData.allowMsgFromFollowing = flags.allowMsgFromFollowing
    }
    if (typeof flags.allowMsgFromStranger === 'boolean') {
      updateData.allowMsgFromStranger = flags.allowMsgFromStranger
    }

    const updated = await userSettingsRepository.upsertSettings(userId, updateData)
    const cacheKey = RedisKeys.userSettings(userId)
    await cacheService.delete(cacheKey)

    const changed: Record<string, boolean> = {}
    if ('allowMsgFromMutual' in updateData && updateData.allowMsgFromMutual != null) {
      changed.allowMsgFromMutual = updateData.allowMsgFromMutual
    }
    if ('allowMsgFromFollowing' in updateData && updateData.allowMsgFromFollowing != null) {
      changed.allowMsgFromFollowing = updateData.allowMsgFromFollowing
    }
    if ('allowMsgFromStranger' in updateData && updateData.allowMsgFromStranger != null) {
      changed.allowMsgFromStranger = updateData.allowMsgFromStranger
    }

    await auditService.log({
      userId,
      actionType: 'USER_MESSAGE_PRIVACY_UPDATED',
      actionStatus: 'success',
      actionDetails: changed,
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })

    return {
      id: updated.id,
      userId: updated.userId,
      language: updated.language,
      allowMsgFromMutual: updated.allowMsgFromMutual,
      allowMsgFromFollowing: updated.allowMsgFromFollowing,
      allowMsgFromStranger: updated.allowMsgFromStranger,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    }
  },
}

