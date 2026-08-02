import { postRepository } from '../repositories/post.repository'
import { userRepository } from '../repositories/user.repository'
import { AppError } from '../middlewares/errorHandler'
import { storageService } from './storage.service'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { assemblePostResponse } from './post-response.builder'
import { adminMessagingService } from './adminMessaging.service'
import type { AuditMeta } from './follow.service'

export const adminPostService = {
  async listUserPosts(userId: string, cursor: string | null, limit: number) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const posts = await postRepository.findByUserId(userId, cursor, limit + 1)
    const hasMore = posts.length > limit
    const page = hasMore ? posts.slice(0, limit) : posts
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null

    return {
      posts: page.map((post) => assemblePostResponse(post, { isLiked: false })),
      nextCursor,
      hasMore,
    }
  },

  async getPostDetail(postId: string) {
    const post = await postRepository.findById(postId)
    if (!post) throw new AppError(404, 'Post not found', 'POST_NOT_FOUND')
    const isLiked = false
    return assemblePostResponse(post, { isLiked })
  },

  async deletePost(postId: string, adminUserId: string, meta: AuditMeta) {
    const post = await postRepository.findById(postId)
    if (!post) throw new AppError(404, 'Post not found', 'POST_NOT_FOUND')

    const ownerId = post.user.id
    const { mediaKey, thumbnailKey } = await postRepository.deletePost(postId)

    try {
      await storageService.deleteObject(mediaKey)
    } catch {
      /* best effort */
    }
    if (thumbnailKey) {
      try {
        await storageService.deleteObject(thumbnailKey)
      } catch {
        /* best effort */
      }
    }

    await cacheService.delete(`post:${postId}`)
    await cacheService.delete(`user:posts:${ownerId}`)

    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_POST_DELETED',
      actionStatus: 'success',
      actionDetails: { postId, ownerUserId: ownerId },
      request: meta.request,
      deviceId: meta.deviceId ?? null,
    })
  },

  async warnPostAuthor(params: { postId: string; adminUserId: string; message?: string }) {
    const post = await postRepository.findById(params.postId)
    if (!post) throw new AppError(404, 'Post not found', 'POST_NOT_FOUND')

    return adminMessagingService.sendPlatformWarning({
      targetUserId: post.user.id,
      adminUserId: params.adminUserId,
      message: params.message,
      post: {
        id: post.id,
        caption: post.caption ?? null,
        createdAt: post.createdAt,
        mediaUrl: post.mediaUrl,
        thumbnailUrl: post.thumbnailUrl,
        mediaType: post.mediaType,
      },
    })
  },

  async suspendPosting(userId: string, suspendedUntil: Date, adminUserId: string) {
    if (suspendedUntil <= new Date()) {
      throw new AppError(400, 'suspendedUntil must be in the future', 'INVALID_REQUEST')
    }
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    await userRepository.update(userId, {
      postingSuspendedUntil: suspendedUntil,
      postingBanned: false,
    })

    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_POSTING_SUSPENDED',
      actionStatus: 'success',
      actionDetails: { targetUserId: userId, suspendedUntil: suspendedUntil.toISOString() },
    })

    return {
      ok: true as const,
      userId,
      postingSuspendedUntil: suspendedUntil.toISOString(),
      postingBanned: false,
    }
  },

  async banPosting(userId: string, adminUserId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    await userRepository.update(userId, {
      postingBanned: true,
      postingSuspendedUntil: null,
    })

    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_POSTING_BANNED',
      actionStatus: 'success',
      actionDetails: { targetUserId: userId },
    })

    return { ok: true as const, userId, postingBanned: true, postingSuspendedUntil: null }
  },

  async restorePosting(userId: string, adminUserId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    await userRepository.update(userId, {
      postingBanned: false,
      postingSuspendedUntil: null,
    })

    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_POSTING_RESTORED',
      actionStatus: 'success',
      actionDetails: { targetUserId: userId },
    })

    return { ok: true as const, userId, postingBanned: false, postingSuspendedUntil: null }
  },
}
