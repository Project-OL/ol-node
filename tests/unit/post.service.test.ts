import { describe, it, expect, vi, beforeEach } from 'vitest'

const cacheGet = vi.fn()
const cacheSet = vi.fn()
const cacheDelete = vi.fn()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: (...args: unknown[]) => cacheGet(...args),
    set: (...args: unknown[]) => cacheSet(...args),
    delete: (...args: unknown[]) => cacheDelete(...args),
  },
}))

const auditLog = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

const getPresignedPutUrl = vi.fn()
const getPublicUrl = vi.fn()
const deleteObject = vi.fn()
vi.mock('../../src/services/storage.service', () => ({
  storageService: {
    getPresignedPutUrl: (...args: unknown[]) => getPresignedPutUrl(...args),
    getPublicUrl: (...args: unknown[]) => getPublicUrl(...args),
    deleteObject: (...args: unknown[]) => deleteObject(...args),
  },
}))

const existsFollow = vi.fn()
vi.mock('../../src/repositories/follow.repository', () => ({
  followRepository: {
    existsFollow: (...args: unknown[]) => existsFollow(...args),
    searchFollowing: vi.fn(),
  },
}))

const createPostRepo = vi.fn()
const createTags = vi.fn()
const findById = vi.fn()
const deletePostRepo = vi.fn()
const existsLike = vi.fn()
const batchExistsLike = vi.fn()
const likePostRepo = vi.fn()
const unlikePostRepo = vi.fn()
vi.mock('../../src/repositories/post.repository', () => ({
  postRepository: {
    createPost: (...args: unknown[]) => createPostRepo(...args),
    createTags: (...args: unknown[]) => createTags(...args),
    findById: (...args: unknown[]) => findById(...args),
    deletePost: (...args: unknown[]) => deletePostRepo(...args),
    existsLike: (...args: unknown[]) => existsLike(...args),
    batchExistsLike: (...args: unknown[]) => batchExistsLike(...args),
    likePost: (...args: unknown[]) => likePostRepo(...args),
    unlikePost: (...args: unknown[]) => unlikePostRepo(...args),
  },
}))

const { postService } = await import('../../src/services/post.service')

const userId = 'user-1'
const postId = 'post-1'

