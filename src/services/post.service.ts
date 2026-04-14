import crypto from 'crypto'
import { PostVisibility } from '@prisma/client'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { postRepository } from '../repositories/post.repository'
import { followRepository } from '../repositories/follow.repository'
import { storageService } from './storage.service'
import { AppError } from '../middlewares/errorHandler'
import type { AuditMeta } from './follow.service'
import type { CreatePostDto, PostAuthor, PostResponse, TaggedUser } from '../types/post.types'
import { subscriptionService } from './subscription.service'

function buildMediaKeyRegex(userId: string): RegExp {
  const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // posts/{userId}/{uuid}.{ext}
  return new RegExp(
    `^posts\\/${escapedUserId}\\/[a-z0-9-]+\\.(jpg|jpeg|png|webp)$`,
  )
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

function toTaggedUser(user: {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  avatarUrl: string | null
}): TaggedUser {
  const fullName =
    user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName ?? user.lastName
  const trimmed = fullName?.trim()
  const displayName = trimmed && trimmed.length > 0 ? trimmed : user.username

  return {
    userId: user.id,
    displayName,
    publicId: String(user.publicId),
    avatarUrl: user.avatarUrl,
  }
}

function toPostAuthor(user: {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  avatarUrl: string | null
  gender: string | null
  dateOfBirth: Date | null
}): PostAuthor {
  return {
    ...toTaggedUser(user),
    gender: user.gender,
    age: computeAge(user.dateOfBirth),
  }
}

function assemblePostResponse(
  post: NonNullable<Awaited<ReturnType<typeof postRepository.findById>>>,
  options: { isLiked: boolean },
): PostResponse {
  const author = toPostAuthor(post.user)
  const tags: TaggedUser[] = post.tags.map((tag) => toTaggedUser(tag.taggedUser))

  return {
    postId: post.id,
    mediaUrl: post.mediaUrl,
    caption: post.caption ?? null,
    visibility: post.visibility,
    likesCount: post.likesCount,
    isLiked: options.isLiked,
    tags,
    author,
    createdAt: post.createdAt,
    subscriberOnly: post.subscriberOnly,
  }
}

function assembleLockedPostResponse(
  post: NonNullable<Awaited<ReturnType<typeof postRepository.findById>>>,
  options: { isLiked: boolean },
): PostResponse {
  const author = toPostAuthor(post.user)
  return {
    postId: post.id,
    mediaUrl: '',
    caption: null,
    visibility: post.visibility,
    likesCount: post.likesCount,
    isLiked: options.isLiked,
    tags: [],
    author,
    createdAt: post.createdAt,
    subscriberOnly: post.subscriberOnly,
    locked: true,
    previewUrl: null,
  }
}

async function canViewSubscriberOnlyPost(
  post: NonNullable<Awaited<ReturnType<typeof postRepository.findById>>>,
  requesterId: string,
): Promise<boolean> {
  if (!post.subscriberOnly) {
    return true
  }
  if (post.user.id === requesterId) {
    return true
  }
  return subscriptionService.checkAccess(requesterId, post.user.id)
}

export const postService = {
  async generateUploadUrl(
    userId: string,
    fileName: string,
    mimeType: string,
  ): Promise<{ uploadUrl: string; mediaKey: string }> {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'] as const
    if (!allowed.includes(mimeType as (typeof allowed)[number])) {
      throw new AppError(400, 'Invalid mime type', 'INVALID_MIME_TYPE')
    }

    const ext = (() => {
      switch (mimeType) {
        case 'image/jpeg':
          return 'jpg'
        case 'image/png':
          return 'png'
        case 'image/webp':
          return 'webp'
        default:
          return null
      }
    })()

    if (!ext) {
      throw new AppError(400, 'Invalid mime type', 'INVALID_MIME_TYPE')
    }

    const safeName = fileName.split('/').pop() ?? fileName
    if (safeName.length === 0) {
      throw new AppError(400, 'Invalid file name', 'INVALID_FILE_NAME')
    }

    const key = `posts/${userId}/${crypto.randomUUID()}.${ext}`
    const uploadUrl = await storageService.getPresignedPutUrl(key, mimeType, 600)

    return { uploadUrl, mediaKey: key }
  },

  async createPost(
    userId: string,
    dto: CreatePostDto,
    meta: AuditMeta,
  ): Promise<PostResponse> {
    const {
      mediaKey,
      caption,
      visibility = PostVisibility.SUBSCRIBERS_ONLY,
      taggedUserIds,
      subscriberOnly = false,
    } = dto

    const regex = buildMediaKeyRegex(userId)
    if (!regex.test(mediaKey)) {
      throw new AppError(400, 'Invalid media key', 'INVALID_MEDIA_KEY')
    }

    if (taggedUserIds && taggedUserIds.length > 10) {
      throw new AppError(400, 'Too many tagged users (max 10)', 'TOO_MANY_TAGS')
    }

    if (taggedUserIds && taggedUserIds.length > 0) {
      const invalidIds: string[] = []
      await Promise.all(
        taggedUserIds.map(async (taggedUserId) => {
          const follows = await followRepository.existsFollow(userId, taggedUserId)
          if (!follows) {
            invalidIds.push(taggedUserId)
          }
        }),
      )
      if (invalidIds.length > 0) {
        throw new AppError(
          400,
          'One or more tagged users are not followed by the poster',
          'INVALID_TAG_USERS',
          { invalidUserIds: invalidIds },
        )
      }
    }

    const mediaUrl = storageService.getPublicUrl(mediaKey)

    const post = await postRepository.createPost({
      userId,
      mediaKey,
      mediaUrl,
      caption,
      visibility,
      subscriberOnly,
    })

    if (dto.taggedUserIds && dto.taggedUserIds.length > 0) {
      await postRepository.createTags(post.id, dto.taggedUserIds)
    }

    await cacheService.delete(`user:posts:${userId}`)

    const fullPost = await postRepository.findById(post.id)
    if (!fullPost) {
      throw new AppError(500, 'Post data missing after creation', 'POST_ASSEMBLY_ERROR')
    }

    await auditService.log({
      userId,
      actionType: 'POST_CREATED',
      actionStatus: 'success',
      actionDetails: {
        postId: post.id,
        visibility,
        tagCount: dto.taggedUserIds?.length ?? 0,
      },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })

    return assemblePostResponse(fullPost, { isLiked: false })
  },

  async getPost(postId: string, requesterId: string): Promise<PostResponse> {
    const post = await postRepository.findById(postId)
    if (!post) {
      throw new AppError(404, 'Post not found', 'POST_NOT_FOUND')
    }

    const isLiked = await postRepository.existsLike(postId, requesterId)

    if (post.subscriberOnly) {
      const allowed = await canViewSubscriberOnlyPost(post, requesterId)
      if (!allowed) {
        return assembleLockedPostResponse(post, { isLiked })
      }
    }

    const cacheKey = `post:${postId}`
    if (!post.subscriberOnly) {
      const cached = await cacheService.get(cacheKey)
      if (cached) {
        const parsed = JSON.parse(cached) as PostResponse
        return { ...parsed, isLiked, subscriberOnly: parsed.subscriberOnly ?? false }
      }
    }

    const response = assemblePostResponse(post, { isLiked })
    if (!post.subscriberOnly) {
      await cacheService.set(cacheKey, JSON.stringify(response), 300)
    }
    return response
  },

  async getPostsByUser(
    userId: string,
    requesterId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ posts: PostResponse[]; nextCursor: string | null }> {
    const posts = await postRepository.findByUserId(userId, cursor, limit)
    if (posts.length === 0) {
      return { posts: [], nextCursor: null }
    }

    const postIds = posts.map((p) => p.id)
    const likedSet = await postRepository.batchExistsLike(postIds, requesterId)

    const responses: PostResponse[] = []
    for (const post of posts) {
      const isLiked = likedSet.has(post.id)
      if (post.subscriberOnly) {
        const allowed = await canViewSubscriberOnlyPost(post, requesterId)
        responses.push(
          allowed
            ? assemblePostResponse(post, { isLiked })
            : assembleLockedPostResponse(post, { isLiked }),
        )
      } else {
        responses.push(assemblePostResponse(post, { isLiked }))
      }
    }
    const nextCursorValue = posts.length === limit ? posts[posts.length - 1]?.id ?? null : null

    return { posts: responses, nextCursor: nextCursorValue }
  },

  async deletePost(postId: string, requesterId: string, meta: AuditMeta): Promise<void> {
    const post = await postRepository.findById(postId)
    if (!post) {
      throw new AppError(404, 'Post not found', 'POST_NOT_FOUND')
    }
    if (post.user.id !== requesterId) {
      throw new AppError(403, 'Forbidden', 'FORBIDDEN')
    }

    const { mediaKey } = await postRepository.deletePost(postId)

    try {
      await storageService.deleteObject(mediaKey)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to delete media from storage', { mediaKey, error: err })
    }

    await cacheService.delete(`post:${postId}`)
    await cacheService.delete(`user:posts:${requesterId}`)

    await auditService.log({
      userId: requesterId,
      actionType: 'POST_DELETED',
      actionStatus: 'success',
      actionDetails: { postId },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })
  },

  async likePost(
    postId: string,
    userId: string,
    meta: AuditMeta,
  ): Promise<{ likesCount: number; isLiked: boolean }> {
    const post = await postRepository.findById(postId)
    if (!post) {
      throw new AppError(404, 'Post not found', 'POST_NOT_FOUND')
    }
    if (post.user.id === userId) {
      throw new AppError(400, 'Cannot like own post', 'CANNOT_LIKE_OWN_POST')
    }

    const { likesCount } = await postRepository.likePost(postId, userId)

    await cacheService.delete(`post:${postId}`)

    await auditService.log({
      userId,
      actionType: 'POST_LIKED',
      actionStatus: 'success',
      actionDetails: { postId },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })

    return { likesCount, isLiked: true }
  },

  async unlikePost(
    postId: string,
    userId: string,
    meta: AuditMeta,
  ): Promise<{ likesCount: number; isLiked: boolean }> {
    const { likesCount } = await postRepository.unlikePost(postId, userId)

    await cacheService.delete(`post:${postId}`)

    await auditService.log({
      userId,
      actionType: 'POST_UNLIKED',
      actionStatus: 'success',
      actionDetails: { postId },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })

    return { likesCount, isLiked: false }
  },

  async searchTaggableUsers(requesterId: string, query: string): Promise<TaggedUser[]> {
    const results = await followRepository.searchFollowing(requesterId, query, 10)
    return results
  },
}

