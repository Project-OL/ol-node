import { RedisKeys, redisClient } from '../config/redis'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { followRepository } from '../repositories/follow.repository'
import { walletLevelService } from './user-level.service'
import { userSubscriberRepository } from '../repositories/userSubscriber.repository'
import type { PaginatedResult, UserCard } from '../types/social.types'
import { AppError } from '../middlewares/errorHandler'
import { superHostService } from './super-host.service'
import { guardianService } from './guardian.service'

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

async function toUserCards(
  items: {
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
    isFollowing: boolean
    isFollowedBy: boolean
  }[],
  levels: Map<string, { livestreamLevel: number; wealthLevel: number }>,
  subscriberCounts: Map<string, number>,
): Promise<UserCard[]> {
  const decorated = await Promise.all(
    items.map(async ({ user, isFollowing, isFollowedBy }) => {
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
      const isFriend = isFollowing && isFollowedBy

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
        livestreamLevel,
        wealthLevel,
        subscriberCount,
        isFollowing,
        isFollowedBy,
        isFriend,
        isSuperHost,
        activeGuardian,
      }
    }),
  )
  return decorated
}

/** Bust cached followers/following/friends for one or more users (primary Redis). */
export async function invalidateSocialCountsCache(...userIds: string[]): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))]
  await Promise.all(unique.map((id) => cacheService.delete(RedisKeys.socialCounts(id))))
}

export const followService = {
  async follow(
    followerId: string,
    targetUserId: string,
    meta: AuditMeta,
  ): Promise<{ following: boolean; isFriend: boolean }> {
    if (followerId === targetUserId) {
      throw new AppError(400, 'Cannot follow self', 'CANNOT_FOLLOW_SELF')
    }

    const already = await followRepository.existsFollow(followerId, targetUserId)
    if (already) {
      throw new AppError(409, 'Already following user', 'ALREADY_FOLLOWING')
    }

    await followRepository.upsertFollow(followerId, targetUserId)
    const isFriend = await followRepository.existsFollow(targetUserId, followerId)

    await invalidateSocialCountsCache(followerId, targetUserId)

    await auditService.log({
      userId: followerId,
      actionType: 'USER_FOLLOWED',
      actionStatus: 'success',
      actionDetails: { targetUserId, isFriend },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })

    return { following: true, isFriend }
  },

  async unfollow(followerId: string, targetUserId: string, meta: AuditMeta): Promise<void> {
    await followRepository.deleteFollow(followerId, targetUserId)

    await invalidateSocialCountsCache(followerId, targetUserId)

    await auditService.log({
      userId: followerId,
      actionType: 'USER_UNFOLLOWED',
      actionStatus: 'success',
      actionDetails: { targetUserId },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })
  },

  async getFollowers(
    userId: string,
    requesterId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PaginatedResult<UserCard>> {
    const { items, nextCursor, total } = await followRepository.findFollowers(
      userId,
      requesterId,
      cursor,
      limit,
    )
    const users = items.map((i) => i.user)
    const userIds = users.map((u) => u.id)

    const levels = await walletLevelService.getDisplayLevelsForUsers(userIds)

    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators(userIds)

    const cards = await toUserCards(
      items.map((i) => ({
        user: i.user,
        isFollowing: i.isFollowing,
        isFollowedBy: i.isFollowedBy,
      })),
      levels,
      subscriberCounts,
    )

    return {
      items: cards,
      nextCursor,
      total,
    }
  },

  async getFollowing(
    userId: string,
    requesterId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PaginatedResult<UserCard>> {
    const { items, nextCursor, total } = await followRepository.findFollowing(
      userId,
      requesterId,
      cursor,
      limit,
    )
    const users = items.map((i) => i.user)
    const userIds = users.map((u) => u.id)

    const levels = await walletLevelService.getDisplayLevelsForUsers(userIds)

    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators(userIds)

    const cards = await toUserCards(
      items.map((i) => ({
        user: i.user,
        isFollowing: i.isFollowing,
        isFollowedBy: i.isFollowedBy,
      })),
      levels,
      subscriberCounts,
    )

    return {
      items: cards,
      nextCursor,
      total,
    }
  },

  async getFriends(
    userId: string,
    requesterId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PaginatedResult<UserCard>> {
    const { items, nextCursor, total } = await followRepository.findFriends(
      userId,
      requesterId,
      cursor,
      limit,
    )
    const users = items.map((i) => i.user)
    const userIds = users.map((u) => u.id)

    const levels = await walletLevelService.getDisplayLevelsForUsers(userIds)

    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators(userIds)

    const cards = await toUserCards(
      items.map((i) => ({
        user: i.user,
        isFollowing: i.isFollowing,
        isFollowedBy: i.isFollowedBy,
      })),
      levels,
      subscriberCounts,
    )

    return {
      items: cards,
      nextCursor,
      total,
    }
  },

  async getCounts(userId: string): Promise<{
    followers: number
    following: number
    friends: number
  }> {
    const cacheKey = RedisKeys.socialCounts(userId)
    // Read from primary so invalidations are visible immediately (read replica can lag).
    let cached: string | null = null
    try {
      cached = await redisClient.get(cacheKey)
    } catch {
      cached = null
    }
    if (cached) {
      return JSON.parse(cached) as {
        followers: number
        following: number
        friends: number
      }
    }

    const [followers, following, friends] = await Promise.all([
      followRepository.countFollowers(userId),
      followRepository.countFollowing(userId),
      followRepository.countFriends(userId),
    ])

    const payload = { followers, following, friends }
    await cacheService.set(cacheKey, JSON.stringify(payload), 300)
    return payload
  },
}