describe('postService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('generateUploadUrl', () => {
    it('throws INVALID_MIME_TYPE for unsupported mime type', async () => {
      await expect(
        postService.generateUploadUrl(userId, 'file.txt', 'text/plain'),
      ).rejects.toMatchObject({
        code: 'INVALID_MIME_TYPE',
        statusCode: 400,
      })
    })

    it('returns uploadUrl and mediaKey for valid mime type', async () => {
      getPresignedPutUrl.mockResolvedValue('https://s3/upload-url')

      const result = await postService.generateUploadUrl(userId, 'image.jpg', 'image/jpeg')

      expect(getPresignedPutUrl).toHaveBeenCalled()
      expect(result.mediaKey).toMatch(/^posts\/user-1\/.+\.jpg$/)
      expect(result.uploadUrl).toBe('https://s3/upload-url')
    })
  })

  describe('createPost', () => {
    const meta = { request: { ip: '127.0.0.1', headers: {} }, deviceId: 'dev-1' }

    it('throws INVALID_MEDIA_KEY when mediaKey does not match pattern', async () => {
      await expect(
        postService.createPost(
          userId,
          {
            mediaKey: 'invalid/key.jpg',
          },
          meta,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_MEDIA_KEY',
        statusCode: 400,
      })
    })

    it('throws TOO_MANY_TAGS when more than 10 tagged users', async () => {
      const mediaKey = `posts/${userId}/abc.jpg`
      await expect(
        postService.createPost(
          userId,
          {
            mediaKey,
            taggedUserIds: Array.from({ length: 11 }, (_, i) => `user-${i}`),
          },
          meta,
        ),
      ).rejects.toMatchObject({
        code: 'TOO_MANY_TAGS',
        statusCode: 400,
      })
    })

    it('throws INVALID_TAG_USERS when some tagged users are not followed', async () => {
      const mediaKey = `posts/${userId}/abc.jpg`
      existsFollow.mockResolvedValueOnce(false)

      await expect(
        postService.createPost(
          userId,
          {
            mediaKey,
            taggedUserIds: ['other-user'],
          },
          meta,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_TAG_USERS',
        statusCode: 400,
      })
    })

    it('creates post without tags and audits', async () => {
      const mediaKey = `posts/${userId}/abc.jpg`
      const now = new Date()
      getPublicUrl.mockReturnValue('https://cdn/posts/key.jpg')
      createPostRepo.mockResolvedValue({
        id: postId,
        userId,
        mediaKey,
        mediaUrl: 'https://cdn/posts/key.jpg',
        caption: null,
        visibility: 'SUBSCRIBERS_ONLY',
        likesCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      findById.mockResolvedValue({
        id: postId,
        user: {
          id: userId,
          username: 'user',
          firstName: null,
          lastName: null,
          publicId: BigInt(1),
          avatarUrl: null,
        },
        tags: [],
        mediaUrl: 'https://cdn/posts/key.jpg',
        caption: null,
        visibility: 'SUBSCRIBERS_ONLY',
        likesCount: 0,
        createdAt: now,
        updatedAt: now,
      })

      const result = await postService.createPost(
        userId,
        {
          mediaKey,
        },
        meta,
      )

      expect(createPostRepo).toHaveBeenCalled()
      expect(createTags).not.toHaveBeenCalled()
      expect(cacheDelete).toHaveBeenCalledWith(`user:posts:${userId}`)
      expect(result.postId).toBe(postId)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'POST_CREATED',
          actionStatus: 'success',
          userId,
        }),
      )
    })
  })

  describe('deletePost', () => {
    const meta = { request: { ip: '127.0.0.1', headers: {} }, deviceId: 'dev-1' }

    it('throws POST_NOT_FOUND when post does not exist', async () => {
      findById.mockResolvedValue(null)

      await expect(postService.deletePost(postId, userId, meta)).rejects.toMatchObject({
        code: 'POST_NOT_FOUND',
        statusCode: 404,
      })
    })

    it('throws FORBIDDEN when requester is not owner', async () => {
      findById.mockResolvedValue({
        id: postId,
        user: {
          id: 'other-user',
        },
      })

      await expect(postService.deletePost(postId, userId, meta)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        statusCode: 403,
      })
    })

    it('deletes post, attempts S3 delete, and busts cache', async () => {
      findById.mockResolvedValue({
        id: postId,
        user: {
          id: userId,
        },
      })
      deletePostRepo.mockResolvedValue({ mediaKey: 'posts/user-1/key.jpg' })
      deleteObject.mockResolvedValue(undefined)

      await postService.deletePost(postId, userId, meta)

      expect(deletePostRepo).toHaveBeenCalledWith(postId)
      expect(deleteObject).toHaveBeenCalledWith('posts/user-1/key.jpg')
      expect(cacheDelete).toHaveBeenCalledWith(`post:${postId}`)
      expect(cacheDelete).toHaveBeenCalledWith(`user:posts:${userId}`)
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'POST_DELETED',
          actionStatus: 'success',
          actionDetails: { postId },
        }),
      )
    })

    it('does not throw when S3 delete fails', async () => {
      findById.mockResolvedValue({
        id: postId,
        user: {
          id: userId,
        },
      })
      deletePostRepo.mockResolvedValue({ mediaKey: 'posts/user-1/key.jpg' })
      deleteObject.mockRejectedValue(new Error('s3 failed'))

      await expect(postService.deletePost(postId, userId, meta)).resolves.toBeUndefined()
    })
  })

  describe('likePost', () => {
    const meta = { request: { ip: '127.0.0.1', headers: {} }, deviceId: 'dev-1' }

    it('throws CANNOT_LIKE_OWN_POST when user tries to like own post', async () => {
      findById.mockResolvedValue({
        id: postId,
        user: { id: userId },
      })

      await expect(postService.likePost(postId, userId, meta)).rejects.toMatchObject({
        code: 'CANNOT_LIKE_OWN_POST',
        statusCode: 400,
      })
    })

    it('likes post via repository and audits', async () => {
      findById.mockResolvedValue({
        id: postId,
        user: { id: 'other-user' },
      })
      likePostRepo.mockResolvedValue({ likesCount: 5, created: true })

      const result = await postService.likePost(postId, userId, meta)

      expect(likePostRepo).toHaveBeenCalledWith(postId, userId)
      expect(cacheDelete).toHaveBeenCalledWith(`post:${postId}`)
      expect(result).toEqual({ likesCount: 5, isLiked: true })
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'POST_LIKED',
          actionStatus: 'success',
        }),
      )
    })
  })

  describe('unlikePost', () => {
    const meta = { request: { ip: '127.0.0.1', headers: {} }, deviceId: 'dev-1' }

    it('unlikes post via repository and audits', async () => {
      unlikePostRepo.mockResolvedValue({ likesCount: 3, deleted: true })

      const result = await postService.unlikePost(postId, userId, meta)

      expect(unlikePostRepo).toHaveBeenCalledWith(postId, userId)
      expect(cacheDelete).toHaveBeenCalledWith(`post:${postId}`)
      expect(result).toEqual({ likesCount: 3, isLiked: false })
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'POST_UNLIKED',
          actionStatus: 'success',
        }),
      )
    })
  })
})

