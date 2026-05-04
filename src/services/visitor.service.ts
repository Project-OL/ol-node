import { RedisKeys, redisClient } from '../config/redis'
import { auditService } from './audit.service'
import { visitorRepository } from '../repositories/visitor.repository'
import { userRepository } from '../repositories/user.repository'
import { walletLevelService } from './user-level.service'
import { userSubscriberRepository } from '../repositories/userSubscriber.repository'
import type { PaginatedResult, UserCardWithVisit } from '../types/social.types'
import { superHostService } from './super-host.service'
import { guardianService } from './guardian.service'
import { privacyService } from './privacy.service'

export interface AuditMeta {
  request?: { ip?: string; headers?: Record<string, string | undefined> }
  deviceId?: string | null
}

function buildDisplayName(user: {
  username: string
  firstName: string | null
  lastName: string | null
}): string {
  const fullName =
    user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName ?? user.lastName
  const trimmed = fullName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : user.username
}

function computeAge(dob: Date | null): number | null {
  if (!dob) return null
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const m = today.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
    age--
  }
  return age >= 0 ? age : null
}

export const visitorService = {
  async recordVisit(
    profileId: string,
    visitorId: string,
    meta: AuditMeta,
  ): Promise<void> {
    if (profileId === visitorId) {
      return
    }

    const visitor = await userRepository.findById(visitorId)
    if (!visitor) {
      return
    }
    const eff = await privacyService.getEffectiveFlags(visitorId)
    if (eff.invisibleVisitor) {
      return
    }

    const cooldownKey = RedisKeys.visitorCooldown(profileId, visitorId)
    const existing = await redisClient.get(cooldownKey)
    if (existing) {
      return
    }

    const result = await visitorRepository.upsertVisitor(profileId, visitorId)
    if (result.isNew) {
      await visitorRepository.trimVisitors(profileId)
    }

    await redisClient.set(cooldownKey, '1', 'EX', 300)

    await auditService.log({
      userId: visitorId,
      actionType: 'PROFILE_VISITED',
      actionStatus: 'success',
      actionDetails: { profileId, visitorId },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })
  },

  async getVisitors(
    profileId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PaginatedResult<UserCardWithVisit>> {
    const { items, nextCursor, total } = await visitorRepository.findVisitors(
      profileId,
      cursor,
      limit,
    )

    const users = items.map((i) => i.user)
    const userIds = users.map((u) => u.id)

    const levels = await walletLevelService.getDisplayLevelsForUsers(userIds)

    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators(userIds)

    const cards: UserCardWithVisit[] = await Promise.all(items.map(async (row) => {
      const user = row.user
      const [isSuperHost, activeGuardian] = await Promise.all([
        superHostService.isSuperHost(user.id),
        guardianService.getActiveGuardianSummary(user.id),
      ])
      const level = levels.get(user.id)
      const livestreamLevel = level?.livestreamLevel ?? 0
      const wealthLevel = level?.wealthLevel ?? 0
      const subscriberCount = subscriberCounts.get(user.id) ?? 0
      const displayName = buildDisplayName(user)
      const age = computeAge(user.dateOfBirth)

      return {
        id: user.id,
        userId: user.id,
        username: user.username,
        publicId: String(user.publicId),
        name: displayName,
        displayName,
        avatarUrl: user.avatarUrl,
        country: user.country ?? null,
        gender: user.gender,
        age,
        livestreamLevel,
        wealthLevel,
        subscriberCount,
        isFollowing: false,
        isFollowedBy: false,
        isFriend: false,
        isSuperHost,
        activeGuardian,
        visitedAt: row.visit.visitedAt,
      }
    }))

    return {
      items: cards,
      nextCursor,
      total,
    }
  },

  async getVisitHistory(
    visitorId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PaginatedResult<UserCardWithVisit>> {
    const { items, nextCursor, total } = await visitorRepository.findVisitHistory(
      visitorId,
      cursor,
      limit,
    )

    const users = items.map((i) => i.user)
    const userIds = users.map((u) => u.id)

    const levels = await walletLevelService.getDisplayLevelsForUsers(userIds)

    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators(userIds)

    const cards: UserCardWithVisit[] = await Promise.all(items.map(async (row) => {
      const user = row.user
      const [isSuperHost, activeGuardian] = await Promise.all([
        superHostService.isSuperHost(user.id),
        guardianService.getActiveGuardianSummary(user.id),
      ])
      const level = levels.get(user.id)
      const livestreamLevel = level?.livestreamLevel ?? 0
      const wealthLevel = level?.wealthLevel ?? 0
      const subscriberCount = subscriberCounts.get(user.id) ?? 0
      const displayName = buildDisplayName(user)
      const age = computeAge(user.dateOfBirth)

      return {
        id: user.id,
        userId: user.id,
        username: user.username,
        publicId: String(user.publicId),
        name: displayName,
        displayName,
        avatarUrl: user.avatarUrl,
        country: user.country ?? null,
        gender: user.gender,
        age,
        livestreamLevel,
        wealthLevel,
        subscriberCount,
        isFollowing: false,
        isFollowedBy: false,
        isFriend: false,
        isSuperHost,
        activeGuardian,
        visitedAt: row.visit.visitedAt,
      }
    }))

    return {
      items: cards,
      nextCursor,
      total,
    }
  },
}

