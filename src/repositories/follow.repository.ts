import { prisma, prismaRead } from '../config/database'
import type { UserFollow, User } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import type { TaggedUser } from '../types/post.types'

interface FollowWithUser {
  follow: UserFollow
  user: Pick<
    User,
    | 'id'
    | 'publicId'
    | 'defaultPublicId'
    | 'currentVipPublicId'
    | 'isAgent'
    | 'username'
    | 'firstName'
    | 'lastName'
    | 'avatarUrl'
    | 'country'
    | 'gender'
    | 'dateOfBirth'
  >
  isFollowing: boolean
  isFollowedBy: boolean
}

function toBool(count: number): boolean {
  return count > 0
}

export const followRepository = {
  async upsertFollow(followerId: string, followingId: string): Promise<UserFollow> {
    return prisma.userFollow.upsert({
      where: {
        followerId_followingId: {
          followerId,
          followingId,
        },
      },
      update: {},
      create: {
        followerId,
        followingId,
      },
    })
  },

  async deleteFollow(followerId: string, followingId: string): Promise<void> {
    const existing = await prismaRead.userFollow.findUnique({
      where: {
        followerId_followingId: {
          followerId,
          followingId,
        },
      },
    })
    if (!existing) {
      throw new AppError(404, 'Not following user', 'NOT_FOLLOWING')
    }
    await prisma.userFollow.delete({
      where: {
        followerId_followingId: {
          followerId,
          followingId,
        },
      },
    })
  },

  async existsFollow(followerId: string, followingId: string): Promise<boolean> {
    const count = await prismaRead.userFollow.count({
      where: { followerId, followingId },
    })
    return toBool(count)
  },

  async findFollowers(
    userId: string,
    requesterId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: FollowWithUser[]; nextCursor: string | null; total: number }> {
    const where = { followingId: userId }
    const follows = await prismaRead.userFollow.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      take: limit,
      include: {
        follower: {
          select: {
            id: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            isAgent: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            country: true,
            gender: true,
            dateOfBirth: true,
          },
        },
      },
    })

    const total = await prismaRead.userFollow.count({ where })

    const userIds = follows.map((f) => f.followerId)
    const relations = await prismaRead.userFollow.findMany({
      where: {
        OR: [
          { followerId: requesterId, followingId: { in: userIds } },
          { followerId: { in: userIds }, followingId: requesterId },
        ],
      },
    })

    const followsByRequester = new Set(
      relations.filter((r) => r.followerId === requesterId).map((r) => r.followingId),
    )
    const followedByRequester = new Set(
      relations.filter((r) => r.followingId === requesterId).map((r) => r.followerId),
    )

    const items: FollowWithUser[] = follows.map((row) => {
      const user = row.follower
      const isFollowing = followsByRequester.has(user.id)
      const isFollowedBy = followedByRequester.has(user.id)
      return {
        follow: row,
        user,
        isFollowing,
        isFollowedBy,
      }
    })

    const nextCursor = follows.length === limit ? (follows[follows.length - 1]?.id ?? null) : null
    return { items, nextCursor, total }
  },

  async findFollowing(
    userId: string,
    requesterId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: FollowWithUser[]; nextCursor: string | null; total: number }> {
    const where = { followerId: userId }
    const follows = await prismaRead.userFollow.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      take: limit,
      include: {
        following: {
          select: {
            id: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            isAgent: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            country: true,
            gender: true,
            dateOfBirth: true,
          },
        },
      },
    })

    const total = await prismaRead.userFollow.count({ where })

    const userIds = follows.map((f) => f.followingId)
    const relations = await prismaRead.userFollow.findMany({
      where: {
        OR: [
          { followerId: requesterId, followingId: { in: userIds } },
          { followerId: { in: userIds }, followingId: requesterId },
        ],
      },
    })

    const followsByRequester = new Set(
      relations.filter((r) => r.followerId === requesterId).map((r) => r.followingId),
    )
    const followedByRequester = new Set(
      relations.filter((r) => r.followingId === requesterId).map((r) => r.followerId),
    )

    const items: FollowWithUser[] = follows.map((row) => {
      const user = row.following
      const isFollowing = followsByRequester.has(user.id)
      const isFollowedBy = followedByRequester.has(user.id)
      return {
        follow: row,
        user,
        isFollowing,
        isFollowedBy,
      }
    })

    const nextCursor = follows.length === limit ? (follows[follows.length - 1]?.id ?? null) : null
    return { items, nextCursor, total }
  },

  async findFriends(
    userId: string,
    requesterId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: FollowWithUser[]; nextCursor: string | null; total: number }> {
    const follows = await prismaRead.userFollow.findMany({
      where: {
        followerId: userId,
        following: {
          followers: {
            some: { followerId: { equals: userId } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      take: limit,
      include: {
        following: {
          select: {
            id: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            isAgent: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            country: true,
            gender: true,
            dateOfBirth: true,
          },
        },
      },
    })

    const whereFriends = {
      followerId: userId,
      following: {
        followers: {
          some: { followerId: { equals: userId } },
        },
      },
    }
    const total = await prismaRead.userFollow.count({ where: whereFriends })

    const userIds = follows.map((f) => f.followingId)
    const relations = await prismaRead.userFollow.findMany({
      where: {
        OR: [
          { followerId: requesterId, followingId: { in: userIds } },
          { followerId: { in: userIds }, followingId: requesterId },
        ],
      },
    })
    const followsByRequester = new Set(
      relations.filter((r) => r.followerId === requesterId).map((r) => r.followingId),
    )
    const followedByRequester = new Set(
      relations.filter((r) => r.followingId === requesterId).map((r) => r.followerId),
    )

    const items: FollowWithUser[] = follows.map((row) => {
      const user = row.following
      const isFollowing = followsByRequester.has(user.id)
      const isFollowedBy = followedByRequester.has(user.id)
      return {
        follow: row,
        user,
        isFollowing,
        isFollowedBy,
      }
    })

    const nextCursor = follows.length === limit ? (follows[follows.length - 1]?.id ?? null) : null
    return { items, nextCursor, total }
  },

  async countFollowers(userId: string): Promise<number> {
    return prismaRead.userFollow.count({ where: { followingId: userId } })
  },

  async countFollowing(userId: string): Promise<number> {
    return prismaRead.userFollow.count({ where: { followerId: userId } })
  },

  /** Lightweight: IDs only, for messaging privacy checks. Cap at 500. */
  async getFollowingIds(followerId: string, limit = 500): Promise<string[]> {
    const rows = await prismaRead.userFollow.findMany({
      where: { followerId },
      select: { followingId: true },
      take: limit,
    })
    return rows.map((r) => r.followingId)
  },

  /** Lightweight: mutual friend IDs only, for messaging privacy checks. Cap at 500. */
  async getFriendIds(userId: string, limit = 500): Promise<string[]> {
    const rows = await prismaRead.userFollow.findMany({
      where: {
        followerId: userId,
        following: {
          followers: { some: { followerId: userId } },
        },
      },
      select: { followingId: true },
      take: limit,
    })
    return rows.map((r) => r.followingId)
  },

  async countFriends(userId: string): Promise<number> {
    const friends = await prismaRead.userFollow.findMany({
      where: {
        followerId: userId,
        following: {
          followers: {
            some: { followerId: { equals: userId } },
          },
        },
      },
      select: { followingId: true },
    })
    const friendIds = new Set(friends.map((f) => f.followingId))
    return friendIds.size
  },

  async searchFollowing(followerId: string, query: string, limit: number): Promise<TaggedUser[]> {
    const isNumeric = /^\d+$/.test(query)
    const users = await prismaRead.user.findMany({
      where: {
        followers: {
          some: {
            followerId,
          },
        },
        OR: [
          { username: { contains: query, mode: 'insensitive' } },
          { firstName: { contains: query, mode: 'insensitive' } },
          { lastName: { contains: query, mode: 'insensitive' } },
          ...(isNumeric
            ? [
                {
                  publicId: {
                    equals: BigInt(query),
                  },
                } as const,
              ]
            : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        publicId: true,
        avatarUrl: true,
      },
    })

    return users.map((user) => {
      const fullName =
        user.firstName && user.lastName
          ? `${user.firstName} ${user.lastName}`
          : (user.firstName ?? user.lastName)
      const trimmed = fullName?.trim()
      const displayName = trimmed && trimmed.length > 0 ? trimmed : user.username

      return {
        userId: user.id,
        displayName,
        publicId: String(user.publicId),
        avatarUrl: user.avatarUrl,
      }
    })
  },
}
