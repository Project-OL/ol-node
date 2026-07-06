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
import { isBlockedEitherWay } from '../utils/block-relationship'

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
      : (user.firstName ?? user.lastName)
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

type VisitRowLike = {
  user: {
    id: string
    publicId: bigint
    defaultPublicId: bigint
    currentVipPublicId: bigint | null
    isAgent: boolean
    username: string
    firstName: string | null
    lastName: string | null
    avatarUrl: string | null
    gender: string | null
    dateOfBirth: Date | null
    country: string | null
  }
  visit: { visitedAt: Date }
}

/**
 * Shared card builder for visitors / visit-history. Batched enrichment: one
 * Redis pipeline + one DB query per lookup kind instead of two per list item.
 */
async function buildVisitCards(items: VisitRowLike[]): Promise<UserCardWithVisit[]> {
  const userIds = items.map((i) => i.user.id)

  const [levels, subscriberCounts, superHostMap, guardianMap] = await Promise.all([
    walletLevelService.getDisplayLevelsForUsers(userIds),
    userSubscriberRepository.countSubscribersForCreators(userIds),
    superHostService.isSuperHostBulk(userIds),
    guardianService.getActiveGuardianSummariesBulk(userIds),
  ])

  return items.map((row) => {
    const user = row.user
    const level = levels.get(user.id)
    const subscriberCount = subscriberCounts.get(user.id) ?? 0
    const displayName = buildDisplayName(user)
    const age = computeAge(user.dateOfBirth)

    return {
      id: user.id,
      userId: user.id,
      username: user.username,
      publicId: String(user.publicId),
      displayPublicId: String(user.currentVipPublicId ?? user.defaultPublicId ?? user.publicId),
      isAgency: Boolean(user.isAgent),
      name: displayName,
      displayName,
      avatarUrl: user.avatarUrl,
      country: user.country ?? null,
      gender: user.gender,
      age,
      livestreamLevel: level?.livestreamLevel ?? 0,
      wealthLevel: level?.wealthLevel ?? 0,
      subscriberCount,
      isFollowing: false,
      isFollowedBy: false,
      isFriend: false,
      isSuperHost: superHostMap.get(user.id) ?? false,
      activeGuardian: guardianMap.get(user.id) ?? null,
      visitedAt: row.visit.visitedAt,
    }
  })
}

export const visitorService = {
  async recordVisit(profileId: string, visitorId: string, meta: AuditMeta): Promise<void> {
    if (profileId === visitorId) {
      return
    }

    if (await isBlockedEitherWay(profileId, visitorId)) {
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

    const cards = await buildVisitCards(items)

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

    const cards = await buildVisitCards(items)

    return {
      items: cards,
      nextCursor,
      total,
    }
  },
}
