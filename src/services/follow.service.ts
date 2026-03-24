import { RedisKeys } from '../config/redis'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { followRepository } from '../repositories/follow.repository'
import { userLevelService } from './userLevel.service'
import { userSubscriberRepository } from '../repositories/userSubscriber.repository'
import type { PaginatedResult, UserCard } from '../types/social.types'
import { AppError } from '../middlewares/errorHandler'

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

function toUserCards(
  items: {
    user: {
      id: string
      publicId: bigint
      username: string
      firstName: string | null
      lastName: string | null
      avatarUrl: string | null
      gender: string | null
      dateOfBirth: Date | null
    }
    isFollowing: boolean
    isFollowedBy: boolean
  }[],
  levels: Map<string, { livestreamLevel: number; wealthLevel: number }>,
  subscriberCounts: Map<string, number>,
): UserCard[] {
  return items.map(({ user, isFollowing, isFollowedBy }) => {
    const level = levels.get(user.id)
    const livestreamLevel = level?.livestreamLevel ?? 0
    const wealthLevel = level?.wealthLevel ?? 0
    const subscriberCount = subscriberCounts.get(user.id) ?? 0
    const displayName = buildDisplayName(user)
    const age = computeAge(user.dateOfBirth)
    const isFriend = isFollowing && isFollowedBy

    return {
      userId: user.id,
      publicId: String(user.publicId),
      displayName,
      avatarUrl: user.avatarUrl,
      gender: user.gender,
      age,
      livestreamLevel,
      wealthLevel,
      subscriberCount,
      isFollowing,
      isFollowedBy,
      isFriend,
    }
  })
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

    await cacheService.delete(RedisKeys.socialCounts(followerId))
    await cacheService.delete(RedisKeys.socialCounts(targetUserId))

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

  async unfollow(
    followerId: string,
    targetUserId: string,
    meta: AuditMeta,
  ): Promise<void> {
    await followRepository.deleteFollow(followerId, targetUserId)

    await cacheService.delete(RedisKeys.socialCounts(followerId))
    await cacheService.delete(RedisKeys.socialCounts(targetUserId))

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

    const levelsMap = await userLevelService.getLevelForUsers(userIds)
    const levels = new Map<string, { livestreamLevel: number; wealthLevel: number }>()
    for (const id of userIds) {
      const lvl = levelsMap.get(id)
      levels.set(id, {
        livestreamLevel: lvl?.livestreamLevel ?? 0,
        wealthLevel: lvl?.wealthLevel ?? 0,
      })
    }

    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators(userIds)

    const cards = toUserCards(
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

    const levelsMap = await userLevelService.getLevelForUsers(userIds)
    const levels = new Map<string, { livestreamLevel: number; wealthLevel: number }>()
    for (const id of userIds) {
      const lvl = levelsMap.get(id)
      levels.set(id, {
        livestreamLevel: lvl?.livestreamLevel ?? 0,
        wealthLevel: lvl?.wealthLevel ?? 0,
      })
    }

    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators(userIds)

    const cards = toUserCards(
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

    const levelsMap = await userLevelService.getLevelForUsers(userIds)
    const levels = new Map<string, { livestreamLevel: number; wealthLevel: number }>()
    for (const id of userIds) {
      const lvl = levelsMap.get(id)
      levels.set(id, {
        livestreamLevel: lvl?.livestreamLevel ?? 0,
        wealthLevel: lvl?.wealthLevel ?? 0,
      })
    }

    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators(userIds)

    const cards = toUserCards(
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
    const cached = await cacheService.get(cacheKey)
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

