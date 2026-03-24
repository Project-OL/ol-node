/**
 * VIP Privacy Settings: 4 premium toggles (invisible visitor, mystery live, mystery rank, invisible online).
 * All require VIP subscription. Cache-aside with invalidation on every toggle.
 * Future: implement effect of each feature in live room code, ranking calculation, profile visitors, online status.
 */

import { RedisKeys } from '../config/redis'
import { userRepository } from '../repositories/user.repository'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { AppError } from '../middlewares/errorHandler'

const PRIVACY_CACHE_TTL_SEC = 3600 // 1 hour

export interface PrivacySettings {
  invisibleVisitor: boolean
  mysteryLive: boolean
  mysteryRank: boolean
  invisibleOnline: boolean
  hideMicStatus?: boolean
}

export interface PrivacyFeatureInfo {
  enabled: boolean
  description: string
  effect: string
}

type PrivacyToggleKey = 'invisibleVisitor' | 'mysteryLive' | 'mysteryRank' | 'invisibleOnline'

const FEATURE_DESCRIPTIONS: Record<
  PrivacyToggleKey,
  { description: string; effect: string }
> = {
  invisibleVisitor: {
    description: 'Visit profiles without leaving a trace',
    effect: "Your visits won't appear in profile visitor counts or lists",
  },
  mysteryLive: {
    description: 'Appear as Mystery Man in live rooms',
    effect: "Other viewers see 'Mystery Man' instead of your name",
  },
  mysteryRank: {
    description: 'Exclude from rankings',
    effect: "Your gifts won't count toward rankings",
  },
  invisibleOnline: {
    description: 'Hide online status',
    effect: "Others can't see when you're online or your last seen time",
  },
}

type PrivacyField =
  | 'privacyInvisibleVisitor'
  | 'privacyMysteryLive'
  | 'privacyMysteryRank'
  | 'privacyInvisibleOnline'

interface UserPrivacyRow {
  id: string
  vipSubscriptionActive: boolean
  privacyInvisibleVisitor: boolean
  privacyMysteryLive: boolean
  privacyMysteryRank: boolean
  privacyInvisibleOnline: boolean
  hideMicStatus: boolean
  privacyUpdatedAt: Date | null
  updatedAt?: Date
}

