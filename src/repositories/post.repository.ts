import type { Post, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import type { FeedCursor } from '../utils/cursor'

export type PostWithRelations = Prisma.PostGetPayload<{
  include: {
    tags: {
      include: {
        taggedUser: {
          select: {
            id: true
            username: true
            firstName: true
            lastName: true
            publicId: true
            avatarUrl: true
          }
        }
      }
    }
    user: {
      select: {
        id: true
        username: true
        firstName: true
        lastName: true
        publicId: true
        avatarUrl: true
        gender: true
        dateOfBirth: true
      }
    }
  }
}>

type TransactionClient = Prisma.TransactionClient

export const postRepository = {
  async createPost(data: {
    userId: string
    mediaKey: string
    mediaUrl: string
    mediaType: 'IMAGE' | 'VIDEO'
    thumbnailKey?: string | null
    thumbnailUrl?: string | null
    caption?: string
    visibility: Post['visibility']
    subscriberOnly?: boolean
  }): Promise<Post> {
    return prisma.post.create({
      data: {
        userId: data.userId,
        mediaKey: data.mediaKey,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
        thumbnailKey: data.thumbnailKey ?? null,
        thumbnailUrl: data.thumbnailUrl ?? null,
        caption: data.caption,
        visibility: data.visibility,
        subscriberOnly: data.subscriberOnly ?? false,
      },
    })
  },

  async createTags(postId: string, taggedUserIds: string[]): Promise<void> {
    if (taggedUserIds.length === 0) return
    await prisma.postTag.createMany({
      data: taggedUserIds.map((taggedUserId) => ({
        postId,
        taggedUserId,
      })),
      skipDuplicates: true,
    })
  },

  async findById(postId: string): Promise<PostWithRelations | null> {
    return prismaRead.post.findUnique({
      where: { id: postId },
      include: {
        tags: {
          include: {
            taggedUser: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                publicId: true,
                avatarUrl: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            avatarUrl: true,
            gender: true,
            dateOfBirth: true,
          },
        },
      },
    })
  },

  async getSubscriptionFeed(
    creatorUserIds: string[],
    limit: number,
    cursor?: FeedCursor,
  ): Promise<PostWithRelations[]> {
    if (creatorUserIds.length === 0) {
      return []
    }

    const where: Prisma.PostWhereInput = {
      userId: { in: creatorUserIds },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              {
                createdAt: new Date(cursor.createdAt),
                id: { lt: cursor.postId },
              },
            ],
          }
        : {}),
    }

    return prismaRead.post.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        tags: {
          include: {
            taggedUser: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                publicId: true,
                avatarUrl: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            avatarUrl: true,
            gender: true,
            dateOfBirth: true,
          },
        },
      },
    })
  },

  async findByUserId(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PostWithRelations[]> {
    return prismaRead.post.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      take: limit,
      include: {
        tags: {
          include: {
            taggedUser: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                publicId: true,
                avatarUrl: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            avatarUrl: true,
            gender: true,
            dateOfBirth: true,
          },
        },
      },
    })
  },

  async deletePost(postId: string): Promise<{ mediaKey: string; thumbnailKey: string | null }> {
    const deleted = await prisma.post.delete({
      where: { id: postId },
      select: { mediaKey: true, thumbnailKey: true },
    })
    return { mediaKey: deleted.mediaKey, thumbnailKey: deleted.thumbnailKey }
  },

  async existsLike(postId: string, userId: string): Promise<boolean> {
    const count = await prismaRead.postLike.count({
      where: { postId, userId },
    })
    return count > 0
  },

  async upsertLike(
    postId: string,
    userId: string,
    tx: TransactionClient,
  ): Promise<{ created: boolean }> {
    const existing = await tx.postLike.findUnique({
      where: {
        postId_userId: {
          postId,
          userId,
        },
      },
    })
    if (existing) {
      return { created: false }
    }
    await tx.postLike.create({
      data: {
        postId,
        userId,
      },
    })
    return { created: true }
  },

  async deleteLike(
    postId: string,
    userId: string,
    tx: TransactionClient,
  ): Promise<{ deleted: boolean }> {
    const result = await tx.postLike.deleteMany({
      where: { postId, userId },
    })
    return { deleted: result.count > 0 }
  },

  async incrementLikes(postId: string, tx: TransactionClient): Promise<void> {
    await tx.post.update({
      where: { id: postId },
      data: {
        likesCount: {
          increment: 1,
        },
      },
    })
  },

  async decrementLikes(postId: string, tx: TransactionClient): Promise<void> {
    await tx.post.updateMany({
      where: {
        id: postId,
        likesCount: {
          gt: 0,
        },
      },
      data: {
        likesCount: {
          decrement: 1,
        },
      },
    })
  },

  async batchExistsLike(postIds: string[], userId: string): Promise<Set<string>> {
    if (postIds.length === 0) {
      return new Set()
    }
    const likes = await prismaRead.postLike.findMany({
      where: {
        postId: { in: postIds },
        userId,
      },
      select: { postId: true },
    })
    return new Set(likes.map((l: { postId: string }) => l.postId))
  },

  async likePost(
    postId: string,
    userId: string,
  ): Promise<{ likesCount: number; created: boolean }> {
    const result = await prisma.$transaction(async (tx) => {
      const upsertResult = await postRepository.upsertLike(postId, userId, tx)
      if (upsertResult.created) {
        await postRepository.incrementLikes(postId, tx)
      }
      const refreshed = await tx.post.findUnique({
        where: { id: postId },
        select: { likesCount: true },
      })
      return {
        likesCount: refreshed?.likesCount ?? 0,
        created: upsertResult.created,
      }
    })

    return result
  },

  async unlikePost(
    postId: string,
    userId: string,
  ): Promise<{ likesCount: number; deleted: boolean }> {
    const result = await prisma.$transaction(async (tx) => {
      const deleteResult = await postRepository.deleteLike(postId, userId, tx)
      if (deleteResult.deleted) {
        await postRepository.decrementLikes(postId, tx)
      }
      const refreshed = await tx.post.findUnique({
        where: { id: postId },
        select: { likesCount: true },
      })
      return {
        likesCount: refreshed?.likesCount ?? 0,
        deleted: deleteResult.deleted,
      }
    })

    return result
  },
}