export const privacyService = {
  async getSettings(userId: string): Promise<{
    vipActive: boolean
    settings: Record<PrivacyToggleKey, PrivacyFeatureInfo>
    updatedAt: Date
  }> {
    const cacheKey = RedisKeys.userPrivacySettings(userId)
    const cached = await cacheService.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached) as {
        vipActive: boolean
        settings: Record<PrivacyToggleKey, PrivacyFeatureInfo>
        updatedAt: string
      }
      return {
        ...parsed,
        updatedAt: new Date(parsed.updatedAt),
      }
    }

    const user = (await userRepository.findById(userId)) as UserPrivacyRow | null
    if (!user) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    if (!user.vipSubscriptionActive) {
      throw new AppError(
        403,
        'VIP subscription required for privacy settings',
        'VIP_SUBSCRIPTION_REQUIRED',
      )
    }

    const settings: Record<PrivacyToggleKey, PrivacyFeatureInfo> = {
      invisibleVisitor: {
        enabled: user.privacyInvisibleVisitor,
        ...FEATURE_DESCRIPTIONS.invisibleVisitor,
      },
      mysteryLive: {
        enabled: user.privacyMysteryLive,
        ...FEATURE_DESCRIPTIONS.mysteryLive,
      },
      mysteryRank: {
        enabled: user.privacyMysteryRank,
        ...FEATURE_DESCRIPTIONS.mysteryRank,
      },
      invisibleOnline: {
        enabled: user.privacyInvisibleOnline,
        ...FEATURE_DESCRIPTIONS.invisibleOnline,
      },
    }

    const updatedAt = user.privacyUpdatedAt ?? user.updatedAt ?? new Date()
    const result = {
      vipActive: user.vipSubscriptionActive,
      settings,
      updatedAt,
    }

    await cacheService.set(cacheKey, JSON.stringify(result), PRIVACY_CACHE_TTL_SEC)
    return result
  },

  async toggleInvisibleVisitor(
    userId: string,
    enabled: boolean,
    request?: { ip?: string; headers?: Record<string, string | undefined> },
  ): Promise<{
    feature: string
    enabled: boolean
    message: string
    updatedAt: Date
  }> {
    const updated = await this.checkVipAndUpdate(userId, 'privacyInvisibleVisitor', enabled)
    await this.invalidatePrivacyCaches(userId)

    await auditService.log({
      userId,
      actionType: 'PRIVACY_INVISIBLE_VISITOR_TOGGLED',
      actionStatus: 'success',
      actionDetails: { enabled },
      request,
    })

    return {
      feature: 'invisibleVisitor',
      enabled,
      message: enabled ? 'Invisible visitor enabled' : 'Invisible visitor disabled',
      updatedAt: updated.privacyUpdatedAt ?? new Date(),
    }
  },

  async toggleMysteryLive(
    userId: string,
    enabled: boolean,
    request?: { ip?: string; headers?: Record<string, string | undefined> },
  ): Promise<{
    feature: string
    enabled: boolean
    message: string
    updatedAt: Date
  }> {
    const updated = await this.checkVipAndUpdate(userId, 'privacyMysteryLive', enabled)
    await this.invalidatePrivacyCaches(userId)

    await auditService.log({
      userId,
      actionType: 'PRIVACY_MYSTERY_LIVE_TOGGLED',
      actionStatus: 'success',
      actionDetails: { enabled },
      request,
    })

    return {
      feature: 'mysteryLive',
      enabled,
      message: enabled ? 'Mystery live enabled' : 'Mystery live disabled',
      updatedAt: updated.privacyUpdatedAt ?? new Date(),
    }
  },

  async toggleMysteryRank(
    userId: string,
    enabled: boolean,
    request?: { ip?: string; headers?: Record<string, string | undefined> },
  ): Promise<{
    feature: string
    enabled: boolean
    message: string
    updatedAt: Date
  }> {
    const updated = await this.checkVipAndUpdate(userId, 'privacyMysteryRank', enabled)
    await this.invalidatePrivacyCaches(userId)

    await auditService.log({
      userId,
      actionType: 'PRIVACY_MYSTERY_RANK_TOGGLED',
      actionStatus: 'success',
      actionDetails: { enabled },
      request,
    })

    return {
      feature: 'mysteryRank',
      enabled,
      message: enabled ? 'Mystery rank enabled' : 'Mystery rank disabled',
      updatedAt: updated.privacyUpdatedAt ?? new Date(),
    }
  },

  async toggleInvisibleOnline(
    userId: string,
    enabled: boolean,
    request?: { ip?: string; headers?: Record<string, string | undefined> },
  ): Promise<{
    feature: string
    enabled: boolean
    message: string
    updatedAt: Date
  }> {
    const updated = await this.checkVipAndUpdate(userId, 'privacyInvisibleOnline', enabled)
    await this.invalidatePrivacyCaches(userId)

    await auditService.log({
      userId,
      actionType: 'PRIVACY_INVISIBLE_ONLINE_TOGGLED',
      actionStatus: 'success',
      actionDetails: { enabled },
      request,
    })

    return {
      feature: 'invisibleOnline',
      enabled,
      message: enabled
        ? 'Invisible online enabled. Will auto-disable when live streaming.'
        : 'Invisible online disabled',
      updatedAt: updated.privacyUpdatedAt ?? new Date(),
    }
  },

  async checkVipAndUpdate(
    userId: string,
    field: PrivacyField,
    value: boolean,
  ): Promise<{ privacyUpdatedAt: Date }> {
    const user = (await userRepository.findById(userId)) as UserPrivacyRow | null
    if (!user) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }
    if (!user.vipSubscriptionActive) {
      throw new AppError(
        403,
        'VIP subscription required',
        'VIP_SUBSCRIPTION_REQUIRED',
      )
    }

    const now = new Date()
    await userRepository.update(userId, {
      [field]: value,
      privacyUpdatedAt: now,
    })
    return { privacyUpdatedAt: now }
  },

  async invalidatePrivacyCaches(userId: string): Promise<void> {
    await cacheService.delete(RedisKeys.userPrivacySettings(userId))
    await cacheService.delete(RedisKeys.userPrivacyData(userId))
  },

  /**
   * Get minimal privacy settings for other services (e.g. profile loading, visitor logic).
   * Use in: profile visiting logic (invisible visitor), ranking (mystery rank), live room (mystery live), online status (invisible online).
   */
  async getUserPrivacySettings(userId: string): Promise<PrivacySettings> {
    const cacheKey = RedisKeys.userPrivacyData(userId)
    const cached = await cacheService.get(cacheKey)
    if (cached) return JSON.parse(cached) as PrivacySettings

    const user = (await userRepository.findById(userId)) as UserPrivacyRow | null
    if (!user) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const settings: PrivacySettings = {
      invisibleVisitor: user.privacyInvisibleVisitor,
      mysteryLive: user.privacyMysteryLive,
      mysteryRank: user.privacyMysteryRank,
      invisibleOnline: user.privacyInvisibleOnline,
      hideMicStatus: user.hideMicStatus,
    }

    await cacheService.set(cacheKey, JSON.stringify(settings), PRIVACY_CACHE_TTL_SEC)
    return settings
  },

  async updateLiveMicStatus(
    userId: string,
    hideMicStatus: boolean,
    request?: { ip?: string; headers?: Record<string, string | undefined> },
  ): Promise<PrivacySettings> {
    const user = (await userRepository.findById(userId)) as UserPrivacyRow | null
    if (!user) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    await userRepository.update(userId, {
      hideMicStatus,
      privacyUpdatedAt: new Date(),
    })

    await this.invalidatePrivacyCaches(userId)

    await auditService.log({
      userId,
      actionType: 'USER_LIVE_PRIVACY_UPDATED',
      actionStatus: 'success',
      actionDetails: { hideMicStatus },
      request,
    })

    return this.getUserPrivacySettings(userId)
  },
}
